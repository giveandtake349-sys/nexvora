import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Audit logging helpers. Every grant, permission change, revocation,
 * pairing outcome, approval, rejection, session start/end and disconnect
 * writes a row to security_events (and session_events for session actions).
 *
 * Best-effort: a failed audit insert must never break the operation it
 * records — it is logged to the server console instead. Audit rows are
 * shown in the Security Center.
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
  supabase: SupabaseClient | null,
  input: AuditInput,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("security_events").insert({
    user_id: input.user_id ?? null,
    device_id: input.device_id ?? null,
    actor_id: input.actor_id ?? null,
    action: input.action,
    details: input.details ?? {},
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
  });
  if (error) console.error("[audit] security_events insert failed:", error.message);
}

export async function logSessionEvent(
  supabase: SupabaseClient | null,
  input: {
    session_id?: string | null;
    device_id?: string | null;
    actor_id?: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from("session_events").insert({
    session_id: input.session_id ?? null,
    device_id: input.device_id ?? null,
    actor_id: input.actor_id ?? null,
    action: input.action,
    details: input.details ?? {},
  });
  if (error) console.error("[audit] session_events insert failed:", error.message);
}
