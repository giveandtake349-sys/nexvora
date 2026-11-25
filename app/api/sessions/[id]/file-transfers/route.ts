import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import { loadSessionForParty, otherPartyId } from "@/lib/signaling";
import { validateFileTransferCreateBody } from "@/lib/file-transfer";
import { isGrantValid, type DevicePermissionGrant } from "@/lib/permissions";
import type { FileTransfer } from "@/lib/types";

/**
 * POST /api/sessions/[id]/file-transfers — record a file-transfer
 * offer (metadata ONLY — the server never stores file bytes; bytes
 * travel peer-to-peer over the "nexvora-file" WebRTC data channel).
 *
 * Body: { fileName, fileSizeBytes }. The file name is validated as a
 * bare name (no paths, no control characters, ≤255 chars) and the
 * size against the 50 MB limit — never trust client-supplied paths
 * or sizes. The caller must be a party of an active session AND
 * hold a live `file_transfer` grant (owner exempt). The row starts
 * in `pending`; the receiver's approve/reject moves it on (see the
 * [transferId] route). The returned id is the transferId the sender
 * puts in the `file-offer` control message.
 *
 * Rate limit: 10 offers per user per session per minute.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id } = await params;

  const limit = checkRateLimit(`session-file-offers:${user.id}:${id}`, 10, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const body = await request.json().catch(() => ({}));
  const validated = validateFileTransferCreateBody(body);
  if (!validated.ok) return jsonError(validated.error, validated.status);

  const access = await loadSessionForParty(db, id, user.id);
  if ("error" in access) {
    return access.error === "not_found"
      ? jsonError("Session not found", 404)
      : jsonError("Session is no longer active", 409);
  }
  const session = access.session;

  // Grant check: the owner is exempt; a participant needs a live
  // file_transfer grant on this device. (Unlike signaling, which
  // accepts ANY live grant, file transfer needs its own scope.)
  if (user.id !== session.owner_id) {
    const grants = await db.query<DevicePermissionGrant>(
      `select device_id, scope, is_revoked, revoked_at, expires_at
       from public.device_permissions
       where device_id = $1 and granted_to_user_id = $2 and scope = 'file_transfer' and is_revoked = false`,
      [session.device_id, user.id],
    );
    const valid = grants.rows.some((g) => isGrantValid(g, session.device_id));
    if (!valid) {
      return jsonError("File transfer is not granted to you for this device", 403);
    }
  }

  const receiver = otherPartyId(session, user.id);
  if (!receiver) return jsonError("Session not found", 404);

  const inserted = await db.query<FileTransfer>(
    `insert into public.file_transfers
       (session_id, sender_user_id, receiver_user_id, device_id, file_name, file_size_bytes, status)
     values ($1, $2, $3, $4, $5, $6, 'pending')
     returning id, session_id, sender_user_id, receiver_user_id, device_id,
       file_name, file_size_bytes, storage_path, status, created_at, completed_at`,
    [id, user.id, receiver, session.device_id, validated.fileName, validated.fileSizeBytes],
  );
  const row = inserted.rows[0];
  if (!row) return jsonError("Could not record the file transfer", 500);

  await logSessionEvent(db, {
    session_id: session.id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "file_transfer.offered",
    details: { transfer_id: row.id, file_name: row.file_name, file_size_bytes: row.file_size_bytes },
  });
  await logSecurityEvent(db, {
    user_id: session.owner_id,
    device_id: session.device_id,
    actor_id: user.id,
    action: "file_transfer.offered",
    details: { session_id: session.id, transfer_id: row.id },
    ip_address: clientIp(request),
    user_agent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ ok: true, transfer: row });
}
