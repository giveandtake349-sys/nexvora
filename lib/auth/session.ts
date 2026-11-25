import { getAuth } from "@/lib/auth/server";
import { isAuthConfigured, isDatabaseConfigured } from "@/lib/db/config";
import { withUser } from "@/lib/db/client";

/**
 * The signed-in user, mapped from Managed Better Auth (Neon Auth) to
 * the shape the rest of the app uses. User ids are Better Auth ids —
 * opaque strings, NOT uuids — so every user-id column in the schema
 * is text (see db/migrations/0001_init.sql).
 */
export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
}

/**
 * Reads the validated session server-side. Returns null when auth is
 * not configured or there is no session.
 *
 * Shape note (verified against the shipped @neon/auth 0.8.2 runtime):
 * the server getSession() returns `{ data: { session, user } | null,
 * error }`. The SDK's own bundled NEXT-JS.md guide shows the bare
 * `{ session, user }` shape instead, so both are normalised here —
 * if the SDK changes shape again this still resolves the user.
 *
 * `ensureProfile` (default true) runs the lazy profile upsert in its
 * own transaction. Callers that already hold a user transaction
 * (getDashboardData) pass false and do the upsert inside that
 * transaction instead — one database connection per page, not two.
 */
export async function getSessionUser(
  options: { ensureProfile?: boolean } = {},
): Promise<SessionUser | null> {
  if (!isAuthConfigured()) return null;
  const auth = getAuth();
  if (!auth) return null;
  let raw: unknown;
  try {
    raw = await auth.getSession();
  } catch {
    return null;
  }
  const data = (raw as { data?: unknown } | null)?.data ?? raw;
  const user = (data as { user?: { id?: unknown; email?: unknown; name?: unknown } | null } | null)?.user;
  if (!user || typeof user.id !== "string" || !user.id) return null;
  const sessionUser: SessionUser = {
    id: user.id,
    email: typeof user.email === "string" ? user.email : "",
    displayName: typeof user.name === "string" && user.name ? user.name : null,
  };
  // Lazy profile ensure (replaces the old Supabase on_auth_user_created
  // trigger). Best-effort: a failed upsert must never block the request.
  // Only the email is refreshed on conflict — display_name belongs to
  // the user and is edited via PATCH /api/profile.
  if (options.ensureProfile !== false && isDatabaseConfigured()) {
    try {
      await withUser(sessionUser.id, async (db) => {
        await db.query(
          `insert into public.profiles (id, email, display_name)
           values ($1, $2, $3)
           on conflict (id) do update set email = excluded.email`,
          [sessionUser.id, sessionUser.email || null, sessionUser.displayName],
        );
      });
    } catch (error) {
      console.error("[auth] lazy profile ensure failed:", error);
    }
  }
  return sessionUser;
}
