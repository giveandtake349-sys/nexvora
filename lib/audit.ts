import type { DbClient } from "@/lib/db/client";

/**
 * Audit logging helpers. Every grant, permission change, revocation,
 * pairing outcome, approval, rejection, session start/end and disconnect
 * writes a row to security_events (and session_events for session actions).
 *
 * Best-effort: a failed audit insert must never break the operation it
 * records — it is logged to the server console instead. Audit rows are
 * shown in the Security Center. The inserts run through the request's
 * RLS-scoped client, so the actor_id policies apply to them as well.
 */

export interface AuditInput {
  user_id?: string | null;
  device_id?: string | null;
  actor_id?: string | null;
  action: string;
  details?: Record<string, unknown>;
  ip_address?: string | null;
  user_agent?: string | null;
}

export async function logSecurityEvent(
  db: DbClient | null,
  input: AuditInput,
): Promise<void> {
  if (!db) return;
  try {
    await db.query(
      `insert into public.security_events
         (user_id, device_id, actor_id, action, details, ip_address, user_agent)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        input.user_id ?? null,
        input.device_id ?? null,
        input.actor_id ?? null,
        input.action,
        JSON.stringify(input.details ?? {}),
        input.ip_address ?? null,
        input.user_agent ?? null,
      ],
    );
  } catch (error) {
    console.error("[audit] security_events insert failed:", error);
  }
}

export async function logSessionEvent(
  db: DbClient | null,
  input: {
    session_id?: string | null;
    device_id?: string | null;
    actor_id?: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!db) return;
  try {
    await db.query(
      `insert into public.session_events
         (session_id, device_id, actor_id, action, details)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [
        input.session_id ?? null,
        input.device_id ?? null,
        input.actor_id ?? null,
        input.action,
        JSON.stringify(input.details ?? {}),
      ],
    );
  } catch (error) {
    console.error("[audit] session_events insert failed:", error);
  }
}
