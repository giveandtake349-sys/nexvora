import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import {
  callerHasLiveGrant,
  heartbeatColumnFor,
  loadSessionForParty,
  peerHeartbeat,
  revokeSessionForLostGrant,
} from "@/lib/signaling";

/**
 * POST /api/sessions/[id]/heartbeat — the caller proves it is still
 * there. Updates ONLY the caller's own heartbeat column
 * (owner_last_heartbeat_at or participant_last_heartbeat_at): a single
 * shared column could not tell the parties apart, so the peer's
 * liveness would be unknowable. Also refreshes the device's
 * last_seen_at — under RLS that update only succeeds for the device
 * owner; for a participant it is a silent no-op (no error), which is
 * the correct fail-closed behaviour.
 *
 * Clients should heartbeat every ~10s; a peer is "alive" if it
 * heartbeated within the last 30s (see lib/signaling.ts). A heartbeat
 * from a participant whose grant is gone revokes the session (403).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`session-heartbeat:${user.id}:${id}`, 60, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

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
      details: { reason: "grant_revoked_or_expired", at: "session.heartbeat" },
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
    return jsonError("Your access to this device was revoked or expired", 403);
  }

  const column = heartbeatColumnFor(session, user.id);
  if (!column) return jsonError("You are not part of this session", 403);
  const now = new Date().toISOString();
  await db.tx(async (tx) => {
    await tx.query(
      `update public.remote_sessions set ${column} = $1 where id = $2`,
      [now, id],
    );
    // Best-effort: RLS lets only the device owner update the device
    // row, so a participant's heartbeat leaves last_seen_at untouched.
    await tx.query(
      `update public.devices set last_seen_at = $1 where id = $2`,
      [now, session.device_id],
    );
  });

  const peer = peerHeartbeat(session, user.id);
  return NextResponse.json({
    ok: true,
    signaling_state: session.signaling_state,
    peer_last_seen_at: peer.peer_last_seen_at,
    peer_alive: peer.peer_alive,
  });
}
