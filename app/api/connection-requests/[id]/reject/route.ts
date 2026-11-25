import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { logSecurityEvent } from "@/lib/audit";

/** POST /api/connection-requests/:id/reject — owner-only, no grants created. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const { id } = await context.params;

  const { data: req, error } = await supabase
    .from("connection_requests")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!req) return jsonError("Connection request not found", 404);
  if (req.status !== "pending") return jsonError(`Request is already ${req.status}`, 409);

  const { error: updateError } = await supabase
    .from("connection_requests")
    .update({ status: "rejected", decided_at: new Date().toISOString() })
    .eq("id", id);
  if (updateError) return jsonError(updateError.message, 500);

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: req.target_device_id,
    actor_id: user.id,
    action: "connection.rejected",
    details: { connection_request_id: id, requested_scopes: req.requested_scopes },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  return NextResponse.json({ ok: true });
}
