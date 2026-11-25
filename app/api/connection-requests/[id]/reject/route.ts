import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
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

  const reqRes = await db.query<ConnectionRequest>(
    `select * from public.connection_requests where id = $1 and owner_id = $2 limit 1`,
    [id, user.id],
  );
  const reqRow = reqRes.rows[0] ?? null;
  if (!reqRow) return jsonError("Connection request not found", 404);
  if (reqRow.status !== "pending") return jsonError(`Request is already ${reqRow.status}`, 409);

  await db.query(
    `update public.connection_requests
     set status = 'rejected', decided_at = $1
     where id = $2`,
    [new Date().toISOString(), id],
  );

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
