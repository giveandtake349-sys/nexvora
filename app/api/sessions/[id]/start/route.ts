import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import {
  callerHasLiveGrant,
  loadSessionForParty,
  revokeSessionForLostGrant,
} from "@/lib/signaling";

/**
 * POST /api/sessions/[id]/start — either party starts the live
 * session: signaling_state created -> connecting. Requires the session
 * to exist, the caller to be a party, status 'active', and — for a
 * participant — at least one live (unrevoked, unexpired) grant on the
 * session device (the owner always qualifies). If the participant's
 * grant is gone, the session is revoked server-side and the call is
 * rejected with 403. Idempotent: starting an already-connecting or
 * already-live session just returns its state.
 *
 * Starting signaling does NOT start media — Milestone 3 owns that.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;

  const limit = checkRateLimit(`session-start:${user.id}`, 10, 60_000);
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
      details: { reason: "grant_revoked_or_expired", at: "session.start" },
    });
    await logSecurityEvent(db, {
      user_id: session.owner_id,
      device_id: session.device_id,
      actor_id: user.id,
      action: "session.revoked",
      details: { session_id: session.id, reason: "grant_revoked_or_expired" },
      ip_address: clientIp(_request),
      user_agent: _request.headers.get("user-agent"),
    });
    return jsonError("Your access to this device was revoked or expired", 403);
  }

  if (session.signaling_state === "connecting" || session.signaling_state === "live") {
    return NextResponse.json({ ok: true, signaling_state: session.signaling_state });
  }
  if (session.signaling_state !== "created") {
    return jsonError(`Session signaling is already ${session.signaling_state}`, 409);
  }

  await db.query(
    `update public.remote_sessions
     set signaling_state = 'connecting'
     where id = $1 and signaling_state = 'created'`,
    [id],
  );

  await logSessionEvent(db, {
    session_id: session.id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.signaling_started",
    details: {},
  });
  await logSecurityEvent(db, {
    user_id: session.owner_id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.signaling_started",
    details: { session_id: session.id },
    ip_address: clientIp(_request),
    user_agent: _request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true, signaling_state: "connecting" });
}
