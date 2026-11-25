import { createHash, randomBytes } from "node:crypto";

/**
 * Secure temporary pairing codes.
 *
 * - 256-bit cryptographically random secret per invitation.
 * - The 6-digit display code is DERIVED from that secret (never the secret).
 * - Only SHA-256 hashes are stored in the database — never the code or the
 *   secret in plaintext.
 * - Codes expire after 10 minutes and are single-use: the first successful
 *   redeem marks the invitation used; any later attempt fails (replay
 *   prevention).
 * - A pairing code NEVER grants access by itself. It only creates a
 *   connection REQUEST; access requires the owner's explicit approval.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const PAIRING_MAX_ATTEMPTS = 5; // per user per 10 minutes
export const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export function hashPairingValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface GeneratedPairingCode {
  /** 6-digit code shown to the user. Never stored, never logged. */
  code: string;
  /** SHA-256 of the code — used to look the invitation up on redeem. */
  codeHash: string;
  /** SHA-256 of the underlying random secret. */
  secretHash: string;
  expiresAt: Date;
}

export function generatePairingCode(now: Date = new Date()): GeneratedPairingCode {
  const secret = randomBytes(32); // 256-bit entropy
  const secretHash = createHash("sha256").update(secret).digest("hex");
  // 6-digit display code derived from the secret, never the secret itself.
  const derived = parseInt(secretHash.slice(0, 8), 16) % 900000 + 100000;
  const code = String(derived).padStart(6, "0");
  return {
    code,
    codeHash: hashPairingValue(code),
    secretHash,
    expiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS),
  };
}

export function isPairingExpired(expiresAt: string | Date, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

export interface PairingInvitationState {
  used_at: string | null;
  expires_at: string | Date;
  status: string;
}

export type PairingUsability = "usable" | "used" | "expired" | "revoked";

/**
 * Single-use + expiry check. Pure function so it is unit-testable and
 * reusable by the redeem route (which must ALSO mark the invitation used
 * in the same DB transaction / update before creating the request).
 */
export function checkPairingUsability(
  invitation: PairingInvitationState | null | undefined,
  now: Date = new Date(),
): PairingUsability {
  if (!invitation) return "expired";
  if (invitation.status === "revoked" || invitation.status === "cancelled")
    return "revoked";
  if (invitation.used_at) return "used";
  if (isPairingExpired(invitation.expires_at, now)) return "expired";
  return "usable";
}
