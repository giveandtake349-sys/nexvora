import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, parseRoleQueryParam, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
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
  const parsedRole = parseRoleQueryParam(request.nextUrl.searchParams.get("role"), ["owner", "granted"]);
  if (!parsedRole.ok) return jsonError(parsedRole.error, 400);
  const role = parsedRole.role;

  const limit = checkRateLimit(`permissions:list:${user.id}`, 120, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

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

  const limit = checkRateLimit(`permissions:grant:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const { deviceId, grantedToUserId, scope } = body;
  if (typeof deviceId !== "string" || typeof grantedToUserId !== "string" || !isPermissionScope(scope)) {
    return jsonError("deviceId, grantedToUserId and a valid scope are required", 400);
  }
  if (!isUuid(deviceId)) return invalidIdResponse();
  const device = await db.query<{ id: string }>(
    `select id from public.devices where id = $1 and owner_id = $2 limit 1`,
    [deviceId, user.id],
  );
  if (!device.rows[0]) return jsonError("Device not found", 404);

  // expiresAt comes from the client: a garbage string would make
  // Postgres reject the insert with a 500, so validate it first.
  let expiresAt = defaultGrantExpiry().toISOString();
  if (typeof body.expiresAt === "string" && body.expiresAt) {
    const parsed = new Date(body.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return jsonError("expiresAt must be a valid ISO date string", 400);
    }
    expiresAt = parsed.toISOString();
  }
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
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`permissions:revoke:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

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
       set status = 'revoked', signaling_state = 'revoked', ended_at = $1
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
