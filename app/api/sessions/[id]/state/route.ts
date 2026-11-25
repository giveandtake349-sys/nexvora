import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import {
  canTransitionSignalingState,
  isSignalingState,
  loadSessionForParty,
  type SignalingState,
} from "@/lib/signaling";

/**
 * POST /api/sessions/[id]/state — explicit signaling-state transition.
 * Body: { state: "connecting" | "live" | "ended" }.
 *
 * The allowed-transition map (lib/signaling.ts) is enforced
 * server-side: created -> connecting -> live -> ended, with `ended`
 * and `revoked` terminal. `revoked` is server-driven only (grant loss
 * / owner revoke) and can never be set from here; `created` is the
 * initial state and can never be returned to.
 *
 * Ending via this route also sets remote_sessions.status='ended' +
 * ended_at — status and signaling_state are kept in sync, never left
 * disagreeing.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;

  const limit = checkRateLimit(`session-state:${user.id}:${id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const body = await request.json().catch(() => ({}));
  const target: unknown = body.state;
  if (
    !isSignalingState(target) ||
    (target !== "connecting" && target !== "live" && target !== "ended")
  ) {
    return jsonError('state must be one of: "connecting", "live", "ended"', 400);
  }
  const to: SignalingState = target;

  const access = await loadSessionForParty(db, id, user.id);
  if ("error" in access) {
    return access.error === "not_found"
      ? jsonError("Session not found", 404)
      : jsonError("Session is no longer active", 409);
  }
  const session = access.session;
  const from = session.signaling_state;

  if (from === to) return NextResponse.json({ ok: true, signaling_state: to });
  if (!canTransitionSignalingState(from, to)) {
    return jsonError(`Cannot move signaling state from "${from}" to "${to}"`, 409);
  }

  const now = new Date().toISOString();
  if (to === "ended") {
    await db.query(
      `update public.remote_sessions
       set signaling_state = 'ended', status = 'ended', ended_at = $1
       where id = $2`,
      [now, id],
    );
  } else {
    await db.query(
      `update public.remote_sessions set signaling_state = $1 where id = $2`,
      [to, id],
    );
  }

  await logSessionEvent(db, {
    session_id: session.id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.state_changed",
    details: { from, to },
  });
  await logSecurityEvent(db, {
    user_id: session.owner_id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.state_changed",
    details: { session_id: session.id, from, to },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true, signaling_state: to });
}
