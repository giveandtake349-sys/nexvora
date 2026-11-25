import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent } from "@/lib/audit";

/**
 * POST /api/permissions/revoke-device — owner revokes a WHOLE device:
 * every grant on it is revoked and every active session on it ends,
 * in one transaction. Body: { deviceId }
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  if (!deviceId) return jsonError("deviceId is required", 400);

  const device = await db.query<{ id: string }>(
    `select id from public.devices where id = $1 and owner_id = $2 limit 1`,
    [deviceId, user.id],
  );
  if (!device.rows[0]) return jsonError("Device not found", 404);

  const now = new Date().toISOString();
  await db.tx(async (tx) => {
    await tx.query(
      `update public.device_permissions
       set is_revoked = true, revoked_at = $1, revoked_by = $2
       where device_id = $3 and is_revoked = false`,
      [now, user.id, deviceId],
    );
    await tx.query(
      `update public.remote_sessions
       set status = 'revoked', signaling_state = 'revoked', ended_at = $1
       where device_id = $2 and status = 'active'`,
      [now, deviceId],
    );
  });

  await logSecurityEvent(db, {
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
