/**
 * Neon data-layer tests — run WITHOUT a live database.
 * They cover: env/config parsing, and migration consistency (every
 * table exists in the SQL file, RLS is forced on it, and no Supabase
 * auth constructs remain). The live-database checks live in
 * db.integration.test.ts and are skipped unless NEXVORA_TEST_DATABASE_URL
 * is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_TABLES, RLS_USER_FUNCTION } from "../db/schema";

describe("db/config", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  async function loadConfig() {
    return import("../db/config");
  }

  it("is not configured when DATABASE_URL is missing", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    const config = await loadConfig();
    expect(config.isDatabaseConfigured()).toBe(false);
    expect(config.getDatabaseUrl()).toBe("");
  });

  it("prefers the pooled DATABASE_URL and falls back to the direct one", async () => {
    process.env.DATABASE_URL = "postgresql://u:p@pooled/db";
    process.env.DATABASE_URL_UNPOOLED = "postgresql://u:p@direct/db";
    const config = await loadConfig();
    expect(config.isDatabaseConfigured()).toBe(true);
    expect(config.getDatabaseUrl()).toBe("postgresql://u:p@pooled/db");

    delete process.env.DATABASE_URL;
    const config2 = await loadConfig();
    expect(config2.getDatabaseUrl()).toBe("postgresql://u:p@direct/db");
  });

  it("requires a cookie secret of at least 32 characters", async () => {
    process.env.NEON_AUTH_BASE_URL = "https://example.neon.tech";
    process.env.NEON_AUTH_COOKIE_SECRET = "too-short";
    const config = await loadConfig();
    expect(config.isAuthConfigured()).toBe(false);

    process.env.NEON_AUTH_COOKIE_SECRET = "a".repeat(32);
    const config2 = await loadConfig();
    expect(config2.isAuthConfigured()).toBe(true);
  });

  it("is not auth-configured when the base URL is missing", async () => {
    delete process.env.NEON_AUTH_BASE_URL;
    process.env.NEON_AUTH_COOKIE_SECRET = "a".repeat(32);
    const config = await loadConfig();
    expect(config.isAuthConfigured()).toBe(false);
  });
});

describe("migration consistency (no live DB)", () => {
  const migration = readFileSync(
    join(process.cwd(), "db/migrations/0001_init.sql"),
    "utf8",
  );

  it("defines all 10 tables", () => {
    for (const table of SCHEMA_TABLES) {
      expect(migration).toContain(`create table public.${table} (`);
    }
  });

  it("forces RLS on every table", () => {
    for (const table of SCHEMA_TABLES) {
      expect(migration).toContain(`alter table public.${table} enable row level security;`);
      expect(migration).toContain(`alter table public.${table} force row level security;`);
    }
  });

  it("defines current_app_user_id() and uses it in the policies", () => {
    expect(migration).toContain("create or replace function public.current_app_user_id()");
    expect(migration).toContain(RLS_USER_FUNCTION);
    expect(migration).not.toContain("auth.uid()");
  });

  it("contains no Supabase auth constructs", () => {
    expect(migration).not.toContain("auth.users");
    expect(migration).not.toContain("on_auth_user_created");
    expect(migration).not.toContain("handle_new_user");
    expect(migration).not.toContain("pgcrypto");
  });

  it("uses text user ids and uuid device/session ids", () => {
    expect(migration).toContain("id text primary key"); // profiles.id
    expect(migration).toContain("owner_id text not null");
    expect(migration).toContain("id uuid primary key default gen_random_uuid()");
  });
});

describe("no Supabase imports remain in app code", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and the test files themselves — this test
        // file necessarily names the patterns it checks for.
        if (entry.name !== "node_modules" && entry.name !== "__tests__") {
          out.push(...walk(full));
        }
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("no source file imports @supabase or lib/supabase", () => {
    const files = [
      ...walk(join(process.cwd(), "app")),
      ...walk(join(process.cwd(), "components")),
      ...walk(join(process.cwd(), "lib")),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (/@supabase|from ["']@\/lib\/supabase|lib\/supabase\//.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
