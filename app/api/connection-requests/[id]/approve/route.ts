import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { defaultGrantExpiry, isPermissionScope, type PermissionScope } from "@/lib/permissions";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";

/**
 * POST /api/connection-requests/:id/approve
 * Owner-only. Body: { scopes: string[] } — the owner may approve a
 * SUBSET of what was requested. Only approved scopes become grants
 * (one device_permissions row per scope, 30-day default expiry).
 * Approving also creates the active remote_session both users can see.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { supabase, user } = auth.ctx;
  const { id } = await context.params;

  const body = await request.json().catch(() => ({}));
  const scopes: PermissionScope[] = Array.isArray(body.scopes)
    ? body.scopes.filter((s: unknown) => isPermissionScope(s))
    : [];

  const { data: req, error } = await supabase
    .from("connection_requests")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (error) return jsonError(error.message, 500);
  if (!req) return jsonError("Connection request not found", 404);
  if (req.status !== "pending") return jsonError(`Request is already ${req.status}`, 409);
  if (scopes.length === 0) return jsonError("Approve at least one permission scope", 400);
  const notRequested = scopes.filter((s) => !req.requested_scopes.includes(s));
  if (notRequested.length > 0) {
    return jsonError(`Cannot approve scopes that were not requested: ${notRequested.join(", ")}`, 400);
  }

  const expiresAt = defaultGrantExpiry();
  const grantRows = scopes.map((scope) => ({
    owner_id: user.id,
    device_id: req.target_device_id,
    granted_to_user_id: req.requester_user_id,
    scope,
    expires_at: expiresAt.toISOString(),
    is_revoked: false,
  }));
  const { error: grantError } = await supabase.from("device_permissions").insert(grantRows);
  if (grantError) return jsonError(grantError.message, 500);

  const { data: session, error: sessionError } = await supabase
    .from("remote_sessions")
    .insert({
      connection_request_id: req.id,
      device_id: req.target_device_id,
      owner_id: user.id,
      participant_user_id: req.requester_user_id,
      status: "active",
    })
    .select()
    .single();
  if (sessionError) return jsonError(sessionError.message, 500);

  const { error: updateError } = await supabase
    .from("connection_requests")
    .update({ status: "approved", decided_at: new Date().toISOString() })
    .eq("id", id);
  if (updateError) return jsonError(updateError.message, 500);

  await logSecurityEvent(supabase, {
    user_id: user.id,
    device_id: req.target_device_id,
    actor_id: user.id,
    action: "connection.approved",
    details: { connection_request_id: id, approved_scopes: scopes, expires_at: expiresAt.toISOString() },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });
  await logSessionEvent(supabase, {
    session_id: session.id,
    device_id: req.target_device_id,
    actor_id: user.id,
    action: "session.started",
    details: { connection_request_id: id },
  });
  return NextResponse.json({ ok: true, session, approvedScopes: scopes });
}
