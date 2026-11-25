import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { generatePairingCode, PAIRING_ATTEMPT_WINDOW_MS, PAIRING_MAX_ATTEMPTS } from "@/lib/pairing";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/audit";

/**
 * POST /api/pairing/generate — Device A creates a temporary pairing code.
 * Body: { deviceId? } — the device being shared (must belong to the caller).
 * Returns the 6-digit code ONCE. Only SHA-256 hashes are stored.
 * Rate-limited: 5 generations per user per 10 minutes.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;

  const limit = checkRateLimit(`pairing:generate:${user.id}`, PAIRING_MAX_ATTEMPTS, PAIRING_ATTEMPT_WINDOW_MS);
  if (!limit.allowed) {
    await logSecurityEvent(supabase, {
      user_id: user.id,
      actor_id: user.id,
      action: "pairing.rate_limited",
      details: { endpoint: "generate" },
      ip_address: clientIp(request),
    });
    return jsonError("Too many pairing codes. Try again in a few minutes.", 429);
  }

  const body = await request.json().catch(() => ({}));
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;

  if (deviceId) {
    const { data: device } = await supabase
      .from("devices")
      .select("id")
      .eq("id", deviceId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (!device) return jsonError("Device not found", 404);
  }

  const { code, codeHash, secretHash, expiresAt } = generatePairingCode();
  const { data, error } = await supabase
    .from("pairing_invitations")
    .insert({
      inviter_user_id: user.id,
      inviter_device_id: deviceId,
      code_hash: codeHash,
      secret_hash: secretHash,
      display_code_hint: code.slice(-2),
      expires_at: expiresAt.toISOString(),
      status: "active",
    })
    .select("id")
    .single();
  if (error) return jsonError(error.message, 500);

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: deviceId,
    actor_id: user.id,
    action: "pairing.code_generated",
    details: { invitation_id: data.id, expires_at: expiresAt.toISOString() },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json(
    { invitationId: data.id, code, expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}
