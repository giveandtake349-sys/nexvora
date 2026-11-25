import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";

/**
 * POST /api/sessions/disconnect — either side ends a session.
 * Body: { sessionId }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return jsonError("sessionId is required", 400);

  const { data: session, error } = await supabase
    .from("remote_sessions")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!session) return jsonError("Session not found", 404);
  if (session.owner_id !== user.id && session.participant_user_id !== user.id) {
    return jsonError("You are not part of this session", 403);
  }
  if (session.status !== "active") return NextResponse.json({ ok: true, alreadyEnded: true });

  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("remote_sessions")
    .update({ status: "ended", ended_at: now })
    .eq("id", sessionId);
  if (updateError) return jsonError(updateError.message, 500);

  await logSessionEvent(supabase, {
    session_id: sessionId,
    device_id: session.device_id,
    actor_id: user.id,
    action: "session.ended",
    details: {},
  });
  await logSecurityEvent(supabase, {
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
