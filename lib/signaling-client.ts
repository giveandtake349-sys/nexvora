/**
 * Client-side WebRTC signaling (Milestone 3) — the browser half of the
 * Milestone 2 signaling API. It uses ONLY the Milestone 2 endpoints
 * (start / signal / heartbeat / state / disconnect) — no second
 * signaling path is invented here.
 *
 *   POST /api/sessions/[id]/start       — created -> connecting
 *   POST /api/sessions/[id]/signal       — send offer/answer/ICE/bye
 *   GET  /api/sessions/[id]/signal?after — short-poll for messages
 *   POST /api/sessions/[id]/heartbeat    — prove this side is alive
 *   POST /api/sessions/[id]/state        — explicit state transitions
 *   POST /api/sessions/disconnect        — end the session
 *
 * The poller polls every ~2s (the interval the server returns) and
 * backs off exponentially on consecutive failures (lib/webrtc.ts
 * nextPollDelayMs) — never a tight loop. A 403, or a poll response
 * with grantsValid=false, means the grant is gone: the poller stops
 * and reports revocation so the caller can tear the peer connection
 * down immediately and never keep a stream alive.
 *
 * `fetch` is injectable so the logic is unit-testable without a
 * browser; in the app the global fetch is used.
 */
import { SIGNAL_POLL_INTERVAL_MS } from "./signaling";
import { nextPollDelayMs } from "./webrtc";
import type {
  SignalingMessage,
  SignalingMessageKind,
  SignalingState,
} from "./types";

/** Minimal fetch shape — the real fetch and test doubles both fit. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** An HTTP error from a signaling endpoint, carrying its status so
 *  callers can tell a revoked grant (403) from a transient failure. */
export class SignalingApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SignalingApiError";
    this.status = status;
  }
}

export interface PollResult {
  messages: SignalingMessage[];
  signaling_state: SignalingState;
  peer_last_seen_at: string | null;
  peer_alive: boolean;
  grantsValid: boolean;
  poll_interval_ms: number;
}

function errorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string" && err) return err;
  }
  return fallback;
}

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SignalingApiError(res.status, errorMessage(data, `Request failed (${res.status})`));
  }
  return data;
}

/**
 * Validate a GET .../signal response body. The server is trusted to
 * produce this shape, but a defensive check keeps a malformed payload
 * (proxy error page, stale deploy) from crashing the session loop —
 * it surfaces as a poll error instead, which the poller backs off on.
 */
export function parsePollResponse(
  body: unknown,
): { ok: true; result: PollResult } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Poll response must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (b.ok !== true) {
    return { ok: false, error: errorMessage(b, "Poll request failed") };
  }
  if (!Array.isArray(b.messages)) {
    return { ok: false, error: "Poll response is missing messages" };
  }
  const messages: SignalingMessage[] = [];
  for (const raw of b.messages as unknown[]) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "Poll response contains a malformed message" };
    }
    const m = raw as Record<string, unknown>;
    if (
      typeof m.id !== "string" ||
      typeof m.session_id !== "string" ||
      typeof m.sender_user_id !== "string" ||
      typeof m.recipient_user_id !== "string" ||
      typeof m.kind !== "string" ||
      typeof m.seq !== "number" ||
      typeof m.created_at !== "string" ||
      m.payload === null ||
      typeof m.payload !== "object" ||
      Array.isArray(m.payload)
    ) {
      return { ok: false, error: "Poll response contains a malformed message" };
    }
    messages.push(m as unknown as SignalingMessage);
  }
  if (
    typeof b.signaling_state !== "string" ||
    typeof b.peer_alive !== "boolean" ||
    typeof b.grantsValid !== "boolean"
  ) {
    return { ok: false, error: "Poll response is missing session state" };
  }
  return {
    ok: true,
    result: {
      messages,
      signaling_state: b.signaling_state as SignalingState,
      peer_last_seen_at:
        typeof b.peer_last_seen_at === "string" ? b.peer_last_seen_at : null,
      peer_alive: b.peer_alive as boolean,
      grantsValid: b.grantsValid as boolean,
      poll_interval_ms:
        typeof b.poll_interval_ms === "number" && b.poll_interval_ms > 0
          ? b.poll_interval_ms
          : SIGNAL_POLL_INTERVAL_MS,
    },
  };
}

export interface SignalingClient {
  /** POST .../start — move the session created -> connecting. */
  start(): Promise<void>;
  /** POST .../signal — send one offer / answer / ice-candidate / bye. */
  send(kind: SignalingMessageKind, payload: Record<string, unknown>): Promise<number>;
  /** GET .../signal?after=<seq> — one short-poll. */
  poll(after: number): Promise<PollResult>;
  /** POST .../heartbeat — prove this side is still there. */
  heartbeat(): Promise<PollResult["peer_alive"]>;
  /** POST .../state — explicit transition (connecting/live/ended). */
  setState(state: "connecting" | "live" | "ended"): Promise<void>;
  /** POST /api/sessions/disconnect — end the session for both sides. */
  disconnect(): Promise<void>;
}

export function createSignalingClient(
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): SignalingClient {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  return {
    async start(): Promise<void> {
      await postJson(fetchImpl, `${base}/start`, {});
    },

    async send(kind, payload): Promise<number> {
      const data = await postJson(fetchImpl, `${base}/signal`, { kind, payload });
      const seq = (data as Record<string, unknown>).seq;
      return typeof seq === "number" ? seq : -1;
    },

    async poll(after: number): Promise<PollResult> {
      const res = await fetchImpl(`${base}/signal?after=${after}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The poll route returns grantsValid:false with a 403 when the
        // grant is gone — surface that as an error with its status so
        // the poller can treat it as revocation, not a retryable blip.
        throw new SignalingApiError(
          res.status,
          errorMessage(body, `Poll failed (${res.status})`),
        );
      }
      const parsed = parsePollResponse(body);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.result;
    },

    async heartbeat(): Promise<boolean> {
      const data = await postJson(fetchImpl, `${base}/heartbeat`, {});
      const peerAlive = (data as Record<string, unknown>).peer_alive;
      return peerAlive === true;
    },

    async setState(state): Promise<void> {
      await postJson(fetchImpl, `${base}/state`, { state });
    },

    async disconnect(): Promise<void> {
      await postJson(fetchImpl, "/api/sessions/disconnect", { sessionId });
    },
  };
}

export interface SignalPollerCallbacks {
  /** Messages arrived (oldest first, in seq order). */
  onMessages(messages: SignalingMessage[]): void;
  /** Every successful poll also reports session state + peer liveness. */
  onMeta(result: PollResult): void;
  /** Grant gone (403 or grantsValid=false) — stop polling, tear down. */
  onRevoked(): void;
  /** Server says the session ended/revoked — stop polling, tear down. */
  onSessionEnded(state: SignalingState): void;
  /** Transient poll failure (network, 5xx, malformed) — poller backs off. */
  onError(error: Error): void;
}

export interface SignalPoller {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * The short-poll loop. Polls every ~2s (the server-returned
 * interval), backs off exponentially while failing, and stops itself
 * on revocation or session end — it never loops forever and never
 * fires two polls concurrently.
 */
export function createSignalPoller(
  client: SignalingClient,
  callbacks: SignalPollerCallbacks,
): SignalPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let lastSeq = 0;
  let consecutiveFailures = 0;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await client.poll(lastSeq);
      consecutiveFailures = 0;
      if (result.grantsValid === false) {
        stop();
        callbacks.onRevoked();
        return;
      }
      if (result.signaling_state === "ended" || result.signaling_state === "revoked") {
        stop();
        callbacks.onSessionEnded(result.signaling_state);
        return;
      }
      for (const message of result.messages) {
        if (message.seq > lastSeq) lastSeq = message.seq;
      }
      if (result.messages.length > 0) callbacks.onMessages(result.messages);
      callbacks.onMeta(result);
      schedule(result.poll_interval_ms);
    } catch (error) {
      consecutiveFailures += 1;
      const err = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SignalingApiError && error.status === 403) {
        stop();
        callbacks.onRevoked();
        return;
      }
      callbacks.onError(err);
      schedule(nextPollDelayMs(consecutiveFailures));
    } finally {
      inFlight = false;
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
  }

  function start(): void {
    if (!stopped) return;
    stopped = false;
    consecutiveFailures = 0;
    void tick();
  }

  function stop(): void {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    get running() {
      return !stopped;
    },
  };
}
