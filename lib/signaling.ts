/**
 * WebRTC signaling helpers (Milestone 2).
 *
 * Signaling is DB-backed + short-polled (see db/migrations/
 * 0002_signaling.sql): the server stores each SDP/ICE message in
 * `signaling_messages` and each party polls
 * GET /api/sessions/[id]/signal?after=<seq>. There is no WebSocket
 * server — Vercel Hobby is serverless, and signaling must re-check the
 * live device grant on every send and every delivery, which only the
 * database can answer authoritatively.
 *
 * This module holds the pure, unit-testable rules (kinds, payload size,
 * state transitions, heartbeat staleness, poll guidance) plus the small
 * server helpers the signaling routes share (session loading, party
 * resolution, live-grant checks, grant-loss revocation). It never
 * trusts client input: the recipient of a message is always derived
 * server-side from the session, never taken from the request body.
 */
import type { DbClient } from "./db/client";
import {
  checkGrantValidity,
  isGrantValid,
  type DevicePermissionGrant,
} from "./permissions";
import type { RemoteSession } from "./types";

/* ------------------------------------------------------------------ */
/* Message kinds                                                       */
/* ------------------------------------------------------------------ */

/** SDP offer/answer + ICE candidates, plus control kinds. */
export const SIGNALING_MESSAGE_KINDS = [
  "offer",
  "answer",
  "ice-candidate",
  "bye",
  "session-state",
] as const;

export type SignalingMessageKind = (typeof SIGNALING_MESSAGE_KINDS)[number];

export function isSignalingMessageKind(value: unknown): value is SignalingMessageKind {
  return (
    typeof value === "string" &&
    (SIGNALING_MESSAGE_KINDS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* Payload size                                                        */
/* ------------------------------------------------------------------ */

/** Max JSON payload per signaling message: 64 KiB. SDP blobs and ICE
 *  candidates are a few KiB at most; anything larger is abuse or a bug. */
export const MAX_SIGNALING_PAYLOAD_BYTES = 64 * 1024;

/** UTF-8 byte length of the JSON encoding of a value. */
export function signalingPayloadSizeBytes(payload: unknown): number {
  const json = JSON.stringify(payload ?? null);
  return new TextEncoder().encode(json).length;
}

export function isPayloadWithinLimit(payload: unknown): boolean {
  return signalingPayloadSizeBytes(payload) <= MAX_SIGNALING_PAYLOAD_BYTES;
}

/** Validate a POST /signal body: { kind, payload }. Oversize payloads
 *  are 413 (payload too large); everything else malformed is 400. */
export function validateSignalBody(
  body: unknown,
): { ok: true; kind: SignalingMessageKind; payload: Record<string, unknown> } | { ok: false; error: string; status: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object", status: 400 };
  }
  const { kind, payload } = body as { kind?: unknown; payload?: unknown };
  if (!isSignalingMessageKind(kind)) {
    return {
      ok: false,
      error: `kind must be one of: ${SIGNALING_MESSAGE_KINDS.join(", ")}`,
      status: 400,
    };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "payload must be a JSON object", status: 400 };
  }
  if (!isPayloadWithinLimit(payload)) {
    return {
      ok: false,
      error: `payload exceeds the ${MAX_SIGNALING_PAYLOAD_BYTES / 1024} KiB limit`,
      status: 413,
    };
  }
  return { ok: true, kind, payload: payload as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* Signaling state machine                                             */
/* ------------------------------------------------------------------ */

export const SIGNALING_STATES = ["created", "connecting", "live", "ended", "revoked"] as const;

export type SignalingState = (typeof SIGNALING_STATES)[number];

export function isSignalingState(value: unknown): value is SignalingState {
  return (
    typeof value === "string" &&
    (SIGNALING_STATES as readonly string[]).includes(value)
  );
}

/**
 * Allowed transitions. `revoked` is terminal and server-driven only
 * (grant loss / owner revoke) — clients can never set it via the state
 * route. `ended` is terminal. A session that never started signaling
 * sits in `created` until POST /start moves it to `connecting`.
 */
export const ALLOWED_SIGNALING_TRANSITIONS: Record<SignalingState, readonly SignalingState[]> = {
  created: ["connecting", "ended", "revoked"],
  connecting: ["live", "ended", "revoked"],
  live: ["ended", "revoked"],
  ended: [],
  revoked: [],
};

export function canTransitionSignalingState(
  from: SignalingState,
  to: SignalingState,
): boolean {
  return (ALLOWED_SIGNALING_TRANSITIONS[from] ?? []).includes(to);
}

/* ------------------------------------------------------------------ */
/* Heartbeats                                                          */
/* ------------------------------------------------------------------ */

/** A peer is considered alive if it heartbeated within the last 30s.
 *  Clients should heartbeat every ~10s (3x margin for one missed beat
 *  plus serverless cold-start jitter). */
export const HEARTBEAT_STALE_AFTER_MS = 30 * 1000;
export const HEARTBEAT_INTERVAL_MS = 10 * 1000;

export function isHeartbeatStale(
  lastSeenAt: string | null,
  now: Date = new Date(),
): boolean {
  if (!lastSeenAt) return true;
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return true;
  return now.getTime() - seen > HEARTBEAT_STALE_AFTER_MS;
}

/* ------------------------------------------------------------------ */
/* Polling guidance                                                    */
/* ------------------------------------------------------------------ */

/** Short-poll interval for GET .../signal: 2s. At ~30 polls/min per
 *  party this stays well inside the route's rate limit (120/min) while
 *  keeping the SDP/ICE handshake feeling near-instant. No long-polling:
 *  holding a serverless function open would burn the Hobby execution
 *  budget for no benefit at this message rate. */
export const SIGNAL_POLL_INTERVAL_MS = 2000;
/** Max messages returned per poll — a client that fell behind re-polls
 *  with the last seq it saw until it catches up. */
export const SIGNAL_POLL_MAX_MESSAGES = 100;

/** Parse the `after` query param of the poll route. */
export function parseSignalAfter(
  value: string | null,
): { ok: true; after: number } | { ok: false; error: string } {
  if (value === null || value === "") return { ok: true, after: 0 };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { ok: false, error: "after must be a non-negative integer sequence number" };
  }
  return { ok: true, after: parsed };
}

/* ------------------------------------------------------------------ */
/* Server helpers shared by the signaling routes                       */
/* ------------------------------------------------------------------ */

/** The heartbeat column belonging to one party of a session. Heartbeats
 *  are stored per party (owner_last_heartbeat_at /
 *  participant_last_heartbeat_at) — a single shared column could not
 *  tell the parties apart, so "is my peer alive?" would be
 *  unanswerable. */
export function heartbeatColumnFor(
  session: RemoteSession,
  userId: string,
): "owner_last_heartbeat_at" | "participant_last_heartbeat_at" | null {
  if (userId === session.owner_id) return "owner_last_heartbeat_at";
  if (userId === session.participant_user_id) return "participant_last_heartbeat_at";
  return null;
}

/** The other party of a session — the recipient of any message the
 *  caller sends. Derived server-side, never from the request body. */
export function otherPartyId(session: RemoteSession, userId: string): string | null {
  if (userId === session.owner_id) return session.participant_user_id;
  if (userId === session.participant_user_id) return session.owner_id;
  return null;
}

/** The peer's last heartbeat + whether the peer is currently alive. */
export function peerHeartbeat(
  session: RemoteSession,
  userId: string,
  now: Date = new Date(),
): { peer_last_seen_at: string | null; peer_alive: boolean } {
  const column = heartbeatColumnFor(session, userId);
  if (!column) return { peer_last_seen_at: null, peer_alive: false };
  const peerColumn =
    column === "owner_last_heartbeat_at"
      ? "participant_last_heartbeat_at"
      : "owner_last_heartbeat_at";
  const peerLastSeen = session[peerColumn];
  return {
    peer_last_seen_at: peerLastSeen,
    peer_alive: !isHeartbeatStale(peerLastSeen, now),
  };
}

export type SessionAccess =
  | { session: RemoteSession }
  | { error: "not_found" | "not_active" };

/**
 * Load a session the caller is a party of. Under RLS a session the
 * caller is not party to is invisible, so "not found" also covers
 * "not yours" (fail-closed, no existence leak). `not_active` covers a
 * session whose status is already ended/revoked.
 */
export async function loadSessionForParty(
  db: DbClient,
  sessionId: string,
  userId: string,
): Promise<SessionAccess> {
  const res = await db.query<RemoteSession>(
    `select * from public.remote_sessions
     where id = $1 and (owner_id = $2 or participant_user_id = $2) limit 1`,
    [sessionId, userId],
  );
  const session = res.rows[0] ?? null;
  if (!session) return { error: "not_found" };
  if (session.status !== "active") return { error: "not_active" };
  return { session };
}

/**
 * Does the caller still hold at least one live (unrevoked, unexpired)
 * grant on the session's device? The owner always qualifies — they own
 * the device. A participant qualifies only while a grant is live; the
 * moment the last grant is revoked or expires, signaling must stop.
 * Uses the same pure checker as every other route (checkGrantValidity).
 */
export async function callerHasLiveGrant(
  db: DbClient,
  session: RemoteSession,
  userId: string,
): Promise<boolean> {
  if (userId === session.owner_id) return true;
  const grants = await db.query<DevicePermissionGrant>(
    `select device_id, scope, is_revoked, revoked_at, expires_at
     from public.device_permissions
     where device_id = $1 and granted_to_user_id = $2 and is_revoked = false`,
    [session.device_id, userId],
  );
  return grants.rows.some((grant) => isGrantValid(grant, session.device_id));
}

/** Re-export for route code that needs the validity reason (logging). */
export { checkGrantValidity };

/**
 * End a session because its participant lost their grant: status and
 * signaling_state are set together (they must never disagree) and the
 * session is timestamped as ended. Callers audit-log the revocation
 * themselves (they hold the request context for IP / user-agent).
 */
export async function revokeSessionForLostGrant(
  db: DbClient,
  session: RemoteSession,
): Promise<void> {
  const now = new Date().toISOString();
  await db.query(
    `update public.remote_sessions
     set status = 'revoked', signaling_state = 'revoked', ended_at = $1
     where id = $2 and status = 'active'`,
    [now, session.id],
  );
}