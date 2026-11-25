import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent } from "@/lib/audit";
import type { ConnectionRequest } from "@/lib/types";

/** POST /api/connection-requests/:id/reject — owner-only, no grants created. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;
  if (!isUuid(id)) return invalidIdResponse();

  const limit = checkRateLimit(`connection-requests:reject:${user.id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const reqRes = await db.query<ConnectionRequest>(
    `select * from public.connection_requests where id = $1 and owner_id = $2 limit 1`,
    [id, user.id],
  );
  const reqRow = reqRes.rows[0] ?? null;
  if (!reqRow) return jsonError("Connection request not found", 404);
  if (reqRow.status !== "pending") return jsonError(`Request is already ${reqRow.status}`, 409);

  // Conditional update: a concurrent approve/reject must not flip an
  // already-decided request. rowCount 0 means the other side won.
  const updated = await db.query(
    `update public.connection_requests
     set status = 'rejected', decided_at = $1
     where id = $2 and status = 'pending'`,
    [new Date().toISOString(), id],
  );
  if (updated.rowCount === 0) {
    return jsonError("Request was already decided by another request", 409);
  }

  await logSecurityEvent(db, {
    user_id: user.id,
    device_id: reqRow.target_device_id,
    actor_id: user.id,
    action: "connection.rejected",
    details: { connection_request_id: id, requested_scopes: reqRow.requested_scopes },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
