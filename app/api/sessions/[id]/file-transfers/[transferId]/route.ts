import { NextResponse, type NextRequest } from "next/server";
import { jsonError, requireAuth, clientIp, isUuid, invalidIdResponse, readJsonBody } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { logSecurityEvent, logSessionEvent } from "@/lib/audit";
import { loadSessionForParty } from "@/lib/signaling";
import {
  canActorTransitionTransferStatus,
  validateFileTransferStatusBody,
  type FileTransferStatus,
  type TransferActor,
} from "@/lib/file-transfer";
import type { FileTransfer } from "@/lib/types";

/**
 * PATCH /api/sessions/[id]/file-transfers/[transferId] — move a
 * transfer's status. Body: { status }.
 *
 * Rules (enforced here, server-side — the client never decides):
 * - The caller must be a party of the session AND the sender or the
 *   receiver of this transfer.
 * - The transition must be allowed by the transfer state machine
 *   (pending -> approved/rejected/failed, approved -> in_progress/
 *   failed, in_progress -> completed/failed; terminal states never
 *   move). A second "completed" for the same transfer is a 409, not
 *   a double-count.
 * - The receiver approves/rejects; the sender starts/completes;
 *   either side may mark a non-terminal transfer failed (error or
 *   cancel).
 * - `completed_at` is set exactly when the status becomes completed.
 *
 * Rate limit: 30 updates per user per session per minute.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; transferId: string }> },
) {
  const auth = await requireAuth();
  if ("response" in auth) return auth.response;
  const { db, user } = auth.ctx;
  const { id, transferId } = await params;
  if (!isUuid(id) || !isUuid(transferId)) return invalidIdResponse();

  const limit = checkRateLimit(`session-file-status:${user.id}:${id}`, 30, 60_000);
  if (!limit.allowed) return jsonError("Too many requests. Try again shortly.", 429);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.body;
  const validated = validateFileTransferStatusBody(body);
  if (!validated.ok) return jsonError(validated.error, validated.status);

  const access = await loadSessionForParty(db, id, user.id);
  if ("error" in access) {
    return access.error === "not_found"
      ? jsonError("Session not found", 404)
      : jsonError("Session is no longer active", 409);
  }
  const session = access.session;

  const result = await db.tx(async (tx) => {
    const found = await tx.query<FileTransfer>(
      `select * from public.file_transfers where id = $1 and session_id = $2 limit 1`,
      [transferId, id],
    );
    const transfer = found.rows[0] ?? null;
    if (!transfer) return { kind: "not_found" as const };
    if (transfer.sender_user_id !== user.id && transfer.receiver_user_id !== user.id) {
      return { kind: "not_found" as const };
    }
    const actor: TransferActor =
      transfer.sender_user_id === user.id ? "sender" : "receiver";
    if (
      !canActorTransitionTransferStatus(actor, transfer.status, validated.status)
    ) {
      return {
        kind: "invalid_transition" as const,
        from: transfer.status,
        to: validated.status,
      };
    }
    const now = new Date().toISOString();
    // Atomic guard: the row must still be in the `from` status. Two
    // concurrent PATCHes both passing the in-transaction check could
    // otherwise both move the transfer (double-approve / double-end).
    // rowCount 0 means the other request won — answer 409, never apply
    // the transition twice.
    const updated = await tx.query<FileTransfer>(
      `update public.file_transfers
       set status = $1, completed_at = case when $1 = 'completed' then $2 else completed_at end
       where id = $3 and status = $4
       returning id, session_id, sender_user_id, receiver_user_id, device_id,
         file_name, file_size_bytes, storage_path, status, created_at, completed_at`,
      [validated.status, now, transferId, transfer.status],
    );
    const row = updated.rows[0];
    if (!row) return { kind: "concurrent" as const };
    return { kind: "ok" as const, transfer: row, from: transfer.status };
  });

  if (result.kind === "not_found") return jsonError("File transfer not found", 404);
  if (result.kind === "concurrent") {
    return jsonError("File transfer was already updated by another request", 409);
  }
  if (result.kind === "invalid_transition") {
    return jsonError(
      `Cannot move a transfer from ${result.from} to ${result.to}`,
      409,
    );
  }

  const next: FileTransferStatus = validated.status;
  await logSessionEvent(db, {
    session_id: session.id,
    device_id: session.device_id,
    actor_id: user.id,
    action: `file_transfer.${next}`,
    details: { transfer_id: transferId, from: result.from },
  });
  // Keep the security log focused: only terminal outcomes are
  // security-relevant (a completed or failed transfer), not every
  // in-progress step.
  if (next === "completed" || next === "failed" || next === "rejected") {
    await logSecurityEvent(db, {
      user_id: session.owner_id,
      device_id: session.device_id,
      actor_id: user.id,
      action: `file_transfer.${next}`,
      details: { session_id: session.id, transfer_id: transferId },
      ip_address: clientIp(request),
      user_agent: request.headers.get("user-agent"),
    });
  }

  return NextResponse.json({ ok: true, transfer: result.transfer });
}
