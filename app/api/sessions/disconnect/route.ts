import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import type { RemoteSession } from "@/lib/types";

/**
 * POST /api/sessions/disconnect — either side ends a session.
 * Body: { sessionId }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return jsonError("sessionId is required", 400);

  const sessionRes = await db.query<RemoteSession>(
    `select * from public.remote_sessions where id = $1 limit 1`,
    [sessionId],
  );
  const session = sessionRes.rows[0] ?? null;
  if (!session) return jsonError("Session not found", 404);
  if (session.owner_id !== user.id && session.participant_user_id !== user.id) {
    return jsonError("You are not part of this session", 403);
  }
  if (session.status !== "active") return NextResponse.json({ ok: true, alreadyEnded: true });

  const now = new Date().toISOString();
  await db.query(
    `update public.remote_sessions
     set status = 'ended', signaling_state = 'ended', ended_at = $1
     where id = $2`,
    [now, sessionId],
  );

  await logSessionEvent(db, {
    session_id: sessionId,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.ended",
    details: {},
  });
  await logSecurityEvent(db, {
    user_id: session.owner_id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.disconnected",
    details: { session_id: sessionId },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
