/**
 * Schema registry — the single list of tables the migration creates.
 * Used by the migration-consistency test (lib/__tests__/db.test.ts) to
 * assert that db/migrations/0001_init.sql defines every table, forces
 * RLS on it, and never references Supabase auth.
 *
 * User ids are Better Auth ids (opaque text). Device / session /
 * request ids are uuids.
 */
export const SCHEMA_TABLES = [
  "profiles",
  "devices",
  "pairing_invitations",
  "connection_requests",
  "device_permissions",
  "remote_sessions",
  "session_events",
  "security_events",
  "notifications",
  "file_transfers",
] as const;

export type SchemaTable = (typeof SCHEMA_TABLES)[number];

/** The RLS helper the migration defines and every policy uses. */
export const RLS_USER_FUNCTION = "public.current_app_user_id()";
