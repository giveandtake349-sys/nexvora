/**
 * Live-database integration tests — SKIPPED unless NEXVORA_TEST_DATABASE_URL
 * is set. Point it at a THROWAWAY Neon branch/database only: the test
 * applies db/migrations/0001_init.sql and then drops the public schema.
 * Never point it at the production database.
 *
 * Run: NEXVORA_TEST_DATABASE_URL='postgresql://...' npm test -- db.integration
 *
 * Applies 0001_init.sql then 0002_signaling.sql, then drops the public
 * schema in afterAll.
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
    const signaling = readFileSync(join(process.cwd(), "db/migrations/0002_signaling.sql"), "utf8");
    // The migrations are idempotent enough for a fresh test DB; apply
    // them as scripts via a single client, in order.
    const client = await pool.connect();
    try {
      await client.query(migration);
      await client.query(signaling);
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

  it("signaling: new sessions start in 'created' with per-party heartbeats", async () => {
    const session = await withUser("test-user-1", async (db) => {
      const device = await db.query<{ id: string }>(
        `insert into public.devices (owner_id, name, device_fingerprint, platform)
         values ($1, 'Signal Device', 'fp-signal', 'desktop') returning id`,
        ["test-user-1"],
      );
      const { rows } = await db.query<{
        signaling_state: string;
        owner_last_heartbeat_at: string | null;
        participant_last_heartbeat_at: string | null;
      }>(
        `insert into public.remote_sessions
           (device_id, owner_id, participant_user_id, status)
         values ($1, $2, 'test-user-2', 'active')
         returning signaling_state, owner_last_heartbeat_at, participant_last_heartbeat_at`,
        [device.rows[0].id, "test-user-1"],
      );
      return rows[0];
    });
    expect(session.signaling_state).toBe("created");
    expect(session.owner_last_heartbeat_at).toBeNull();
    expect(session.participant_last_heartbeat_at).toBeNull();
  });

  it("signaling: seq increases per message and RLS confines messages to the two parties", async () => {
    // test-user-2 needs a profile row: the FK on recipient_user_id.
    await withUser("test-user-2", async (db) => {
      await db.query(
        `insert into public.profiles (id, email, display_name)
         values ($1, $2, $3)
         on conflict (id) do nothing`,
        ["test-user-2", "two@example.com", "Test Two"],
      );
    });
    const sessionId = await withUser("test-user-1", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from public.remote_sessions
         where owner_id = $1 and participant_user_id = 'test-user-2' limit 1`,
        ["test-user-1"],
      );
      return rows[0].id as string;
    });

    // Sender (owner) inserts two messages for the participant.
    const seqs = await withUser("test-user-1", async (db) => {
      const out: number[] = [];
      for (const kind of ["offer", "ice-candidate"] as const) {
        const { rows } = await db.query<{ seq: number }>(
          `insert into public.signaling_messages
             (session_id, sender_user_id, recipient_user_id, kind, payload)
           values ($1, $2, 'test-user-2', $3, $4::jsonb)
           returning seq`,
          [sessionId, "test-user-1", kind, JSON.stringify({ type: kind })],
        );
        out.push(rows[0].seq);
      }
      return out;
    });
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);

    // Recipient can read both; a third user sees none (RLS).
    const seenByRecipient = await withUser("test-user-2", async (db) => {
      const { rows } = await db.query<{ kind: string }>(
        `select kind from public.signaling_messages where session_id = $1 order by seq asc`,
        [sessionId],
      );
      return rows;
    });
    expect(seenByRecipient.map((r) => r.kind)).toEqual(["offer", "ice-candidate"]);

    const seenByStranger = await withUser("test-user-3", async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `select id from public.signaling_messages where session_id = $1`,
        [sessionId],
      );
      return rows;
    });
    expect(seenByStranger).toHaveLength(0);

    // Heartbeat columns update per party.
    await withUser("test-user-2", async (db) => {
      await db.query(
        `update public.remote_sessions
         set participant_last_heartbeat_at = now() where id = $1`,
        [sessionId],
      );
    });
    const after = await withUser("test-user-1", async (db) => {
      const { rows } = await db.query<{
        owner_last_heartbeat_at: string | null;
        participant_last_heartbeat_at: string | null;
      }>(
        `select owner_last_heartbeat_at, participant_last_heartbeat_at
         from public.remote_sessions where id = $1`,
        [sessionId],
      );
      return rows[0];
    });
    expect(after.participant_last_heartbeat_at).not.toBeNull();
    expect(after.owner_last_heartbeat_at).toBeNull();
  });
});
