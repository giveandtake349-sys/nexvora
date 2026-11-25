/**
 * Signaling-client unit tests (Milestone 3) — the browser half of the
 * Milestone 2 signaling API. The fetch implementation is injected, so
 * no browser and no network are involved. Covers: endpoint paths and
 * methods, 403 surfacing (revoked grant), poll-response validation,
 * and the poller (delivery, revocation stop, session-end stop,
 * exponential backoff on transient failure — never a tight loop).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SignalingApiError,
  createSignalPoller,
  createSignalingClient,
  parsePollResponse,
  type FetchLike,
} from "../signaling-client";
import type { SignalingMessage } from "../types";

const SESSION_ID = "00000000-0000-0000-0000-000000000001";

type FakeResponse = { ok: boolean; status: number; body: unknown };

function makeFetch(
  handler: (url: string, init?: RequestInit) => FakeResponse | Promise<FakeResponse>,
): FetchLike {
  return async (url, init) => {
    const r = await handler(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
}

function pollBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    messages: [],
    signaling_state: "connecting",
    peer_last_seen_at: null,
    peer_alive: false,
    grantsValid: true,
    poll_interval_ms: 2000,
    ...overrides,
  };
}

function fakeMessage(overrides: Partial<SignalingMessage> = {}): SignalingMessage {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    session_id: SESSION_ID,
    sender_user_id: "peer-1",
    recipient_user_id: "me-1",
    kind: "offer",
    payload: { type: "offer", sdp: "v=0" },
    seq: 41,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("createSignalingClient — endpoints", () => {
  it("start() POSTs to /start and send() POSTs the kind + payload, returning the seq", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/start")) return { ok: true, status: 200, body: { ok: true } };
      return { ok: true, status: 200, body: { ok: true, seq: 42 } };
    });
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    await client.start();
    const seq = await client.send("offer", { type: "offer", sdp: "v=0" });
    expect(seq).toBe(42);
    expect(calls[0]?.url).toBe(`/api/sessions/${SESSION_ID}/start`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[1]?.url).toBe(`/api/sessions/${SESSION_ID}/signal`);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      kind: "offer",
      payload: { type: "offer", sdp: "v=0" },
    });
  });

  it("poll() GETs with the after seq and returns the parsed result", async () => {
    const fetchImpl = makeFetch((url) => {
      expect(url).toBe(`/api/sessions/${SESSION_ID}/signal?after=40`);
      return { ok: true, status: 200, body: pollBody({ messages: [fakeMessage()] }) };
    });
    const result = await createSignalingClient(SESSION_ID, fetchImpl).poll(40);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.seq).toBe(41);
    expect(result.signaling_state).toBe("connecting");
    expect(result.grantsValid).toBe(true);
    expect(result.poll_interval_ms).toBe(2000);
  });

  it("a 403 from send() or poll() throws SignalingApiError with status 403", async () => {
    const fetchImpl = makeFetch(() => ({
      ok: false,
      status: 403,
      body: { error: "Your access to this device was revoked or expired" },
    }));
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    await expect(client.send("offer", {})).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<SignalingApiError>);
    await expect(client.poll(0)).rejects.toMatchObject({ status: 403 });
    try {
      await client.poll(0);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SignalingApiError);
      expect((err as SignalingApiError).message).toContain("revoked");
    }
  });

  it("heartbeat() returns peer liveness, setState() posts the state, disconnect() ends the session", async () => {
    const calls: string[] = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url} ${String(init?.body ?? "")}`);
      if (url.endsWith("/heartbeat")) return { ok: true, status: 200, body: { ok: true, peer_alive: true } };
      return { ok: true, status: 200, body: { ok: true } };
    });
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    expect(await client.heartbeat()).toBe(true);
    await client.setState("live");
    await client.disconnect();
    expect(calls).toEqual([
      `POST /api/sessions/${SESSION_ID}/heartbeat {}`,
      `POST /api/sessions/${SESSION_ID}/state {"state":"live"}`,
      `POST /api/sessions/disconnect {"sessionId":"${SESSION_ID}"}`,
    ]);
  });
});

describe("parsePollResponse", () => {
  it("accepts a well-formed poll response", () => {
    const parsed = parsePollResponse(pollBody({ messages: [fakeMessage()] }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.messages[0]?.kind).toBe("offer");
  });

  it("defaults the poll interval to 2s when the server omits it", () => {
    const body = pollBody();
    delete (body as Record<string, unknown>).poll_interval_ms;
    const parsed = parsePollResponse(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.result.poll_interval_ms).toBe(2000);
  });

  it("rejects non-objects, error bodies, and malformed messages", () => {
    expect(parsePollResponse(null).ok).toBe(false);
    expect(parsePollResponse("nope").ok).toBe(false);
    expect(parsePollResponse({ ok: false, error: "boom" }).ok).toBe(false);
    expect(parsePollResponse(pollBody({ messages: "not-an-array" })).ok).toBe(false);
    expect(
      parsePollResponse(pollBody({ messages: [{ kind: "offer" }] })).ok,
    ).toBe(false);
    expect(parsePollResponse(pollBody({ peer_alive: "yes" })).ok).toBe(false);
    expect(parsePollResponse(pollBody({ grantsValid: 1 })).ok).toBe(false);
  });
});

describe("createSignalPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers messages in order and keeps polling every 2s", async () => {
    const calls: string[] = [];
    let pollCount = 0;
    const fetchImpl = makeFetch((url) => {
      calls.push(url);
      pollCount += 1;
      const messages = pollCount === 1 ? [fakeMessage({ seq: 41 })] : [];
      return { ok: true, status: 200, body: pollBody({ messages }) };
    });
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    const seen: SignalingMessage[] = [];
    let metas = 0;
    const poller = createSignalPoller(client, {
      onMessages: (messages) => seen.push(...messages),
      onMeta: () => {
        metas += 1;
      },
      onRevoked: () => expect.unreachable(),
      onSessionEnded: () => expect.unreachable(),
      onError: () => expect.unreachable(),
    });
    poller.start();
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.seq).toBe(41);
    // Second poll uses the last seen seq and fires after 2s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("after=41");
    expect(metas).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    poller.stop();
    expect(poller.running).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
  });

  it("stops and reports revocation on a 403, and never polls again", async () => {
    const fetchImpl = makeFetch(() => ({
      ok: false,
      status: 403,
      body: { error: "revoked", grantsValid: false },
    }));
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    let revoked = 0;
    const poller = createSignalPoller(client, {
      onMessages: () => expect.unreachable(),
      onMeta: () => expect.unreachable(),
      onRevoked: () => {
        revoked += 1;
      },
      onSessionEnded: () => expect.unreachable(),
      onError: () => expect.unreachable(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).toBe(1);
    expect(poller.running).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(revoked).toBe(1);
  });

  it("stops and reports session end when the server says ended", async () => {
    const fetchImpl = makeFetch(() => ({
      ok: true,
      status: 200,
      body: pollBody({ signaling_state: "ended" }),
    }));
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    let ended: string | null = null;
    const poller = createSignalPoller(client, {
      onMessages: () => expect.unreachable(),
      onMeta: () => expect.unreachable(),
      onRevoked: () => expect.unreachable(),
      onSessionEnded: (state) => {
        ended = state;
      },
      onError: () => expect.unreachable(),
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe("ended");
    expect(poller.running).toBe(false);
  });

  it("backs off exponentially on transient failures instead of tight-looping", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      throw new Error("network down");
    };
    const client = createSignalingClient(SESSION_ID, fetchImpl);
    let errors = 0;
    const poller = createSignalPoller(client, {
      onMessages: () => expect.unreachable(),
      onMeta: () => expect.unreachable(),
      onRevoked: () => expect.unreachable(),
      onSessionEnded: () => expect.unreachable(),
      onError: () => {
        errors += 1;
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(errors).toBe(1);
    // First backoff is 4s (2s * 2^1): no retry at 2s.
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(errors).toBe(2);
    // Second backoff is 8s: no retry at 4s, retry at 8s.
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toBe(3);
    poller.stop();
  });
});
