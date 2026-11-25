import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import { loadSessionForParty } from "@/lib/signaling";
import {
  AUDIT_ACTION_SCOPE,
  shouldLogSecurityEvent,
  validateSessionEventBody,
} from "@/lib/live-features";
import { isGrantValid, type DevicePermissionGrant } from "@/lib/permissions";

/**
 * POST /api/sessions/[id]/events — write one Milestone 4 audit event
 * for a live session (location / notification sharing start-stop,
 * remote-interaction start/stop/kill, session recording start/stop).
 * Body: { action, details? }.
 *
 * Only the nine actions in lib/live-features.ts are accepted, and
 * details are capped at 2 KiB — a client cannot inject arbitrary
 * audit rows. The caller must be a party of an active session AND
 * hold a live grant for the action's scope (owner exempt; recording
 * actions accept any live screen / camera / microphone grant). The
 * event is written to session_events (visible in the Security Center)
 * and, for sharing starts, also to security_events.
 *
 * Rate limit: 30 events per user per session per minute.
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

  const limit = checkRateLimit(`session-events:${user.id}:${id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const validated = validateSessionEventBody(body);
  if (!validated.ok) return jsonError(validated.error, validated.status);

  const access = await loadSessionForParty(db, id, user.id);
  if ("error" in access) {
    return access.error === "not_found"
      ? jsonError("Session not found", 404)
      : jsonError("Session is no longer active", 409);
  }
  const session = access.session;

  const scope = AUDIT_ACTION_SCOPE[validated.action];
  if (user.id !== session.owner_id) {
    // "any-media" (recording): the caller must hold a live grant for
    // at least one of screen / camera / microphone — recording
    // captures whichever remote tracks are live, so no single scope
    // fits. Every other action checks its one scope, as before.
    const grants =
      scope === "any-media"
        ? await db.query<DevicePermissionGrant>(
            `select device_id, scope, is_revoked, revoked_at, expires_at
             from public.device_permissions
             where device_id = $1 and granted_to_user_id = $2
               and scope in ('screen', 'camera', 'microphone') and is_revoked = false`,
            [session.device_id, user.id],
          )
        : await db.query<DevicePermissionGrant>(
            `select device_id, scope, is_revoked, revoked_at, expires_at
             from public.device_permissions
             where device_id = $1 and granted_to_user_id = $2 and scope = $3 and is_revoked = false`,
            [session.device_id, user.id, scope],
          );
    const valid = grants.rows.some((g) => isGrantValid(g, session.device_id));
    if (!valid) {
      return jsonError(
        scope === "any-media"
          ? "No live screen, camera or microphone permission is granted to you for this device"
          : `The ${scope} permission is not granted to you for this device`,
        403,
      );
    }
  }

  await logSessionEvent(db, {
    session_id: session.id,
    device_id: session.device_id,
    actor_id: user.id,
    action: validated.action,
    details: validated.details,
  });
  if (shouldLogSecurityEvent(validated.action)) {
    await logSecurityEvent(db, {
      user_id: session.owner_id,
      device_id: session.device_id,
      actor_id: user.id,
      action: validated.action,
      details: { session_id: session.id, ...validated.details },
      ip_address: clientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
  }

  return NextResponse.json({ ok: true });
}
