import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody } from "@/lib/api";
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
  const { db, user } = auth.ctx;

  const limit = checkRateLimit(`pairing:generate:${user.id}`, PAIRING_MAX_ATTEMPTS, PAIRING_ATTEMPT_WINDOW_MS);
  if (!limit.allowed) {
    await logSecurityEvent(db, {
      user_id: user.id,
      actor_id: user.id,
      action: "pairing.rate_limited",
      details: { endpoint: "generate" },
      ip_address: clientIp(request),
    });
    return jsonError("Too many pairing codes. Try again in a few minutes.", 429);
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : null;

  if (deviceId) {
    if (!isUuid(deviceId)) return invalidIdResponse();
    const device = await db.query<{ id: string }>(
      `select id from public.devices where id = $1 and owner_id = $2 limit 1`,
      [deviceId, user.id],
    );
    if (!device.rows[0]) return jsonError("Device not found", 404);
  }

  const { code, codeHash, secretHash, expiresAt } = generatePairingCode();
  const { rows } = await db.query<{ id: string }>(
    `insert into public.pairing_invitations
       (inviter_user_id, inviter_device_id, code_hash, secret_hash, display_code_hint, expires_at, status)
     values ($1, $2, $3, $4, $5, $6, 'active')
     returning id`,
    [user.id, deviceId, codeHash, secretHash, code.slice(-2), expiresAt.toISOString()],
  );
  const invitation = rows[0];

  await logSecurityEvent(db, {
    user_id: user.id,
    device_id: deviceId,
    actor_id: user.id,
    action: "pairing.code_generated",
    details: { invitation_id: invitation.id, expires_at: expiresAt.toISOString() },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json(
    { invitationId: invitation.id, code, expiresAt: expiresAt.toISOString() },
    { status: 201 },
  );
}
