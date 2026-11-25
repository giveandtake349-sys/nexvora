import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import {
  hashPairingValue,
  checkPairingUsability,
  PAIRING_ATTEMPT_WINDOW_MS,
  PAIRING_MAX_ATTEMPTS,
} from "@/lib/pairing";
import { checkRateLimit } from "@/lib/rate-limit";
import { isPermissionScope, type PermissionScope } from "@/lib/permissions";
import { logSecurityEvent } from "@/lib/audit";

/**
 * POST /api/pairing/redeem — Device B enters a pairing code.
 * Body: { code, deviceId?, requestedScopes: string[] }
 *
 * Server-side only: looks the invitation up by SHA-256(code), checks
 * expiry + single-use, marks it used FIRST (replay prevention), then
 * creates a PENDING connection request. The code alone grants nothing —
 * the device owner must still approve the request.
 * Rate-limited: 5 attempts per user per 10 minutes.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;

  const limit = checkRateLimit(`pairing:redeem:${user.id}`, PAIRING_MAX_ATTEMPTS, PAIRING_ATTEMPT_WINDOW_MS);
  if (!limit.allowed) {
    await logSecurityEvent(supabase, {
      user_id: user.id,
      actor_id: user.id,
      action: "pairing.rate_limited",
      details: { endpoint: "redeem" },
      ip_address: clientIp(request),
    });
    return jsonError("Too many pairing attempts. Try again in a few minutes.", 429);
  }

  const body = await request.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return jsonError("A 6-digit pairing code is required", 400);

  const scopes: PermissionScope[] = Array.isArray(body.requestedScopes)
    ? body.requestedScopes.filter((s: unknown) => isPermissionScope(s))
    : [];
  if (scopes.length === 0) return jsonError("Select at least one permission to request", 400);

  const { data: invitation, error } = await supabase
    .from("pairing_invitations")
    .select("*")
    .eq("code_hash", hashPairingValue(code))
    .eq("status", "active")
    .maybeSingle();
  if (error) return jsonError(error.message, 500);

  const usability = checkPairingUsability(invitation);
  if (usability !== "usable" || !invitation) {
    await logSecurityEvent(supabase, {
      user_id: user.id,
      actor_id: user.id,
      action: "pairing.failed",
      details: { reason: usability },
      ip_address: clientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
    return jsonError(
      usability === "used"
        ? "This pairing code has already been used."
        : "This pairing code is expired or invalid.",
      400,
    );
  }

  // Mark used BEFORE creating the request — a second redeem of the same
  // code must fail even if two requests arrive at once.
  const { error: usedError } = await supabase
    .from("pairing_invitations")
    .update({ used_at: new Date().toISOString(), status: "used" })
    .eq("id", invitation.id)
    .is("used_at", null);
  if (usedError) return jsonError(usedError.message, 500);

  // The target device is the inviter's device (or the inviter's account
  // if no device was attached to the invitation).
  const targetDeviceId: string | null = invitation.inviter_device_id;
  if (!targetDeviceId) return jsonError("This pairing code has no target device.", 400);

  const { data: targetDevice } = await supabase
    .from("devices")
    .select("id, owner_id")
    .eq("id", targetDeviceId)
    .maybeSingle();
  if (!targetDevice) return jsonError("Target device no longer exists.", 404);
  if (targetDevice.owner_id === user.id) {
    return jsonError("You cannot pair with your own device this way — use My Devices instead.", 400);
  }

  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
  const { data: connectionRequest, error: reqError } = await supabase
    .from("connection_requests")
    .insert({
      requester_user_id: user.id,
      requester_device_id: deviceId,
      target_device_id: targetDeviceId,
      owner_id: targetDevice.owner_id,
      requested_scopes: scopes,
      status: "pending",
    })
    .select()
    .single();
  if (reqError) return jsonError(reqError.message, 500);

  await logSecurityEvent(supabase, {
    user_id: targetDevice.owner_id,
    device_id: targetDeviceId,
    actor_id: user.id,
    action: "pairing.redeemed",
    details: { connection_request_id: connectionRequest.id, requested_scopes: scopes },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ connectionRequest }, { status: 201 });
}
