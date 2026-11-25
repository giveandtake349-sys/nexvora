# NEXVORA — Supabase → Neon Postgres Adaptation Plan

**Scope:** Milestone 1 only. Read-only analysis — no code was changed, nothing
was deployed, and nothing was tested against a live database.

**Starting point (verified by reading the code):** Milestone 1 is built in
`~/workspace/nexvora/` on Supabase Auth + Supabase Postgres + RLS + Supabase
Storage. Build passes, 20/20 unit tests pass (see `MILESTONE-1-REPORT.md`).

**Target:** Neon Postgres project **"nexvora"** (already exists):
Project ID `shiny-math-25799090`, AWS `ap-southeast-1` (Singapore), Free plan,
Postgres 18, database `nexvora`, default `production` branch.
No connection string or password was available for this analysis — none was
requested, guessed, or tested. Every database-dependent claim below is marked
as needing live verification.

**One-sentence summary:** Neon replaces the *database* cleanly, but Supabase
Auth does not exist on Neon, so the auth layer must be replaced (recommended:
Neon Auth) and every Supabase query-builder call must be rewritten as SQL.
The trusted-device business logic (pairing crypto, grant validity, rate
limiting) does not change at all.

---

## 0. Architecture after the move

| Layer | Before (Supabase) | After (Neon) |
| --- | --- | --- |
| Database | Supabase Postgres | Neon Postgres 18 (same SQL, same tables) |
| Auth | Supabase Auth (GoTrue) | **Neon Auth** (Stack Auth-based) — see §2 |
| Data access | `@supabase/supabase-js` query builder (`supabase.from(...)`) | Neon serverless driver + Drizzle ORM (typed SQL) — see §1.3 |
| Row Level Security | `auth.uid()` in policies | Session variable `app.current_user_id` — see §3.4 |
| File storage | Supabase Storage bucket `file-transfers` | **Deferred to Milestone 4** — no bucket in M1, see §3.5 |
| Sessions | Supabase cookie session, refreshed in `proxy.ts` | Neon Auth SDK session, validated in `proxy.ts` |
| Secrets | `SUPABASE_SERVICE_ROLE_KEY` (server-only) | **Gone.** One Neon `DATABASE_URL` (server-only) — see §4 |

Key facts that drive the whole plan:

- **RLS is plain Postgres, so it works on Neon.** Only the `auth.uid()`
  function is Supabase-specific. Every policy keeps its logic; only the
  "who is the current user" expression changes (§3.4).
- **There is no `auth.users` table on Neon.** The `profiles.id` foreign key
  to `auth.users` and the `on_auth_user_created` trigger must go (§3.2).
- **There is no Supabase Storage on Neon.** Migration `0002_storage.sql`
  references `storage.buckets` / `storage.objects`, which do not exist on
  Neon. It must be deleted, not adapted (§3.5).
- **There is no per-user PostgREST/RLS context on Neon by default.** The
  app currently gets per-user RLS "for free" because Supabase authenticates
  each request's DB connection as that user. On Neon the server connects with
  one app role, so the current user id must be passed explicitly per
  transaction (§3.4). This is the single most subtle part of the move.
- **Every API route already enforces ownership in code** (`requireAuth()` +
  `owner_id = user.id` filters). That layer does not depend on Supabase and
  survives the move unchanged in intent — only its data-access calls change.

---

## 1. Files that must change

Total touched: **42 files — 5 deleted, 25 rewritten, 6 created, 6 copy-only.**
Counts are derived from the file inventory below; verify the count again when
the work is done.

### 1.1 Delete (5 files)

| File | Why |
| --- | --- |
| `lib/supabase/config.ts` | Supabase env-var helpers. Replaced by `lib/db/config.ts`. |
| `lib/supabase/client.ts` | Browser Supabase client. No browser DB client exists on Neon; the browser only calls `/api/*` and the auth SDK. |
| `lib/supabase/server.ts` | Server + service-role Supabase clients. Replaced by `lib/db/client.ts`. |
| `lib/supabase/proxy.ts` | Supabase session refresh. Replaced by Neon Auth session handling in `lib/auth/session.ts`. |
| `supabase/migrations/0002_storage.sql` | References `storage.buckets` / `storage.objects` — does not exist on Neon. Deleted outright, see §3.5. |

The whole `lib/supabase/` directory disappears.

### 1.2 Rewrite — auth + data-access core (6 files)

| File | What changes |
| --- | --- |
| `proxy.ts` (root) | Remove `createServerClient` + `supabase.auth.getUser()`. Use the Neon Auth SDK to validate the session and redirect unauthenticated `/dashboard/*` requests to `/login`. Keep the same matcher and the same "pass through when not configured" behaviour (now keyed on `DATABASE_URL` being set). |
| `lib/api.ts` | `requireAuth()` no longer returns a `SupabaseClient`. It returns `{ ctx: { db, user } }` where `db` is the Neon/Drizzle client (transaction-scoped, with the session variable set — §3.4) and `user` is `{ id, email, displayName }` from Neon Auth. Same contract otherwise: unconfigured → 503, no session → 401. `AuthContext` type changes accordingly. `clientIp()` unchanged. |
| `lib/audit.ts` | Drop the `SupabaseClient` parameter and type import. `logSecurityEvent` / `logSessionEvent` become parameterised SQL inserts into `security_events` / `session_events`. Keep the best-effort rule: a failed audit insert must never break the operation it records. |
| `lib/dashboard-data.ts` | Rewrite the 8 parallel queries as SQL/Drizzle. Keep the returned `DashboardData` shape **exactly** the same (including `configured: boolean` and the empty-state early return) so no dashboard page needs a logic change. `user` becomes the mapped `{ id, email, displayName }` object, not a Supabase `User`. The `.or(owner_id.eq..., participant_user_id.eq...)` query becomes `WHERE owner_id = $1 OR participant_user_id = $1`. |
| `lib/types.ts` | Minor: update the header comment (no longer "Row shapes for the Supabase tables"). Row interfaces are unchanged — the table shapes do not change. `Profile` gains an optional `email` field if §3.2's `email` column is added. |
| `app/auth/callback/route.ts` | Delete or replace. Supabase's `exchangeCodeForSession` has no Neon equivalent. Neon Auth uses its own handler route (path per the Neon Auth / Stack SDK docs — verify at implementation time, commonly `/handler/*`). If the SDK provides the handler, this file is deleted and the handler route is added instead (see §1.4). Keep the same-origin `next` redirect allow-list logic wherever the new callback lives. |

### 1.3 Rewrite — all 11 API routes (data access only; business rules unchanged)

Every route keeps its validation, status codes, and response shape. Only the
`supabase.from(...).select/insert/update/delete` calls become SQL/Drizzle,
and `requireAuth()`'s context changes per §1.2. The `.maybeSingle()` /
`.single()` / `.is("used_at", null)` patterns map to SQL as follows:

- `.maybeSingle()` → `SELECT ... LIMIT 1`, zero rows = `null`.
- `.single()` → `SELECT ... LIMIT 1`, zero rows = error/404 (same as now).
- `.update(...).is("used_at", null)` (redeem replay guard) →
  `UPDATE ... SET used_at = now(), status = 'used' WHERE id = $1 AND used_at IS NULL`
  and check the affected-row count is 1. Same compare-and-swap guarantee.
- `.upsert({id, display_name}, {onConflict: "id"})` (profile route) →
  `INSERT ... ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`.
- `.or(...)` (dashboard sessions query) → plain SQL `OR` (§1.2).

| Route | Supabase-specific points to rewrite |
| --- | --- |
| `app/api/devices/route.ts` (GET/POST/DELETE) | All `.from("devices")` queries; fingerprint/heartbeat logic unchanged; DELETE still revokes grants + ends sessions first, then deletes. |
| `app/api/pairing/generate/route.ts` | `.from("pairing_invitations").insert(...)`; rate limit + `generatePairingCode()` unchanged. |
| `app/api/pairing/redeem/route.ts` | Lookup by `code_hash`, `checkPairingUsability`, mark-used-first (see SQL mapping above), then insert `connection_requests`. **Atomicity note:** the mark-used update and the request insert should run in one DB transaction; today they are two separate Supabase calls with the `used_at IS NULL` guard as the safety net. In the Neon version, wrap both in `db.transaction()` and keep the guard. |
| `app/api/connection-requests/route.ts` | List query. |
| `app/api/connection-requests/[id]/approve/route.ts` | Grant inserts (one row per scope), session insert, request status update. Wrap grant + session + status update in one transaction (today they are three separate calls; a failure mid-way could leave grants without a session — the Neon rewrite should fix this). |
| `app/api/connection-requests/[id]/reject/route.ts` | Status update. |
| `app/api/permissions/route.ts` (GET/POST/DELETE) | Grant list/insert/revoke. **DELETE is the service-role case:** it currently uses `createServiceSupabaseClient()` to end the other user's sessions past RLS. On Neon there is no service-role key — the server connection already has full access, so the privileged update is done with the same `db` client inside the request transaction, with the ownership check (`owner_id = user.id`) done in code first. No separate client is needed. |
| `app/api/permissions/revoke-device/route.ts` | Same service-client point as above. |
| `app/api/sessions/disconnect/route.ts` | Session lookup + status update; parties check (`owner_id` / `participant_user_id`) stays in code. |
| `app/api/sessions/disconnect-all/route.ts` | Bulk session-end update. |
| `app/api/profile/route.ts` | Profiles upsert (SQL mapping above). **Delete the `supabase.auth.updateUser({data:{display_name}})` call** — there is no Supabase Auth user to sync. Display name lives only in `profiles` (and in the Neon Auth user record via the SDK if desired — optional, verify SDK support). |

**Recommended data-access choice: Drizzle ORM over the Neon serverless
driver** (`drizzle-orm` + `@neondatabase/serverless`, `drizzle-kit` as a dev
dependency). Reasons: typed queries (catches the column renames at build
time), `db.transaction()` for the redeem/approve atomicity above, and it works
with Neon's HTTP driver on Vercel serverless (no long-lived connections).
Alternative — raw SQL through `@neondatabase/serverless` only — is also
acceptable and has fewer dependencies; the queries here are simple CRUD.
Either way, keep the raw-SQL migrations in §3 as the source of truth for the
schema (do not let an ORM generate the schema).

### 1.4 Rewrite — auth UI (2 files)

| File | What changes |
| --- | --- |
| `components/AuthForms.tsx` | Every `supabase.auth.*` call is replaced by the Neon Auth SDK equivalent: `signInWithPassword` → SDK email/password sign-in; `signUp` (with `display_name` metadata + `emailRedirectTo`) → SDK sign-up + email verification flow; `signInWithOAuth({provider:"google"})` → SDK Google sign-in (redirect target stays `/auth/callback?next=/dashboard` in spirit — actual callback path per SDK docs); `resetPasswordForEmail` → SDK password-reset request; `updateUser({password})` → SDK password update inside a verified reset session. Keep the same forms, the same `ConfigNotice` early return (now keyed on DB configured state), and the same user-facing copy. |
| `components/DashboardShell.tsx` | `signOut()` calls the Neon Auth SDK sign-out instead of `supabase.auth.signOut()`, then the same `router.push("/login")` + refresh. Nav and layout unchanged. |

### 1.5 Rewrite — config, docs, migrations (6 files)

| File | What changes |
| --- | --- |
| `package.json` | Remove `@supabase/ssr`, `@supabase/supabase-js`. Add `@neondatabase/serverless`, `drizzle-orm`, and the Neon Auth SDK (package name per current Neon Auth docs — verify at install time). Add `drizzle-kit` to devDependencies. Scripts (`dev`, `build`, `start`, `lint`, `test`) unchanged. |
| `.env.example` | Full rewrite — see §4. |
| `README.md` | Rewrite the Stack, Quick start, Full setup (§1–§4), and Vercel sections for Neon: create project (already done), `DATABASE_URL`, run migrations with `psql` / Neon SQL Editor, Neon Auth setup + Google OAuth in the Neon dashboard, redirect/callback URLs. Keep the "How the Trusted Device system works" section (it is provider-independent). |
| `docs/limitations.md` | Replace Supabase references: "builds and renders with no Supabase project" → "no Neon DATABASE_URL"; service-role key paragraph → `DATABASE_URL` handling; add: storage bucket deferred to Milestone 4 (§3.5), RLS session-variable pattern (§3.4), rate-limit note stays as-is. |
| `supabase/migrations/0001_init.sql` → `db/migrations/0001_init.sql` | Move + adapt — see §3. Rename the directory `supabase/` → `db/` so the tree stops implying Supabase. |
| `supabase/seed.sql` → `db/seed.sql` | SQL body unchanged (profile/device inserts work without `auth.users`). Update the header: UUIDs must be replaced with real **Neon Auth** user ids, and it runs in the Neon SQL Editor / `psql`, not the Supabase SQL Editor. Still demo-only, never on production. |

### 1.6 Create (6 files)

| File | Purpose |
| --- | --- |
| `lib/db/config.ts` | `getDatabaseUrl()`, `isDatabaseConfigured()`, `DATABASE_NOT_CONFIGURED_MESSAGE` (mirrors the old `lib/supabase/config.ts` contract so the "honest unconfigured state" survives: app builds/renders with no `DATABASE_URL`, auth/data surfaces show the message and disable forms). |
| `lib/db/client.ts` | Neon/Drizzle client singleton + `withUser(userId, fn)` transaction helper that runs `SET LOCAL app.current_user_id` then the callback (§3.4). All server data access goes through this file — no route imports the driver directly. |
| `lib/db/schema.ts` | Drizzle table definitions mirroring `0001_init.sql` (only if Drizzle is chosen; otherwise fold the types into `lib/types.ts` and skip this file). |
| `lib/auth/session.ts` | `getSessionUser()` — server-side current-user lookup via the Neon Auth SDK; maps the SDK user to `{ id, email, displayName }` and lazily ensures the `profiles` row exists (replaces the `handle_new_user` trigger, §3.2). Used by `lib/api.ts` and `lib/dashboard-data.ts`. |
| `app/handler/[...stack]/page.tsx` (name per SDK docs) | Neon Auth handler route (sign-in / callback / sign-out pages) — only if the chosen SDK requires it. Verify the exact path in the Neon Auth docs at implementation time. |
| `lib/__tests__/db.integration.test.ts` | Integration tests for the SQL layer — see §5. Skipped automatically when `DATABASE_URL` is absent. |

### 1.7 Copy-only changes (6 files — no logic changes)

| File | Change |
| --- | --- |
| `components/ui.tsx` | `ConfigNotice` copy: "Supabase not configured" → "Database not configured", message from `lib/db/config.ts`. |
| `app/page.tsx` | Landing copy: "no Supabase project is configured yet" → Neon wording. `isSupabaseConfigured()` → `isDatabaseConfigured()`. |
| `app/dashboard/page.tsx` | One line: "Once Supabase is configured…" → Neon wording. |
| `app/dashboard/security/page.tsx` | One line: "Login history is recorded from Supabase Auth events…" → "…from Neon Auth events via the security audit log". |
| `app/dashboard/settings/page.tsx` | One line: "Email verification and password changes go through Supabase Auth" → "…go through Neon Auth". |
| `next.config.ts` | Comment only: "dashboard pages read the Supabase session from cookies" → "read the Neon Auth session from cookies". |
| `MILESTONE-1-REPORT.md` | Historical record — **do not rewrite**. Append a short addendum section noting the Neon move and pointing at this plan + the new adaptation report. |

### 1.8 Unchanged (no edits needed)

- `lib/pairing.ts`, `lib/permissions.ts`, `lib/rate-limit.ts`, `lib/device.ts`
  — pure logic, zero Supabase imports. (Pairing: 256-bit secret, 6-digit
  derived code, SHA-256 hashes, 10-min expiry, single-use check.
  Permissions: 8 scopes, `checkGrantValidity`, `splitScopesByValidity`,
  30-day default expiry. Rate limit: in-memory fixed window.
  Device: 5-min online threshold, User-Agent parsing, fingerprint hash.)
- `lib/__tests__/pairing.test.ts`, `permissions.test.ts`,
  `rate-limit.test.ts`, `device.test.ts` — the 20 existing unit tests. They
  must pass unchanged after the move.
- All 9 dashboard page components' logic (they consume `getDashboardData()`;
  only the copy lines in §1.7 change).
- `components/DashboardActions.tsx` — calls `/api/*` via fetch; no Supabase
  reference found in it.
- `app/layout.tsx`, `app/globals.css`, brand components, `next-env.d.ts`,
  `tsconfig.json`, `eslint.config.mjs`, `.gitignore`, `vitest.config.ts`.

---

## 2. Auth options compared

Feature requirements (from what M1 actually uses): email registration,
email verification, email/password login, Google OAuth, password recovery,
secure logout, editable profile (display name), protected dashboard, server
session validation on every API call.

### (a) Neon Auth (Stack Auth-based) — RECOMMENDED

- **What it is:** Neon's managed auth, built on Stack Auth, designed to run
  against your Neon Postgres. Users are stored in your own Neon database
  (in a `neon_auth` schema — verify the exact schema/table names in the
  current Neon Auth docs at implementation time).
- **Feature fit:** email/password sign-up + login, email verification,
  password reset, Google OAuth, and other OAuth providers, session
  management (JWT sessions), and a Next.js SDK with server-side
  `getUser()`-style helpers — i.e. a ~1:1 replacement for every Supabase
  Auth call M1 makes. No extra email service to set up: verification and
  reset emails are handled by the auth provider.
- **Why it wins here:** one system to operate (the user already has the Neon
  project), least new code, no password hashing or token tables to own, no
  SMTP account (Resend etc.) to create. The user is non-technical and wants
  the project ready — this is the shortest path to a working login.
- **Risks / honest caveats:** newer product than Auth.js, SDK and dashboard
  behaviour may change; exact env-var names, handler-route path, and the
  RLS-wiring pattern must be verified against the current Neon Auth docs
  during implementation (they were not verified in this read-only analysis);
  auth is coupled to Neon/Stack Auth — leaving Neon later means migrating
  auth too. Free-tier limits should be checked in the Neon dashboard before
  relying on them.

### (b) Auth.js / NextAuth v5 (self-hosted, Postgres adapter) — FALLBACK

- **What it is:** mature, self-hosted auth library. Database sessions (or
  JWT) stored in your Neon DB via the Postgres/Drizzle adapter, Credentials
  provider (email/password) + Google provider.
- **Feature fit:** login/logout/sessions and Google OAuth are built in.
  **Email verification and password reset are not:** you must build them —
  a verification-token table, a password-reset-token table, token expiry +
  single-use checks, and an email sender (Resend or another SMTP provider —
  another account, another API key, another thing that can break). Password
  hashing (bcrypt/scrypt) must be implemented correctly, including the
  `users` table gaining a `password_hash` column.
- **Why it is second:** more code to write, test, and maintain; more
  services to configure; larger security surface owned by this codebase
  (token handling, hashing, email delivery). Its advantages are maturity,
  portability (no vendor lock-in), and full control — valuable, but not what
  this project needs most right now.
- **Use it if:** Neon Auth setup fails, its free tier does not cover the
  need, or the user explicitly wants auth fully self-hosted.

### (c) Hybrid — keep Supabase Auth only, data on Neon — NOT RECOMMENDED

- **What it is:** a Supabase project used purely as the auth provider
  (GoTrue) while all 10 app tables live on Neon. The app would keep
  `supabase.auth.*` calls and replace only the data-access calls.
- **Why it is not sensible:** two systems to operate and pay for; two user
  stores to keep in sync; `profiles.id` would hold Supabase user UUIDs with
  **no foreign key enforcement** (there is no `auth.users` table on Neon to
  reference); if the Supabase project is deleted or its keys rotate, auth
  breaks while the data is fine; and it defeats the stated reason for the
  move (one stack on Neon). It also keeps a Supabase dependency the user
  explicitly moved away from.
- **Only legitimate use:** a temporary bridge during a staged migration
  (auth moves last). M1 is small enough to move auth in one step, so even
  the bridge is unnecessary.

**Recommendation: (a) Neon Auth.** If its setup hits a blocker, fall back to
(b) Auth.js. Do not do (c) except as a deliberate, time-boxed bridge — and
do not start with it.

Session handling after the move (option (a)): the Neon Auth SDK manages the
session cookie; `proxy.ts` validates the session server-side on each request
and redirects unauthenticated `/dashboard/*` traffic to `/login`; API routes
call `getSessionUser()` (new `lib/auth/session.ts`) instead of
`supabase.auth.getUser()`. Session lifetime/refresh is the SDK's job — do not
hand-roll token refresh.

---

## 3. Migration changes

Move `supabase/migrations/` → `db/migrations/` and `supabase/seed.sql` →
`db/seed.sql`. Run them with `psql` (unpooled connection string) or the Neon
SQL Editor, on the `production` branch. **Do not run them twice** — they use
`create table` without `if not exists` (same as today); re-running would
error. Record the applied state (Neon has no built-in migration tracker
unless Drizzle Kit is used — if Drizzle is chosen, `drizzle-kit push` /
`migrate` can own this instead).

### 3.1 What stays exactly as-is in `0001_init.sql`

- All 10 tables, all columns, all indexes, all constraints — except
  `profiles.id` (§3.2).
- `set_updated_at()` function and its triggers.
- `text[]` for `requested_scopes`, `jsonb` for `details`, `inet` for
  `ip_address`, the partial unique index on `device_permissions`, all CHECK
  constraints — all supported on Postgres 18 / Neon.
- `gen_random_uuid()` is built into Postgres since v13. The line
  `create extension if not exists pgcrypto;` is unnecessary on PG18 — remove
  it (Neon does allow `pgcrypto`, but nothing in the schema uses it).

### 3.2 `profiles` — the one structural change

```sql
-- BEFORE (Supabase):
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- AFTER (Neon):
create table public.profiles (
  id uuid primary key,               -- Neon Auth user id; NO FK (no auth.users on Neon)
  email text,                        -- NEW, nullable: copy of the auth email for display;
                                     -- filled by the lazy profile-ensure in lib/auth/session.ts
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

- **Delete** the `handle_new_user()` function and the
  `on_auth_user_created` trigger on `auth.users` entirely.
- **Replace the trigger with app-side profile creation:** on first
  authenticated request, `getSessionUser()` upserts the `profiles` row
  (`id` = Neon Auth user id, `email`, `display_name` from the auth
  profile). `PATCH /api/profile` already upserts by `id`, so it works
  unchanged once the id source is Neon Auth. (Alternative: a Neon Auth
  webhook that creates the profile — only if the SDK/docs support it
  cleanly; the app-side upsert is simpler and already half-built.)
- All other tables' FKs to `public.profiles (id)` stay exactly as they are.

### 3.3 RLS policies — same logic, different current-user expression

RLS stays **enabled on all 10 tables** (the spec requires it). Every
`auth.uid()` becomes `public.current_app_user_id()`:

```sql
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid;
$$;
```

Then, mechanically, in every policy: `auth.uid()` →
`public.current_app_user_id()`. Example:

```sql
-- BEFORE:
create policy "devices_owner_all" on public.devices
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- AFTER:
create policy "devices_owner_all" on public.devices
  for all using (owner_id = public.current_app_user_id())
  with check (owner_id = public.current_app_user_id());
```

Policy names, tables, and logic are otherwise unchanged — including the
`pairing_invitations_redeem_select` policy (any authenticated user may select
an active, unexpired invitation, found only by its SHA-256 `code_hash`).

### 3.4 The session-variable mechanism (read this before implementing)

On Supabase, each request's DB connection is authenticated as the user, so
`auth.uid()` just works. On Neon the server connects with **one app role**,
so the app must tell Postgres who the user is on every transaction:

1. The server — and only the server — runs
   `SET LOCAL app.current_user_id = '<uuid>'` at the start of every DB
   transaction that touches user data. The value comes from the validated
   Neon Auth session, **never** from client input.
2. `SET LOCAL` is transaction-scoped, so it must run inside the same
   transaction as the queries. That is why `lib/db/client.ts` exposes a
   `withUser(userId, fn)` helper and every route goes through it.
   With the Neon HTTP driver, use a transaction (Drizzle `db.transaction()`
   or the driver's transaction support) — a bare `SET LOCAL` issued as a
   standalone HTTP query will **not** persist to the next query.
3. Fail-closed: if the variable is unset, `current_app_user_id()` returns
   `NULL` and every policy comparing `owner_id = NULL` denies access.
   Verify this behaviour explicitly in the test plan (§5) — a silent
   fail-open here would be a security hole.
4. Connection strings: use the **pooled** Neon URL for normal queries and
   the **direct (unpooled)** URL for migrations. Transactions carrying
   `SET LOCAL` must be verified against the pooled endpoint during
   implementation — if PgBouncer transaction pooling interferes, run
   user-scoped transactions on the direct URL instead and record the
   decision.
5. The service-role concept disappears: the server connection already has
   full access. The privileged session-ending updates in
   `app/api/permissions/*` (§1.3) run on the same connection inside the
   request transaction, after the code-level ownership check.

### 3.5 What replaces the file-transfers storage bucket

**Nothing in Milestone 1.** The bucket was placeholder-only (no transfer flow
exists in M1), so deleting `0002_storage.sql` loses no functionality:

- Keep the `file_transfers` table and its RLS policies from `0001_init.sql`
  (they reference only `public` tables).
- Keep the `storage_path text` column (nullable) as the future pointer to
  the stored object.
- At Milestone 4, choose the object store then — current candidates:
  Vercel Blob (simplest on this stack), Cloudflare R2, or S3-compatible
  storage. Do not pick one now; record the decision in
  `docs/limitations.md` with the note "bucket deferred to Milestone 4".
- Do **not** try to recreate Supabase Storage semantics in Postgres.

---

## 4. Environment variables

### Remove

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

No Supabase values remain anywhere: not in code, not in `.env.example`, not
in Vercel project settings (remove the old Vercel vars when the new ones are
set, so a stale key cannot be used by accident).

### Add (placeholders only — never put real values in code, chat, or git)

```
# Server-only. Pooled Neon connection string for the app runtime.
# Contains the database password: NEVER prefix with NEXT_PUBLIC_,
# NEVER commit, NEVER paste into chat.
DATABASE_URL=postgresql://<user>:<password>@<host>/<database>?sslmode=require

# Server-only. Direct (unpooled) Neon connection string, for migrations
# (psql / drizzle-kit). Same secrecy rules as DATABASE_URL.
DATABASE_URL_UNPOOLED=postgresql://<user>:<password>@<host>/<database>?sslmode=require

# Neon Auth (option (a)). Exact variable names to be verified against the
# current Neon Auth docs at implementation time.
NEXT_PUBLIC_STACK_PROJECT_ID=
NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY=
STACK_SECRET_SERVER_KEY=

# Base URL of this app (http://localhost:3000 for local dev).
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### Keep

- `NEXT_PUBLIC_APP_URL` (unchanged).
- If the Auth.js fallback (option (b)) is chosen instead, the Neon Auth
  vars are replaced by `AUTH_SECRET=` plus the Google OAuth
  `AUTH_GOOGLE_ID=` / `AUTH_GOOGLE_SECRET=` and an SMTP provider's keys
  (e.g. Resend) — another reason option (a) is simpler.

### Rules that do not change

- `.env.local` is git-ignored and never committed; `.env.example` holds
  placeholders only.
- `DATABASE_URL` is server-only. If it is ever exposed, rotate the password
  in the Neon dashboard and update `.env.local` + Vercel immediately.
- Vercel needs the same vars in its project settings, with
  `NEXT_PUBLIC_APP_URL` set to the deployed URL.

---

## 5. Test plan (to run once a connection string is available)

**Nothing in this section is verified yet.** The 20 existing unit tests were
not re-run against Neon and no live check was performed — there is no
connection string. Run in this order:

### 5.1 Static checks (no database needed)

1. `npm run build` — must pass, TypeScript strict, 0 errors.
2. `npm run lint` — 0 errors, 0 warnings.
3. `npm test` — the 20 existing unit tests (pairing, permissions,
   rate-limit, device) must pass **unchanged**.
4. `grep -r "supabase\|Supabase" --include="*.ts" --include="*.tsx" --include="*.sql" app components lib db` —
   must return zero matches except the historical note in
   `MILESTONE-1-REPORT.md` and this plan file.
5. `grep -r "auth\.uid\|auth\.users" db/migrations/` — must return zero
   matches.

### 5.2 Migration checks (Neon SQL Editor or `psql`, unpooled URL)

6. Apply `db/migrations/0001_init.sql` to the `nexvora` database on the
   `production` branch. Confirm: 10 tables exist, RLS is enabled on all 10,
   all policies reference `current_app_user_id()`, the `profiles` table has
   no FK to `auth.users`, and there is no `handle_new_user` function or
   `on_auth_user_created` trigger.
7. Confirm `0002_storage.sql` is gone and nothing references
   `storage.buckets` / `storage.objects`.

### 5.3 Integration tests (new file `lib/__tests__/db.integration.test.ts`)

Skipped automatically when `DATABASE_URL` is absent. Against a scratch
Neon branch (create a `dev` branch in the Neon dashboard — do not test
against `production`):

8. Sign-up creates a `profiles` row (lazy ensure) with the Neon Auth id.
9. Pairing: generate → redeem → approve a **subset** of scopes → session
    visible to both users → grant reuse on reconnect (no second approval).
10. Redeem replay: redeeming the same code twice fails the second time.
11. Expired code (10-min TTL) fails.
12. Revocation: revoke one scope → grant invalid + active session ended;
    revoke whole device → all grants revoked + sessions ended.
13. **RLS fail-closed checks (most important):** with the session variable
    set to user B, a direct `SELECT * FROM devices` returns only B's rows;
    with the variable **unset**, the same query returns zero rows; user B
    cannot `SELECT` user A's `device_permissions` or `security_events`.
14. Rate limit: 6th pairing attempt within 10 minutes → 429.

### 5.4 Two-account end-to-end (manual, same script as the M1 report)

15. Two test accounts (A = owner, B = guest). A registers a device and
    generates a code; B redeems it requesting 3 scopes; A approves 2;
    verify B sees the session and the 2 granted scopes, and the 3rd scope
    is not granted; A revokes 1 scope and verifies B's session ends.
16. Unauthenticated `/dashboard` redirects to `/login`; API call without a
    session → 401; API call as B against A's device → 403/404.
17. Google OAuth sign-in works end-to-end; email verification link works;
    password-reset link works (all via Neon Auth).
18. Deploy to Vercel with the production env vars; repeat steps 15–17
    against the deployed URL; set `NEXT_PUBLIC_APP_URL` to the deployed URL
    and confirm the Neon Auth callback/redirect allow-list includes it.

### 5.5 Regression gates before calling it done

- All §5.1–§5.4 checks pass; any failure is recorded with its cause, not
  worked around silently.
- Write a `NEON-ADAPTATION-REPORT.md` (same format as
  `MILESTONE-1-REPORT.md`: files changed, migrations applied, env vars,
  tests passed/failed, limitations, next steps).
- Only then update the todo/goal state to "running on Neon".

---

## 6. What stays UNCHANGED

- **Pairing crypto** (`lib/pairing.ts`): 256-bit secret, 6-digit derived
  code, SHA-256 hashes only, 10-minute expiry, single-use semantics,
  replay prevention. No edits.
- **Permission logic** (`lib/permissions.ts`): 8 scopes, per-scope grant
  rows, 30-day default expiry, `checkGrantValidity` /
  `splitScopesByValidity`, re-approval only on new scope / device change /
  expiry / revocation / security event. No edits.
- **Rate limiting** (`lib/rate-limit.ts`): in-memory fixed window, 5 per
  user per 10 minutes. No edits (the documented multi-instance caveat
  stands; moving it to Postgres is a later hardening item, not part of
  this move).
- **Device helpers** (`lib/device.ts`): online threshold, User-Agent
  parsing, fingerprint hashing. No edits.
- **All 20 existing unit tests.** No edits.
- **UI pages and brand system.** Dashboard pages, Remote Access cards
  (still honestly Disconnected — no live media in M1), landing page,
  sidebar/bottom nav, colours, logo. Only the copy lines in §1.7 change.
- **Database table shapes.** Same 10 tables, same columns (plus the
  optional `profiles.email`), same indexes and constraints, same RLS
  policy logic.
- **The Trusted Device rules themselves.** Owner picks scopes; grants are
  stored server-side; valid grants are reused on reconnect; revocation is
  immediate and ends sessions; every grant/change/revocation is audit
  logged; NEXVORA authorisation stays separate from OS/browser consent.
  None of that changes — only the plumbing underneath it does.

---

## 7. What this plan could NOT verify (honest gaps)

- **No live database was touched.** No connection string exists in this
  analysis. The migration SQL was read, not executed, against Postgres 18
  on Neon. Syntax is standard Postgres and expected to run, but "expected"
  is not "verified".
- **Neon Auth specifics were not verified against current docs:** exact
  package name, env-var names, handler-route path, how user ids surface
  server-side, whether a `neon_auth.users` table can be referenced, free-tier
  limits, and the documented RLS integration pattern. These must be checked
  in the Neon Auth docs at implementation time; if the docs contradict
  anything in §2/§3, the docs win and this plan should be corrected.
- **Pooled vs direct URL behaviour for `SET LOCAL` transactions** (§3.4
  item 4) is a known unknown — it must be tested in §5.3 step 13/14, not
  assumed.
- **Drizzle vs raw SQL** (§1.3) is a recommendation, not a tested choice.
- **Google OAuth client setup** in the Neon Auth dashboard and **email
  deliverability** of Neon Auth verification/reset emails were not checked.
- **The GitHub repo state** (`giveandtake349-sys/nexvora`) was not part of
  this analysis; the parent agent owns the push/deploy steps.

## 8. Suggested implementation order

1. Create a scratch `dev` branch in the Neon dashboard (never test
   migrations on `production` first).
2. Install Neon Auth SDK + Drizzle + Neon driver; delete `lib/supabase/`.
3. Add `lib/db/*` + `lib/auth/session.ts`; rewrite `proxy.ts`, `lib/api.ts`,
   `lib/audit.ts`, `lib/dashboard-data.ts`.
4. Adapt `db/migrations/0001_init.sql`; apply to the `dev` branch; run the
   §5.2 checks.
5. Rewrite the 11 API routes, then `AuthForms.tsx` + `DashboardShell.tsx`.
6. `npm run build` + `npm test` (20 unit tests green) → write the §5.3
   integration tests → run the §5.4 two-account script.
7. Update `.env.example`, `README.md`, `docs/limitations.md`; delete
   `0002_storage.sql`; append the addendum to `MILESTONE-1-REPORT.md`.
8. Apply the migration to the `production` branch, set Vercel env vars,
   deploy, re-run §5.4 against the deployed URL, write
   `NEON-ADAPTATION-REPORT.md`.
