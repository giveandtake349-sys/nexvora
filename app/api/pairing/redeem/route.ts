import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, readJsonBody } from "@/lib/api";
import {
  hashPairingValue,
  checkPairingUsability,
  PAIRING_ATTEMPT_WINDOW_MS,
  PAIRING_MAX_ATTEMPTS,
} from "@/lib/pairing";
import { checkRateLimit } from "@/lib/rate-limit";
import { isPermissionScope, type PermissionScope } from "@/lib/permissions";
import { logSecurityEvent } from "@/lib/audit";
import type { ConnectionRequest, PairingInvitation } from "@/lib/types";

/**
 * POST /api/pairing/redeem — Device B enters a pairing code.
 * Body: { code, deviceId?, requestedScopes: string[] }
 *
 * Server-side only: looks the invitation up by SHA-256(code), checks
 * expiry + single-use, marks it used FIRST (replay prevention), then
 * creates a PENDING connection request — inside ONE transaction, so
 * the mark-used update and the request insert succeed or fail
 * together. The code alone grants nothing — the device owner must
 * still approve the request.
 * Rate-limited: 5 attempts per user per 10 minutes.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;

  const limit = checkRateLimit(`pairing:redeem:${user.id}`, PAIRING_MAX_ATTEMPTS, PAIRING_ATTEMPT_WINDOW_MS);
  if (!limit.allowed) {
    await logSecurityEvent(db, {
      user_id: user.id,
      actor_id: user.id,
      action: "pairing.rate_limited",
      details: { endpoint: "redeem" },
      ip_address: clientIp(request),
    });
    return jsonError("Too many pairing attempts. Try again in a few minutes.", 429);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) return jsonError("A 6-digit pairing code is required", 400);

  const scopes: PermissionScope[] = Array.isArray(body.requestedScopes)
    ? body.requestedScopes.filter((s: unknown) => isPermissionScope(s))
    : [];
  if (scopes.length === 0) return jsonError("Select at least one permission to request", 400);

  const invitationRes = await db.query<PairingInvitation>(
    `select * from public.pairing_invitations
     where code_hash = $1 and status = 'active' limit 1`,
    [hashPairingValue(code)],
  );
  const invitation = invitationRes.rows[0] ?? null;

  const usability = checkPairingUsability(invitation);
  if (usability !== "usable" || !invitation) {
    await logSecurityEvent(db, {
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
  // code must fail even if two requests arrive at once. The whole
  // mark-used + target lookup + request insert runs in one transaction.
  let connectionRequest: ConnectionRequest;
  try {
    connectionRequest = await db.tx(async (tx) => {
      const marked = await tx.query(
        `update public.pairing_invitations
         set used_at = $1, status = 'used'
         where id = $2 and used_at is null`,
        [new Date().toISOString(), invitation.id],
      );
      if (marked.rowCount !== 1) throw new Error("ALREADY_USED");

      // The target device is the inviter's device (or the inviter's
      // account if no device was attached to the invitation).
      const targetDeviceId: string | null = invitation.inviter_device_id;
      if (!targetDeviceId) throw new Error("NO_TARGET_DEVICE");
      const target = await tx.query<{ id: string; owner_id: string }>(
        `select id, owner_id from public.devices where id = $1 limit 1`,
        [targetDeviceId],
      );
      const targetDevice = target.rows[0] ?? null;
      if (!targetDevice) throw new Error("TARGET_GONE");
      if (targetDevice.owner_id === user.id) throw new Error("OWN_DEVICE");

      const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
      if (deviceId && !isUuid(deviceId)) {
        throw new Error("BAD_DEVICE_ID");
      }
      const inserted = await tx.query<ConnectionRequest>(
        `insert into public.connection_requests
           (requester_user_id, requester_device_id, target_device_id, owner_id, requested_scopes, status)
         values ($1, $2, $3, $4, $5, 'pending')
         returning *`,
        [user.id, deviceId, targetDeviceId, targetDevice.owner_id, scopes],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error("INSERT_FAILED");
      return created;
    });
  } catch (error) {
    const code_ = error instanceof Error ? error.message : "";
    if (code_ === "ALREADY_USED") {
      return jsonError("This pairing code has already been used.", 400);
    }
    if (code_ === "NO_TARGET_DEVICE") {
      return jsonError("This pairing code has no target device.", 400);
    }
    if (code_ === "TARGET_GONE") {
      return jsonError("Target device no longer exists.", 404);
    }
    if (code_ === "OWN_DEVICE") {
      return jsonError("You cannot pair with your own device this way — use My Devices instead.", 400);
    }
    if (code_ === "BAD_DEVICE_ID") {
      return jsonError("deviceId must be a valid device id", 400);
    }
    console.error("[pairing] redeem transaction failed:", error);
    return jsonError("Could not redeem this pairing code.", 500);
  }

  // Re-read the owner/target for the audit row (the tx already validated them).
  const targetDeviceId = invitation.inviter_device_id as string;
  const ownerRes = await db.query<{ owner_id: string }>(
    `select owner_id from public.devices where id = $1 limit 1`,
    [targetDeviceId],
  );
  await logSecurityEvent(db, {
    user_id: ownerRes.rows[0]?.owner_id ?? null,
    device_id: targetDeviceId,
    actor_id: user.id,
    action: "pairing.redeemed",
    details: { connection_request_id: connectionRequest.id, requested_scopes: scopes },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ connectionRequest }, { status: 201 });
}
