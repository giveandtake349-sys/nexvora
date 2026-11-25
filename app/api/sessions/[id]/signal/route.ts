import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody, MAX_SIGNAL_RAW_BODY_BYTES } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import {
  SIGNAL_POLL_INTERVAL_MS,
  SIGNAL_POLL_MAX_MESSAGES,
  callerHasLiveGrant,
  loadSessionForParty,
  otherPartyId,
  parseSignalAfter,
  peerHeartbeat,
  revokeSessionForLostGrant,
  validateSignalBody,
} from "@/lib/signaling";
import type { RemoteSession, SignalingMessage } from "@/lib/types";

/**
 * POST /api/sessions/[id]/signal — send one signaling message
 * (offer / answer / ice-candidate / bye / session-state).
 * Body: { kind, payload } — payload is capped at 64 KiB.
 *
 * The recipient is derived server-side (the other session party) and
 * is never taken from the client. Before accepting, the route
 * re-checks that the session is active/live AND that the sender still
 * holds a live grant on the device (owner exempt); if the grant is
 * gone the session is revoked server-side and the send is rejected
 * with 403. The grant check + insert run in one transaction so a
 * revocation landing mid-request cannot slip a message through.
 *
 * Audit: one session_events row per send (kind + seq only — the SDP
 * payload itself is never copied into the audit log).
 */
type SignalSendResult =
  | { kind: "not_found" }
  | { kind: "not_active" }
  | { kind: "signaling_ended" }
  | { kind: "grant_lost"; session: RemoteSession }
  | { kind: "ok"; seq: number; created_at: string; session: RemoteSession };
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`session-signal:${user.id}:${id}`, 120, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request, MAX_SIGNAL_RAW_BODY_BYTES);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const validated = validateSignalBody(body);
  if (!validated.ok) return jsonError(validated.error, validated.status);

  const result: SignalSendResult = await db.tx(async (tx): Promise<SignalSendResult> => {
    const access = await loadSessionForParty(tx, id, user.id);
    if ("error" in access) return { kind: access.error };
    const session = access.session;
    if (
      session.signaling_state !== "created" &&
      session.signaling_state !== "connecting" &&
      session.signaling_state !== "live"
    ) {
      return { kind: "signaling_ended" };
    }
    if (!(await callerHasLiveGrant(tx, session, user.id))) {
      await revokeSessionForLostGrant(tx, session);
      return { kind: "grant_lost", session };
    }
    const recipient = otherPartyId(session, user.id);
    if (!recipient) return { kind: "not_found" };
    const inserted = await tx.query<{ seq: number; created_at: string }>(
      `insert into public.signaling_messages
         (session_id, sender_user_id, recipient_user_id, kind, payload)
       values ($1, $2, $3, $4, $5::jsonb)
       returning seq, created_at`,
      [id, user.id, recipient, validated.kind, JSON.stringify(validated.payload)],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("SIGNAL_INSERT_FAILED");
    return { kind: "ok", seq: row.seq, created_at: row.created_at, session };
  });

  if (result.kind === "not_found") return jsonError("Session not found", 404);
  if (result.kind === "not_active") return jsonError("Session is no longer active", 409);
  if (result.kind === "signaling_ended") {
    return jsonError("Session signaling has ended", 409);
  }
  if (result.kind === "grant_lost") {
    await logSessionEvent(db, {
      session_id: result.session.id,
      device_id: result.session.device_id,
      actor_id: user.id,
      action: "session.revoked",
      details: { reason: "grant_revoked_or_expired", at: "session.signal" },
    });
    await logSecurityEvent(db, {
      user_id: result.session.owner_id,
      device_id: result.session.device_id,
      actor_id: user.id,
      action: "session.revoked",
      details: { session_id: result.session.id, reason: "grant_revoked_or_expired" },
      ip_address: clientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
    return jsonError("Your access to this device was revoked or expired", 403);
  }

  await logSessionEvent(db, {
    session_id: result.session.id,
    device_id: result.session.device_id,
    actor_id: user.id,
    action: "session.signal_sent",
    details: { kind: validated.kind, seq: result.seq },
  });
  return NextResponse.json({ ok: true, seq: result.seq, created_at: result.created_at });
}

/**
 * GET /api/sessions/[id]/signal?after=<seq> — short-poll for messages
 * addressed to the caller with seq > after, oldest first (max 100).
 * Also returns the current signaling_state, the peer's heartbeat
 * freshness, and whether the caller's grant is still valid.
 *
 * Grant validity is re-checked on delivery too: a party whose grant
 * is gone gets 403 and no messages — never a stale handshake for a
 * revoked user. Poll every ~2s (SIGNAL_POLL_INTERVAL_MS); re-poll
 * with the last seq received until caught up.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`session-poll:${user.id}:${id}`, 120, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const after = parseSignalAfter(request.nextUrl.searchParams.get("after"));
  if (!after.ok) return jsonError(after.error, 400);

  const access = await loadSessionForParty(db, id, user.id);
  if ("error" in access) {
    return access.error === "not_found"
      ? jsonError("Session not found", 404)
      : jsonError("Session is no longer active", 409);
  }
  const session = access.session;

  if (!(await callerHasLiveGrant(db, session, user.id))) {
    await revokeSessionForLostGrant(db, session);
    await logSessionEvent(db, {
      session_id: session.id,
      device_id: session.device_id,
      actor_id: user.id,
      action: "session.revoked",
      details: { reason: "grant_revoked_or_expired", at: "session.signal_poll" },
    });
    await logSecurityEvent(db, {
      user_id: session.owner_id,
      device_id: session.device_id,
      actor_id: user.id,
      action: "session.revoked",
      details: { session_id: session.id, reason: "grant_revoked_or_expired" },
      ip_address: clientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
    return NextResponse.json(
      { error: "Your access to this device was revoked or expired", grantsValid: false },
      { status: 403 },
    );
  }

  const messages = await db.query<SignalingMessage>(
    `select id, session_id, sender_user_id, recipient_user_id, kind, payload, seq, created_at
     from public.signaling_messages
     where session_id = $1 and recipient_user_id = $2 and seq > $3
     order by seq asc
     limit $4`,
    [id, user.id, after.after, SIGNAL_POLL_MAX_MESSAGES],
  );
  const peer = peerHeartbeat(session, user.id);
  return NextResponse.json({
    ok: true,
    messages: messages.rows,
    signaling_state: session.signaling_state,
    peer_last_seen_at: peer.peer_last_seen_at,
    peer_alive: peer.peer_alive,
    grantsValid: true,
    poll_interval_ms: SIGNAL_POLL_INTERVAL_MS,
  });
}
