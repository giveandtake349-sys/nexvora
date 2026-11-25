import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { logSecurityEvent } from "@/lib/audit";

/**
 * POST /api/permissions/revoke-device — owner revokes a WHOLE device:
 * every grant on it is revoked and every active session on it ends.
 * Body: { deviceId }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!deviceId) return jsonError("deviceId is required", 400);

  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!device) return jsonError("Device not found", 404);

  const now = new Date().toISOString();
  await supabase
    .from("device_permissions")
    .update({ is_revoked: true, revoked_at: now, revoked_by: user.id })
    .eq("device_id", deviceId)
    .eq("is_revoked", false);

  const privileged = createServiceSupabaseClient() ?? supabase;
  await privileged
    .from("remote_sessions")
    .update({ status: "revoked", ended_at: now })
    .eq("device_id", deviceId)
    .eq("status", "active");

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: deviceId,
    actor_id: user.id,
    action: "device.revoked",
    details: { device_id: deviceId },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
