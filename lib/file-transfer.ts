/**
 * File transfer over WebRTC (Milestone 4) — pure, unit-testable rules.
 *
 * Design:
 * - Offer / approve / reject / cancel / complete metadata travels as
 *   small JSON messages over the existing "nexvora-control" data
 *   channel (lib/webrtc.ts). Binary file bytes travel over a DEDICATED
 *   data channel named "nexvora-file" — never over the control
 *   channel. Why a second channel, when M3 deliberately kept one?
 *   Binary framing and backpressure differ fundamentally from JSON
 *   control messages: file chunks are ArrayBuffers with a 4-byte
 *   index header, flow at up to 50 MB, and need bufferedAmount-based
 *   flow control. Mixing them into the control channel would force
 *   the control-message parser to distinguish binary from text on
 *   every message, and a stalled file transfer could delay the
 *   kill-switch / mute messages that must always get through
 *   immediately. Two channels keep control traffic unblocked.
 * - Files are peer-to-peer only: the server NEVER stores file bytes.
 *   The server only stores transfer METADATA in the existing
 *   `file_transfers` table (file name, size, sender, receiver,
 *   status) via the Milestone 4 API routes.
 * - Owner approval per transfer: the sender offers metadata first;
 *   binary chunks flow ONLY after the receiver approves. Rejecting
 *   sends nothing.
 * - Size limit: 50 MB per file, enforced on BOTH sides — the sender
 *   refuses to offer a larger file, the receiver refuses an offer
 *   whose declared size exceeds the limit, and the server rejects a
 *   metadata row whose size exceeds it.
 *
 * HARD CONSENT BOUNDARY: a transfer needs a live `file_transfer`
 * grant (owner exempt on their own device) AND an explicit per-file
 * approval by the receiver. Nothing is sent silently, and the owner
 * can stop a transfer (cancel) or revoke the grant at any time —
 * revocation tears the live session down, which closes both data
 * channels immediately.
 */

/* ------------------------------------------------------------------ */
/* Channel + limits                                                    */
/* ------------------------------------------------------------------ */

/** Dedicated data channel for binary file chunks. */
export const FILE_CHANNEL_NAME = "nexvora-file";

/** Max file size per transfer: 50 MiB. Enforced sender-side,
 *  receiver-side, and server-side. */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Chunk size for binary transfer: 16 KiB. */
export const FILE_CHUNK_SIZE_BYTES = 16 * 1024;

/**
 * Backpressure: the sender pauses while the channel's bufferedAmount
 * is above this (256 KiB) and resumes below the low watermark
 * (64 KiB). Keeps memory bounded on a slow peer.
 */
export const FILE_BUFFERED_AMOUNT_HIGH_WATERMARK = 256 * 1024;
export const FILE_BUFFERED_AMOUNT_LOW_WATERMARK = 64 * 1024;

/** Binary chunk framing: 4-byte big-endian chunk index + payload. */
export const FILE_CHUNK_HEADER_BYTES = 4;

/* ------------------------------------------------------------------ */
/* File name validation (server-side where the server is involved)     */
/* ------------------------------------------------------------------ */

/** Max file-name length (matches common filesystems). */
export const MAX_FILE_NAME_LENGTH = 255;

/**
 * A file name is valid when it is a bare name — never a path. Rejects
 * empty names, "." / "..", anything containing a path separator or a
 * control character (including NUL), and names over 255 characters.
 * Client-supplied paths are never trusted: only the validated bare
 * name is stored or displayed.
 */
export function validateFileName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof name !== "string") return { ok: false, error: "file name must be a string" };
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "file name must not be empty" };
  if (trimmed === "." || trimmed === "..") return { ok: false, error: "file name must not be '.' or '..'" };
  if (trimmed.length > MAX_FILE_NAME_LENGTH) {
    return { ok: false, error: `file name must be at most ${MAX_FILE_NAME_LENGTH} characters` };
  }
  if (/[/\\]/.test(trimmed)) {
    return { ok: false, error: "file name must not contain a path separator" };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: "file name must not contain control characters" };
  }
  return { ok: true, name: trimmed };
}

/** Validate a file offer's declared size (both sides + server). */
export function validateFileSize(size: unknown): { ok: true; size: number } | { ok: false; error: string } {
  if (typeof size !== "number" || !Number.isSafeInteger(size)) {
    return { ok: false, error: "file size must be an integer number of bytes" };
  }
  if (size <= 0) return { ok: false, error: "file size must be greater than zero" };
  if (size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `file size exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit`,
    };
  }
  return { ok: true, size };
}

/* ------------------------------------------------------------------ */
/* Chunking + progress math                                            */
/* ------------------------------------------------------------------ */

/** How many 16 KiB chunks a file of `size` bytes splits into. */
export function chunkCountFor(size: number): number {
  if (size <= 0) return 0;
  return Math.ceil(size / FILE_CHUNK_SIZE_BYTES);
}

/** Byte range [start, end) of chunk `index` within a file of `size`. */
export function chunkRangeFor(index: number, size: number): { start: number; end: number } {
  const start = index * FILE_CHUNK_SIZE_BYTES;
  const end = Math.min(start + FILE_CHUNK_SIZE_BYTES, size);
  return { start, end };
}

/** Whole-number transfer progress (0–100) from bytes moved so far. */
export function transferProgressPercent(bytesMoved: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  const pct = Math.floor((bytesMoved / totalBytes) * 100);
  return Math.min(100, Math.max(0, pct));
}

/* ------------------------------------------------------------------ */
/* Binary chunk framing (4-byte big-endian index + payload)            */
/* ------------------------------------------------------------------ */

/** Encode one chunk: 4-byte index header followed by the payload. */
export function encodeFileChunk(index: number, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(FILE_CHUNK_HEADER_BYTES + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, index, false);
  out.set(data, FILE_CHUNK_HEADER_BYTES);
  return out;
}

/**
 * Decode one received binary message. Returns null for anything too
 * short to hold a header — a malformed chunk never crashes the
 * receiver; it is dropped and the transfer fails on completion check.
 */
export function decodeFileChunk(buffer: ArrayBuffer): { index: number; data: Uint8Array } | null {
  if (buffer.byteLength < FILE_CHUNK_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  const index = view.getUint32(0, false);
  return { index, data: new Uint8Array(buffer, FILE_CHUNK_HEADER_BYTES) };
}

/* ------------------------------------------------------------------ */
/* Transfer state machine                                              */
/* ------------------------------------------------------------------ */

/**
 * Transfer statuses — the same six the `file_transfers` table
 * already constrains (0001_init.sql). "cancelled" is NOT a table
 * status: a cancelled transfer is recorded as "failed" with the
 * reason in the audit details, so the table constraint never needs
 * changing.
 */
export const FILE_TRANSFER_STATUSES = [
  "pending",
  "approved",
  "in_progress",
  "completed",
  "rejected",
  "failed",
] as const;

export type FileTransferStatus = (typeof FILE_TRANSFER_STATUSES)[number];

export function isFileTransferStatus(value: unknown): value is FileTransferStatus {
  return (
    typeof value === "string" &&
    (FILE_TRANSFER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Allowed server-side status transitions. Terminal states
 * (completed / rejected / failed) never move again. The receiver
 * drives pending -> approved / rejected; the sender drives
 * approved -> in_progress -> completed; either side may mark a
 * non-terminal transfer failed (error or cancel).
 */
export const ALLOWED_TRANSFER_TRANSITIONS: Record<FileTransferStatus, readonly FileTransferStatus[]> = {
  pending: ["approved", "rejected", "failed"],
  approved: ["in_progress", "failed"],
  in_progress: ["completed", "failed"],
  completed: [],
  rejected: [],
  failed: [],
};

export function canTransitionTransferStatus(
  from: FileTransferStatus,
  to: FileTransferStatus,
): boolean {
  return (ALLOWED_TRANSFER_TRANSITIONS[from] ?? []).includes(to);
}

/** Who may perform each transition (checked server-side by the API
 *  route, which knows the caller): the receiver approves/rejects,
 *  the sender starts/completes, either side may fail. */
export type TransferActor = "sender" | "receiver";

export function canActorTransitionTransferStatus(
  actor: TransferActor,
  from: FileTransferStatus,
  to: FileTransferStatus,
): boolean {
  if (!canTransitionTransferStatus(from, to)) return false;
  if (to === "approved" || to === "rejected") return actor === "receiver";
  if (to === "in_progress" || to === "completed") return actor === "sender";
  return true; // "failed": either side (error or cancel).
}

/* ------------------------------------------------------------------ */
/* API body validation (create + status update)                        */
/* ------------------------------------------------------------------ */

/** Validate POST /file-transfers body: { fileName, fileSizeBytes }. */
export function validateFileTransferCreateBody(
  body: unknown,
): { ok: true; fileName: string; fileSizeBytes: number } | { ok: false; error: string; status: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object", status: 400 };
  }
  const b = body as Record<string, unknown>;
  const name = validateFileName(b.fileName);
  if (!name.ok) return { ok: false, error: name.error, status: 400 };
  if (typeof b.fileSizeBytes === "number" && b.fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `file size exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB limit`,
      status: 413,
    };
  }
  const size = validateFileSize(b.fileSizeBytes);
  if (!size.ok) return { ok: false, error: size.error, status: 400 };
  return { ok: true, fileName: name.name, fileSizeBytes: size.size };
}

/** Validate the status-update body: { status }. */
export function validateFileTransferStatusBody(
  body: unknown,
): { ok: true; status: FileTransferStatus } | { ok: false; error: string; status: number } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object", status: 400 };
  }
  const status = (body as Record<string, unknown>).status;
  if (!isFileTransferStatus(status)) {
    return {
      ok: false,
      error: `status must be one of: ${FILE_TRANSFER_STATUSES.join(", ")}`,
      status: 400,
    };
  }
  return { ok: true, status };
}
