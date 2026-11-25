import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { parseUserAgent, computeDeviceFingerprint } from "@/lib/device";
import { logSecurityEvent } from "@/lib/audit";

/** GET /api/devices — list the signed-in user's own devices. */
export async function GET() {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const { data, error } = await supabase
    .from("devices")
    .select("*")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ devices: data ?? [] });
}

/**
 * POST /api/devices — register (or heartbeat) the current device.
 * Body: { name, fingerprint? } — browser/OS are parsed server-side from
 * the User-Agent, never trusted from the client.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return jsonError("Device name is required", 400);

  const ua = parseUserAgent(request.headers.get("user-agent"));
  const fingerprint = computeDeviceFingerprint(
    `${user.id}:${typeof body.fingerprint === "string" && body.fingerprint ? body.fingerprint : request.headers.get("user-agent") ?? "unknown"}`,
  );

  // Re-registering the same fingerprint updates last_seen_at (heartbeat).
  const { data: existing } = await supabase
    .from("devices")
    .select("id")
    .eq("owner_id", user.id)
    .eq("device_fingerprint", fingerprint)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase
      .from("devices")
      .update({ name, last_seen_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("owner_id", user.id)
      .select()
      .single();
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ device: data });
  }

  const { data, error } = await supabase
    .from("devices")
    .insert({
      owner_id: user.id,
      name,
      device_fingerprint: fingerprint,
      platform: ua.platform,
      browser: ua.browser,
      os: ua.os,
      last_seen_at: new Date().toISOString(),
      is_trusted: false,
    })
    .select()
    .single();
  if (error) return jsonError(error.message, 500);
  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: data.id,
    actor_id: user.id,
    action: "device.registered",
    details: { name, platform: ua.platform },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ device: data }, { status: 201 });
}

/**
 * DELETE /api/devices?id=<id> — owner-only removal. Removal revokes the
 * device's grants and ends its active sessions.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Device id is required", 400);

  const { data: device, error: fetchError } = await supabase
    .from("devices")
    .select("id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (fetchError) return jsonError(fetchError.message, 500);
  if (!device) return jsonError("Device not found", 404);

  // Revoke grants + end sessions first, then delete the device row.
  await supabase
    .from("device_permissions")
    .update({ is_revoked: true, revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq("device_id", id)
    .eq("is_revoked", false);
  await supabase
    .from("remote_sessions")
    .update({ status: "ended", ended_at: new Date().toISOString() })
    .eq("device_id", id)
    .eq("status", "active");
  const { error } = await supabase.from("devices").delete().eq("id", id).eq("owner_id", user.id);
  if (error) return jsonError(error.message, 500);

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: id,
    actor_id: user.id,
    action: "device.removed",
    details: {},
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
