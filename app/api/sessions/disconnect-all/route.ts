import { NextResponse, type NextRequest } from "next/server";
import { requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent } from "@/lib/audit";

/** POST /api/sessions/disconnect-all — end every active session I own or take part in. */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const now = new Date().toISOString();

  const ended = await db.query<{ id: string }>(
    `update public.remote_sessions
     set status = 'ended', ended_at = $1
     where status = 'active'
       and (owner_id = $2 or participant_user_id = $2)
     returning id`,
    [now, user.id],
  );

  await logSecurityEvent(db, {
    user_id: user.id,
    actor_id: user.id,
    action: "sessions.disconnect_all",
    details: { ended_count: ended.rows.length },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true, endedCount: ended.rows.length });
}
