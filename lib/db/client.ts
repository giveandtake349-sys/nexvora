import { neonConfig, Pool, type PoolClient } from "@neondatabase/serverless";
import { getDatabaseUrl, isDatabaseConfigured } from "./config";

/**
 * Neon Postgres data access — raw parameterised SQL over the Neon
 * serverless Pool (WebSocket connections).
 *
 * Why raw SQL and not Drizzle: the RLS pattern in this app needs
 * `SET LOCAL app.current_user_id` inside the SAME transaction as the
 * queries that follow. That requires a real, held database connection.
 * The Pool gives us exactly that; the Neon HTTP driver has no
 * interactive transactions, so a Drizzle-over-HTTP setup cannot express
 * this safely. The queries here are simple CRUD, so the extra ORM
 * layer buys nothing.
 *
 * Row Level Security: every query runs inside a transaction that first
 * sets `app.current_user_id` to the validated Neon Auth user id (never
 * from client input). `public.current_app_user_id()` in the migration
 * reads that variable. If it is unset the function returns NULL and
 * every policy denies access (fail-closed). The tables also carry
 * `FORCE ROW LEVEL SECURITY` because the server connects as the table
 * owner, which Postgres would otherwise exempt from RLS.
 *
 * Dates: node-postgres parses timestamptz into JS Date objects. Row
 * shapes in lib/types.ts use ISO strings, so every row is serialised
 * (Date -> ISO string) before it leaves this module.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/** Minimal query interface — routes and helpers only ever see this. */
export interface DbClient {
  query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeValue(v);
    }
    return out;
  }
  return value;
}

function serializeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = serializeValue(v);
  return out as T;
}

class PooledDbClient implements DbClient {
  constructor(private client: PoolClient) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.client.query(text, params as never[]);
    const rows = (res.rows as Record<string, unknown>[]).map(serializeRow<T>);
    return { rows, rowCount: res.rowCount ?? rows.length };
  }
}

let pool: Pool | null = null;

function getPool(): Pool | null {
  if (pool) return pool;
  if (!isDatabaseConfigured()) return null;
  // Node 22+ ships a global WebSocket; the driver uses it when told to.
  // (On older runtimes this assignment is skipped and the driver falls
  // back to its own default.)
  if (typeof WebSocket !== "undefined") {
    neonConfig.webSocketConstructor = WebSocket;
  }
  pool = new Pool({ connectionString: getDatabaseUrl() });
  return pool;
}

/** One held connection, no user context. For system reads only. */
export async function withDb<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (!p) throw new Error("Database is not configured");
  const client = await p.connect();
  try {
    return await fn(new PooledDbClient(client));
  } finally {
    client.release();
  }
}

/**
 * One transaction with the current user id set for RLS. The value comes
 * from the validated Neon Auth session — never from client input.
 * Commits on success, rolls back on any error, always releases the
 * connection.
 */
export async function withUser<T>(
  userId: string,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  const p = getPool();
  if (!p) throw new Error("Database is not configured");
  const client = await p.connect();
  const db = new PooledDbClient(client);
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch {
      // Connection may already be broken; the release below still runs.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Test-only hook: drop the cached pool so config changes take effect. */
export function __resetPoolForTests(): void {
  pool = null;
}
