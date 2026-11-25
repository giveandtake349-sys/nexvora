import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { defaultGrantExpiry, isPermissionScope } from "@/lib/permissions";
import { logSecurityEvent } from "@/lib/audit";
import type { DevicePermission } from "@/lib/types";

/**
 * GET /api/permissions?role=owner|granted
 * Owner: grants on my devices. Granted: grants given to me.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const role = request.nextUrl.searchParams.get("role") ?? "owner";
  const column = role === "granted" ? "granted_to_user_id" : "owner_id";
  const { rows } = await db.query<DevicePermission>(
    `select * from public.device_permissions
     where ${column} = $1 order by granted_at desc`,
    [user.id],
  );
  return NextResponse.json({ permissions: rows });
}

/**
 * POST /api/permissions — owner grants a scope directly (without a new
 * pairing flow). Body: { deviceId, grantedToUserId, scope, expiresAt? }
 * Used by the Trusted Devices page to add a scope. Re-granting a scope
 * that already has a live grant refreshes its expiry.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const body = await request.json().catch(() => ({}));
  const { deviceId, grantedToUserId, scope } = body;
  if (typeof deviceId !== "string" || typeof grantedToUserId !== "string" || !isPermissionScope(scope)) {
    return jsonError("deviceId, grantedToUserId and a valid scope are required", 400);
  }
  const device = await db.query<{ id: string }>(
    `select id from public.devices where id = $1 and owner_id = $2 limit 1`,
    [deviceId, user.id],
  );
  if (!device.rows[0]) return jsonError("Device not found", 404);

  const expiresAt =
    typeof body.expiresAt === "string" && body.expiresAt
      ? body.expiresAt
      : defaultGrantExpiry().toISOString();
  const { rows } = await db.query<DevicePermission>(
    `insert into public.device_permissions
       (owner_id, device_id, granted_to_user_id, scope, expires_at, is_revoked)
     values ($1, $2, $3, $4, $5, false)
     on conflict (device_id, granted_to_user_id, scope)
       where is_revoked = false
     do update set expires_at = excluded.expires_at,
                   granted_at = now()
     returning *`,
    [user.id, deviceId, grantedToUserId, scope, expiresAt],
  );
  const permission = rows[0];
  await logSecurityEvent(db, {
    user_id: user.id,
    device_id: deviceId,
    actor_id: user.id,
    action: "permission.granted",
    details: { permission_id: permission.id, scope, granted_to: grantedToUserId, expires_at: expiresAt },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ permission }, { status: 201 });
}

/**
 * DELETE /api/permissions?id=<permissionId> — owner revokes ONE grant.
 * Revocation is immediate: the grant is marked revoked AND every active
 * session for that device + user is ended, in one transaction.
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Permission id is required", 400);

  const grantRes = await db.query<DevicePermission>(
    `select * from public.device_permissions where id = $1 and owner_id = $2 limit 1`,
    [id, user.id],
  );
  const grant = grantRes.rows[0] ?? null;
  if (!grant) return jsonError("Permission not found", 404);
  if (grant.is_revoked) return NextResponse.json({ ok: true, alreadyRevoked: true });

  const now = new Date().toISOString();
  await db.tx(async (tx) => {
    await tx.query(
      `update public.device_permissions
       set is_revoked = true, revoked_at = $1, revoked_by = $2
       where id = $3`,
      [now, user.id, id],
    );
    // The caller is the device owner, so the RLS policy on
    // remote_sessions (owner or participant) permits this update —
    // no privileged client needed.
    await tx.query(
      `update public.remote_sessions
       set status = 'revoked', ended_at = $1
       where device_id = $2 and participant_user_id = $3 and status = 'active'`,
      [now, grant.device_id, grant.granted_to_user_id],
    );
  });

  await logSecurityEvent(db, {
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
