import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { parseUserAgent, computeDeviceFingerprint } from "@/lib/device";
import { logSecurityEvent } from "@/lib/audit";
import type { Device } from "@/lib/types";

/** GET /api/devices — list the signed-in user's own devices. */
export async function GET() {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;

  const limit = checkRateLimit(`devices:list:${user.id}`, 120, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const { rows } = await db.query<Device>(
    `select * from public.devices where owner_id = $1 order by created_at desc`,
    [user.id],
  );
  return NextResponse.json({ devices: rows });
}

/**
 * POST /api/devices — register (or heartbeat) the current device.
 * Body: { name, fingerprint? } — browser/OS are parsed server-side from
 * the User-Agent, never trusted from the client.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;

  const limit = checkRateLimit(`devices:register:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  if (!name) return jsonError("Device name is required", 400);

  const ua = parseUserAgent(request.headers.get("user-agent"));
  const fingerprint = computeDeviceFingerprint(
    `${user.id}:${typeof body.fingerprint === "string" && body.fingerprint ? body.fingerprint : request.headers.get("user-agent") ?? "unknown"}`,
  );

  // Re-registering the same fingerprint updates last_seen_at (heartbeat).
  const existing = await db.query<{ id: string }>(
    `select id from public.devices where owner_id = $1 and device_fingerprint = $2 limit 1`,
    [user.id, fingerprint],
  );
  const now = new Date().toISOString();

  if (existing.rows[0]) {
    const { rows } = await db.query<Device>(
      `update public.devices
       set name = $1, last_seen_at = $2
       where id = $3 and owner_id = $4
       returning *`,
      [name, now, existing.rows[0].id, user.id],
    );
    return NextResponse.json({ device: rows[0] });
  }

  const { rows } = await db.query<Device>(
    `insert into public.devices
       (owner_id, name, device_fingerprint, platform, browser, os, last_seen_at, is_trusted)
     values ($1, $2, $3, $4, $5, $6, $7, false)
     returning *`,
    [user.id, name, fingerprint, ua.platform, ua.browser, ua.os, now],
  );
  const device = rows[0];
  await logSecurityEvent(db, {
    user_id: user.id,
    device_id: device.id,
    actor_id: user.id,
    action: "device.registered",
    details: { name, platform: ua.platform },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ device }, { status: 201 });
}

/**
 * DELETE /api/devices?id=<id> — owner-only removal. Removal revokes the
 * device's grants and ends its active sessions (in one transaction).
 */
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return jsonError("Device id is required", 400);
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`devices:remove:${user.id}`, 10, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const device = await db.query<{ id: string }>(
    `select id from public.devices where id = $1 and owner_id = $2 limit 1`,
    [id, user.id],
  );
  if (!device.rows[0]) return jsonError("Device not found", 404);

  const now = new Date().toISOString();
  await db.tx(async (tx) => {
    await tx.query(
      `update public.device_permissions
       set is_revoked = true, revoked_at = $1, revoked_by = $2
       where device_id = $3 and is_revoked = false`,
      [now, user.id, id],
    );
    await tx.query(
      `update public.remote_sessions
       set status = 'ended', ended_at = $1
       where device_id = $2 and status = 'active'`,
      [now, id],
    );
    await tx.query(
      `delete from public.devices where id = $1 and owner_id = $2`,
      [id, user.id],
    );
  });

  await logSecurityEvent(db, {
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
