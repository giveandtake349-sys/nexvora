/**
 * Live-database integration tests — SKIPPED unless NEXVORA_TEST_DATABASE_URL
 * is set. Point it at a THROWAWAY Neon branch/database only: the test
 * applies db/migrations/0001_init.sql and then drops the public schema.
 * Never point it at the production database.
 *
 * Run: NEXVORA_TEST_DATABASE_URL='postgresql://...' npm test -- db.integration
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";
import { withUser } from "../db/client";

const TEST_URL = process.env.NEXVORA_TEST_DATABASE_URL ?? "";
const describeIfLive = TEST_URL ? describe : describe.skip;

describeIfLive("Neon data layer (live DB)", () => {
  let pool: Pool;

  beforeAll(async () => {
    // Point the app's data layer at the test DB too: lib/db/client.ts
    // builds its Pool lazily from DATABASE_URL on first use, so setting
    // the env var here (before any withUser call) routes it correctly.
    process.env.DATABASE_URL = TEST_URL;
    pool = new Pool({ connectionString: TEST_URL });
    const migration = readFileSync(join(process.cwd(), "db/migrations/0001_init.sql"), "utf8");
    // The migration is idempotent enough for a fresh test DB; apply it
    // as one script via a single client.
    const client = await pool.connect();
    try {
      await client.query(migration);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    // Tear the test schema down so a re-run starts clean.
    const client = await pool.connect();
    try {
      await client.query("drop schema public cascade");
      await client.query("create schema public");
    } finally {
      client.release();
    }
    await pool.end();
  });

  it("current_app_user_id() is NULL outside withUser (fail-closed)", async () => {
    const client = await pool.connect();
    try {
      const res = await client.query("select public.current_app_user_id() as uid");
      expect(res.rows[0].uid).toBeNull();
    } finally {
      client.release();
    }
  });

  it("withUser sets the RLS user and the lazy profile upsert works", async () => {
    await withUser("test-user-1", async (db) => {
      await db.query(
        `insert into public.profiles (id, email, display_name)
         values ($1, $2, $3)
         on conflict (id) do update set email = excluded.email`,
        ["test-user-1", "one@example.com", "Test One"],
      );
      const { rows } = await db.query<{ id: string; email: string }>(
        `select id, email from public.profiles where id = $1`,
        ["test-user-1"],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe("one@example.com");
    });
  });

  it("RLS hides another user's devices", async () => {
    // test-user-1 owns a device; test-user-2 must not see it.
    await withUser("test-user-1", async (db) => {
      await db.query(
        `insert into public.devices (owner_id, name, device_fingerprint, platform)
         values ($1, 'User 1 Laptop', 'fp-user-1', 'desktop')`,
        ["test-user-1"],
      );
    });
    const visible = await withUser("test-user-2", async (db) => {
      const { rows } = await db.query<{ name: string }>(
        `select name from public.devices`,
      );
      return rows;
    });
    expect(visible).toHaveLength(0);
  });

  it("a failed transaction rolls back (mark-used + insert atomicity)", async () => {
    await expect(
      withUser("test-user-1", async (db) => {
        await db.query(
          `insert into public.devices (owner_id, name, device_fingerprint, platform)
           values ($1, 'Rollback Device', 'fp-rollback', 'desktop')`,
          ["test-user-1"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const found = await withUser("test-user-1", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from public.devices where device_fingerprint = $1`,
        ["fp-rollback"],
      );
      return rows;
    });
    expect(found).toHaveLength(0);
  });
});
