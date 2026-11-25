import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { defaultGrantExpiry, isPermissionScope } from "@/lib/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { logSecurityEvent } from "@/lib/audit";

/**
 * GET /api/permissions?role=owner|granted
 * Owner: grants on my devices. Granted: grants given to me.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const role = request.nextUrl.searchParams.get("role") ?? "owner";
  const query = supabase.from("device_permissions").select("*").order("granted_at", { ascending: false });
  const { data, error } =
    role === "granted"
      ? await query.eq("granted_to_user_id", user.id)
      : await query.eq("owner_id", user.id);
  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ permissions: data ?? [] });
}

/**
 * POST /api/permissions — owner grants a scope directly (without a new
 * pairing flow). Body: { deviceId, grantedToUserId, scope, expiresAt? }
 * Used by the Trusted Devices page to add a scope.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const { deviceId, grantedToUserId, scope } = body;
  if (typeof deviceId !== "string" || typeof grantedToUserId !== "string" || !isPermissionScope(scope)) {
    return jsonError("deviceId, grantedToUserId and a valid scope are required", 400);
  }
  const { data: device } = await supabase
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!device) return jsonError("Device not found", 404);

  const expiresAt =
    typeof body.expiresAt === "string" && body.expiresAt
      ? body.expiresAt
      : defaultGrantExpiry().toISOString();
  const { data, error } = await supabase
    .from("device_permissions")
    .insert({
      owner_id: user.id,
      device_id: deviceId,
      granted_to_user_id: grantedToUserId,
      scope,
      expires_at: expiresAt,
      is_revoked: false,
    })
    .select()
    .single();
  if (error) return jsonError(error.message, 500);
  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: deviceId,
    actor_id: user.id,
    action: "permission.granted",
    details: { permission_id: data.id, scope, granted_to: grantedToUserId, expires_at: expiresAt },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ permission: data }, { status: 201 });
}

/**
 * DELETE /api/permissions?id=<permissionId> — owner revokes ONE grant.
 * Revocation is immediate: the grant is marked revoked AND every active
 * session for that device + user is ended in the same request.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Permission id is required", 400);

  const { data: grant, error } = await supabase
    .from("device_permissions")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!grant) return jsonError("Permission not found", 404);
  if (grant.is_revoked) return NextResponse.json({ ok: true, alreadyRevoked: true });

  const now = new Date().toISOString();
  const { error: revokeError } = await supabase
    .from("device_permissions")
    .update({ is_revoked: true, revoked_at: now, revoked_by: user.id })
    .eq("id", id);
  if (revokeError) return jsonError(revokeError.message, 500);

  // End affected sessions — via the service client when available so the
  // update cannot be blocked by RLS on the participant's rows.
  const privileged = createServiceSupabaseClient() ?? supabase;
  await privileged
    .from("remote_sessions")
    .update({ status: "revoked", ended_at: now })
    .eq("device_id", grant.device_id)
    .eq("participant_user_id", grant.granted_to_user_id)
    .eq("status", "active");

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: grant.device_id,
    actor_id: user.id,
    action: "permission.revoked",
    details: { permission_id: id, scope: grant.scope, granted_to: grant.granted_to_user_id },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
