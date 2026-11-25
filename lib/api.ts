import { NextResponse } from "next/server";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { isAuthConfigured, isDatabaseConfigured, DATABASE_NOT_CONFIGURED_MESSAGE } from "@/lib/db/config";
import { withUser, type DbClient, type QueryResult } from "@/lib/db/client";

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function notConfiguredResponse() {
  return jsonError(DATABASE_NOT_CONFIGURED_MESSAGE, 503);
}

/**
 * Per-request database access, bound to the signed-in user.
 *
 * - `query()` runs one statement in its own transaction with the RLS
 *   session variable set (fail-closed when unset).
 * - `tx()` runs the whole callback in ONE transaction with the RLS
 *   session variable set — use it for multi-step writes that must be
 *   atomic (redeem mark-used + request insert; approve grants +
 *   session + status update).
 */
export interface RequestDb {
  query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  tx<T>(fn: (db: DbClient) => Promise<T>): Promise<T>;
}

function createRequestDb(userId: string): RequestDb {
  return {
    query: <T>(text: string, params?: unknown[]) =>
      withUser(userId, (db) => db.query<T>(text, params)),
    tx: <T>(fn: (db: DbClient) => Promise<T>) => withUser(userId, fn),
  };
}

export interface AuthContext {
  user: SessionUser;
  db: RequestDb;
}

/**
 * Every API route starts here: Neon must be configured (database +
 * auth) AND the caller must have a valid session. Returns null after
 * the caller has already sent the error response — callers must
 * `return` it.
 */
export async function requireAuth(): Promise<
  { ctx: AuthContext } | { response: NextResponse }
> {
  if (!isDatabaseConfigured() || !isAuthConfigured()) {
    return { response: notConfiguredResponse() };
  }
  const user = await getSessionUser();
  if (!user) return { response: jsonError("Not authenticated", 401) };
  return { ctx: { user, db: createRequestDb(user.id) } };
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : null;
}
