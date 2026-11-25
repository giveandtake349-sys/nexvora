import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent } from "@/lib/audit";

/** POST /api/sessions/disconnect-all — end every active session I own or take part in. */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const now = new Date().toISOString();

  const { data: ended, error } = await supabase
    .from("remote_sessions")
    .update({ status: "ended", ended_at: now })
    .eq("status", "active")
    .or(`owner_id.eq.${user.id},participant_user_id.eq.${user.id}`)
    .select("id");
  if (error) return jsonError(error.message, 500);

  await logSecurityEvent(supabase, {
    user_id: user.id,
    actor_id: user.id,
    action: "sessions.disconnect_all",
    details: { ended_count: ended?.length ?? 0 },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true, endedCount: ended?.length ?? 0 });
}
