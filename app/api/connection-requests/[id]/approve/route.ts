import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { defaultGrantExpiry, isPermissionScope, type PermissionScope } from "@/lib/permissions";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import type { ConnectionRequest, DevicePermission, RemoteSession } from "@/lib/types";

/**
 * POST /api/connection-requests/:id/approve — owner-only.
 * Body: { scopes: string[] } — the owner may approve a SUBSET of what
 * was requested. Only approved scopes become grants (one
 * device_permissions row per scope, 30-day default expiry). Approving
 * also creates the active remote_session both users can see.
 *
 * Atomic (one transaction): grants + session + request status flip to
 * 'approved'. If any part fails, nothing is written — a request can
 * never be half-approved. Re-approving a scope that already has a live
 * grant refreshes its expiry instead of failing on the unique index.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`connection-requests:approve:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body =
    parsedBody.body !== null && typeof parsedBody.body === "object"
      ? (parsedBody.body as Record<string, unknown>)
      : {};
  const scopes: PermissionScope[] = Array.isArray(body.scopes)
    ? body.scopes.filter((s: unknown) => isPermissionScope(s))
    : [];

  const reqRes = await db.query<ConnectionRequest>(
    `select * from public.connection_requests where id = $1 and owner_id = $2 limit 1`,
    [id, user.id],
  );
  const reqRow = reqRes.rows[0] ?? null;
  if (!reqRow) return jsonError("Connection request not found", 404);
  if (reqRow.status !== "pending") return jsonError(`Request is already ${reqRow.status}`, 409);
  if (scopes.length === 0) return jsonError("Approve at least one permission scope", 400);
  const notRequested = scopes.filter((s) => !reqRow.requested_scopes.includes(s));
  if (notRequested.length > 0) {
    return jsonError(`Cannot approve scopes that were not requested: ${notRequested.join(", ")}`, 400);
  }

  const expiresAt = defaultGrantExpiry();
  const now = new Date().toISOString();
  let session: RemoteSession;
  try {
    session = await db.tx(async (tx) => {
      const grants = await tx.query<DevicePermission>(
        `insert into public.device_permissions
           (owner_id, device_id, granted_to_user_id, scope, granted_at, expires_at, is_revoked)
         select $1, $2, $3, scope, $4, $5, false
         from unnest($6::text[]) as scope
         on conflict (device_id, granted_to_user_id, scope)
           where is_revoked = false
         do update set granted_at = excluded.granted_at,
                      expires_at = excluded.expires_at
         returning *`,
        [user.id, reqRow.target_device_id, reqRow.requester_user_id, now, expiresAt.toISOString(), scopes],
      );
      if (grants.rows.length !== scopes.length) {
        throw new Error("GRANT_COUNT_MISMATCH");
      }
      const sessions = await tx.query<RemoteSession>(
        `insert into public.remote_sessions
           (connection_request_id, device_id, owner_id, participant_user_id, status, started_at)
         values ($1, $2, $3, $4, 'active', $5)
         returning *`,
        [reqRow.id, reqRow.target_device_id, user.id, reqRow.requester_user_id, now],
      );
      const created = sessions.rows[0];
      if (!created) throw new Error("SESSION_INSERT_FAILED");
      await tx.query(
        `update public.connection_requests
         set status = 'approved', decided_at = $1
         where id = $2 and status = 'pending'`,
        [now, id],
      );
      return created;
    });
  } catch (error) {
    console.error("[connection-requests] approve transaction failed:", error);
    return jsonError("Could not approve this request.", 500);
  }

  await logSecurityEvent(db, {
    user_id: user.id,
    device_id: reqRow.target_device_id,
    actor_id: user.id,
    action: "connection.approved",
    details: { connection_request_id: id, approved_scopes: scopes, expires_at: expiresAt.toISOString() },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  await logSessionEvent(db, {
    session_id: session.id,
    device_id: reqRow.target_device_id,
    actor_id: user.id,
    action: "session.started",
    details: { connection_request_id: id },
  });
  return NextResponse.json({ ok: true, session, approvedScopes: scopes });
}
