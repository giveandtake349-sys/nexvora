# NEXVORA — Milestone 1 Neon Adaptation Report

**Date:** Nov 25, 2026
**Scope:** Adapt the Supabase-based Milestone 1 code to Neon Postgres +
Managed Better Auth (Neon Auth), per `NEON-ADAPTATION-PLAN.md`.
**Status:** Code complete and verified locally (build / tests / lint /
smoke test all pass). **Live-database verification is still pending** —
no connection string was available, so the migration has not been
applied to Neon and no end-to-end test has run against a real database.

## 1. What changed (summary)

| Area | Before (Supabase) | After (Neon) |
| --- | --- | --- |
| Auth | Supabase Auth (`@supabase/ssr`, `@supabase/supabase-js`) | Managed Better Auth via `@neon/auth@0.8.2` |
| Database | Supabase Postgres via Supabase JS client | Neon Postgres via `@neondatabase/serverless@1.2.1` Pool, raw parameterised SQL |
| RLS identity | `auth.uid()` | `public.current_app_user_id()` reading `app.current_user_id`, set per transaction with `SET LOCAL` |
| RLS enforcement | plain `ENABLE ROW LEVEL SECURITY` | `ENABLE` **+ `FORCE` ROW LEVEL SECURITY on all 10 tables** (see §3) |
| User ids | `uuid`, FK to `auth.users` | **text** (Better Auth opaque ids), no auth FK |
| Profiles | created by `on_auth_user_created` trigger | created by app-side lazy upsert in `lib/auth/session.ts` |
| Middleware | `middleware.ts` (deprecated) | `proxy.ts` (Next 16 convention, confirmed in `node_modules/next/dist/docs/`) |
| Storage | `0002_storage.sql` bucket + policies | deleted — storage deferred to Milestone 4 |
| Migrations | `supabase/migrations/` | `db/migrations/0001_init.sql`; seed moved to `db/seed.sql` |

## 2. Verified Neon Auth facts (docs + shipped package, Nov 25, 2026)

Sources: https://neon.com/docs/auth/quick-start/nextjs-api-only (updated
2026-11-06), https://neon.com/docs/auth/migrate/from-legacy-auth,
https://neon.com/docs/guides/rls-tutorial, and the shipped
`@neon/auth@0.8.2` package (tarball inspected; runtime `dist/server.js`,
`dist/next/server/index.d.ts`, `dist/next/index.d.ts`).

- **Plan correction (important):** the plan's recommendation (a), "Neon
  Auth (Stack Auth-based)", is **legacy — closed to new users** (Neon
  docs, updated 2026-10-30). The current product is **Managed Better
  Auth**. The implementation follows the current docs, not the plan.
- Package: `npm install @neon/auth@latest` → installed `0.8.2`
  (peers react ≥18, react-dom ≥18, next ≥16 — satisfied by React 19.3 /
  Next 16.4.6).
- Env vars: `NEON_AUTH_BASE_URL` (branch Auth URL) and
  `NEON_AUTH_COOKIE_SECRET` (≥32 chars; the SDK throws at startup if
  shorter — hence lazy `createNeonAuth` in `lib/auth/server.ts`).
- Server: `createNeonAuth` from `@neon/auth/next/server` →
  `.handler()`, `.middleware({ loginUrl, publicRoutes })`, `.getSession()`.
- **Handler shape (found by the build, not the guide):**
  `auth.handler()` returns an **object** `{ GET, POST, PUT, PATCH, DELETE }`
  — it is not itself callable. Each method takes `(request, { params })`.
  The route in `app/api/auth/[...path]/route.ts` delegates per method and
  answers 503 when auth is unconfigured.
- **Server `getSession()` shape (verified in shipped `dist/server.js`):**
  returns `{ data: { session, user } | null, error }`. The SDK's bundled
  `NEXT-JS.md` guide shows the bare `{ session, user }` shape instead —
  `lib/auth/session.ts` normalises both.
- **Client methods (verified by tsc type probe against the shipped
  types):** `signUp.email({ email, password, name })`,
  `signIn.email({ email, password })`,
  `signIn.social({ provider: 'google', callbackURL })`, `signOut()`,
  `resetPassword({ newPassword, token })`, `updateUser({ name })`,
  `useSession()`, `getSession()`.
- **Password-reset rename (better-auth 1.7):** the `/forget-password`
  route was removed; the client method is now
  `requestPasswordReset({ email, redirectTo })`. The Neon client's
  `forgetPassword` is only the email-OTP namespace (`{ emailOtp }`) and
  is not callable — the forgot-password form uses `requestPasswordReset`.
  (Confirmed by tsc probe + better-auth 1.7 changelog notes.)
- Users live in the `neon_auth` schema in your own database.

## 3. Deviations from the plan (all deliberate, all documented)

1. **Auth product:** Stack Auth-based Neon Auth → Managed Better Auth
   (see §2 — the plan's recommendation is legacy).
2. **User ids are text, not uuid.** Better Auth `User.id` is a string;
   the official Neon RLS tutorial uses `text("owner_id")` +
   `auth.user_id()`. All user-id columns in the migration are `text`;
   device/session/request ids stay `uuid`. `current_app_user_id()`
   returns `text`. (Plan §3.2 assumed uuid user ids.)
3. **Data access is raw SQL via `@neondatabase/serverless` Pool, not
   Drizzle.** The plan allows raw SQL; Drizzle's neon-http driver has no
   interactive transactions and `SET LOCAL` needs a real held
   connection. The Pool gives deterministic transactions.
4. **FORCE ROW LEVEL SECURITY on all 10 tables.** The plan missed this:
   the app connects as the table owner, and Postgres exempts the table
   owner from plain RLS — without FORCE, RLS would silently not apply.
5. **`pgcrypto` extension line removed.** `gen_random_uuid()` is built
   into Postgres 13+ (Neon runs Postgres 18).
6. **`profiles` gained an `email` column.** The lazy upsert keeps the
   profile email in sync with the auth session (the old Supabase trigger
   derived the display name from the email; the new flow stores the
   email directly). Nullable, no behaviour change elsewhere.
7. **Re-approval of an already-live grant refreshes its expiry**
   (`ON CONFLICT ... DO UPDATE`) instead of failing on the partial
   unique index. The old Supabase code would 500 in that case.
8. **Display-name update is two-step:** the settings form calls
   `authClient.updateUser({ name })` first (the auth record is the
   source of truth for the name shown in the dashboard), then
   `PATCH /api/profile` syncs the profile row. The old server-side
   `supabase.auth.updateUser` call has no Neon equivalent.
9. **`proxy.ts` drops the `?next=` redirect parameter.** The SDK
   middleware redirects to `/login` without appending the original path;
   after sign-in the login form falls back to `/dashboard`.
10. **`getDatabaseUrl()` falls back to `DATABASE_URL_UNPOOLED`** when the
    pooled URL is unset, so a deployment with a single connection string
    still works.
11. **Approve/reject/permission/session routes keep their exact old
    behaviour** (body field `scopes`, 30-day default grant expiry via
    `defaultGrantExpiry()`, `decided_at`, 409 for already-decided,
    404 for not-owner, `{ ok: true, session, approvedScopes }` on
    approve, audit action names unchanged) — the only changes are the
    data-access layer and the new transaction wrapping.

## 4. Files created / modified / deleted

### Created (8)
- `lib/db/config.ts` — DATABASE_URL / DATABASE_URL_UNPOOLED /
  NEON_AUTH_BASE_URL / NEON_AUTH_COOKIE_SECRET helpers,
  `isDatabaseConfigured()`, `isAuthConfigured()` (≥32-char secret check),
  not-configured messages.
- `lib/db/client.ts` — Neon Pool, `withUser()` (transaction + `SET
  LOCAL app.current_user_id`, commit/rollback, fail-closed),
  `withDb()`, Date→ISO row serialisation.
- `lib/db/schema.ts` — table registry used by the migration-consistency
  test.
- `lib/auth/server.ts` — lazy `getAuth()` (never throws at import when
  unconfigured).
- `lib/auth/client.ts` — `createAuthClient()` from `@neon/auth/next`
  (same-origin `/api/auth/*` proxy, no keys in the browser).
- `lib/auth/session.ts` — `getSessionUser()` (shape-normalised) + lazy
  profile upsert (email refreshed on conflict, display_name never
  overwritten).
- `app/api/auth/[...path]/route.ts` — Better Auth handler route, 503
  fallback when unconfigured.
- `lib/__tests__/db.integration.test.ts` — live-DB tests, skipped unless
  `NEXVORA_TEST_DATABASE_URL` is set (see §6).

### Modified (25)
- `package.json` — removed `@supabase/ssr`, `@supabase/supabase-js`;
  added `@neon/auth@^0.8.2`, `@neondatabase/serverless@^1.2.1`.
- `proxy.ts` — rewritten: `auth.middleware({ loginUrl: '/login',
  publicRoutes: ['/', '/login', '/register', '/forgot-password',
  '/reset-password'] })`, passthrough when unconfigured. (Old
  `middleware.ts` replaced — Next 16 deprecates `middleware`.)
- `lib/api.ts` — `requireAuth()` now returns `AuthContext { user:
  SessionUser, db: RequestDb }`; `RequestDb` exposes `query()` (one
  RLS-scoped statement) and `tx()` (one RLS-scoped transaction).
- `lib/audit.ts` — `logSecurityEvent` / `logSessionEvent` take a
  `DbClient` instead of a Supabase client; best-effort (never throws).
- `lib/dashboard-data.ts` — all 8 dashboard queries as SQL via
  `withUser()`; `user` is now `SessionUser | null`.
- `lib/types.ts` — `Profile` gains `email`; header updated (text user
  ids, uuid device/session ids).
- `lib/db/config.ts` — (see Created; also the pooled→direct fallback
  and the `NEON_AUTH_NOT_CONFIGURED_MESSAGE` alias).
- API routes (11): `app/api/devices/route.ts`,
  `app/api/pairing/generate/route.ts`,
  `app/api/pairing/redeem/route.ts`,
  `app/api/connection-requests/route.ts`,
  `app/api/connection-requests/[id]/approve/route.ts`,
  `app/api/connection-requests/[id]/reject/route.ts`,
  `app/api/permissions/route.ts`,
  `app/api/permissions/revoke-device/route.ts`,
  `app/api/sessions/disconnect/route.ts`,
  `app/api/sessions/disconnect-all/route.ts`,
  `app/api/profile/route.ts` — all rewritten to SQL via `db.query` /
  `db.tx`; redeem (mark-used-first) and approve (grants + session +
  status) run in real transactions; device removal, single-grant
  revoke and whole-device revoke also run in transactions.
- `components/AuthForms.tsx` — Better Auth client calls; forms take a
  `configured` prop from their server-component pages (client code
  cannot read server env vars); reset form reads the `token` query
  param; forgot-password uses `requestPasswordReset` (see §2).
- `components/DashboardShell.tsx` — sign-out via
  `authClient.signOut()`.
- `components/DashboardActions.tsx` — profile form calls
  `authClient.updateUser({ name })` before `PATCH /api/profile`
  (see §3.8); otherwise unchanged (fetch-based, Supabase-free).
- `components/ui.tsx` — `ConfigNotice` now uses the Neon message.
- `app/page.tsx`, `app/login/page.tsx`, `app/register/page.tsx`,
  `app/forgot-password/page.tsx`, `app/reset-password/page.tsx`,
  `app/dashboard/page.tsx`, `app/dashboard/settings/page.tsx`,
  `app/dashboard/security/page.tsx` — Supabase copy removed;
  `user.user_metadata?.display_name` replaced with
  `user.displayName` (SessionUser shape); auth pages pass
  `configured={isAuthConfigured()}`.
- `db/migrations/0001_init.sql` — (moved from `supabase/migrations/`,
  adapted: text user ids, `current_app_user_id()`, forced RLS,
  no auth FK / trigger / pgcrypto, `profiles.email` added).
- `db/seed.sql` — moved from `supabase/seed.sql`; demo user ids are now
  text placeholders for real Neon Auth user ids.
- `.env.example` — DATABASE_URL (pooled) + DATABASE_URL_UNPOOLED
  (direct) + NEON_AUTH_BASE_URL + NEON_AUTH_COOKIE_SECRET (≥32 chars)
  + NEXT_PUBLIC_APP_URL; placeholders only, no real secrets.
- `README.md` — full Neon setup steps (project → Managed Better Auth →
  env vars → migration → Google provider → run / Vercel deploy).
- `docs/limitations.md` — Neon wording; storage bucket marked deferred
  to Milestone 4; service-role key paragraph replaced (no privileged
  key exists in this setup; forced RLS is the guard).
- `next.config.ts` — comment updated (Neon Auth session, not Supabase).
- `lib/__tests__/db.test.ts` — new: config unit tests (10 tests) +
  migration-consistency tests + no-Supabase-imports test.
- `MILESTONE-1-REPORT.md` — addendum appended (report itself not
  rewritten).

### Deleted (5)
- `lib/supabase/` (whole directory: `client.ts`, `server.ts`,
  `proxy.ts`, `config.ts`).
- `supabase/migrations/0002_storage.sql` (Storage bucket — deferred to
  Milestone 4).
- `app/auth/callback/route.ts` (Supabase OAuth code-exchange callback;
  Better Auth handles callbacks through `/api/auth/*`).
- `supabase/` directory removed entirely (migration + seed moved to
  `db/`).

### Unchanged (as required)
- `lib/pairing.ts`, `lib/permissions.ts`, `lib/rate-limit.ts`,
  `lib/device.ts` — logic untouched.
- All 20 pre-existing unit tests — untouched and still passing.
- All dashboard page logic (data shapes unchanged apart from the
  `SessionUser` type).
- Trusted Device rules themselves (grant validity, 30-day expiry,
  revocation semantics, audit actions).

## 5. Verification (real numbers, Nov 25, 2026)

- `npm test` — **30 passed, 4 skipped** (6 files). The 20 original
  unit tests pass unchanged; 10 new `db.test.ts` unit tests pass
  (config parsing, migration consistency, no-Supabase-imports). The 4
  integration tests in `db.integration.test.ts` are **skipped** — they
  need `NEXVORA_TEST_DATABASE_URL` pointing at a throwaway database.
- `npm run lint` — **clean, 0 errors, 0 warnings** (one unused-import
  warning found and fixed during the run).
- `npm run build` — **passes** (Next 16.4.6, Turbopack, TypeScript
  strict). The build caught two real SDK-shape mistakes that the
  guides got wrong (`auth.handler()` is an object, not callable;
  `forgetPassword` is not callable in better-auth 1.7 — see §2);
  both were fixed against the shipped package types and a tsc probe.
- Production smoke test (`next start`, no env vars set):
  - `/` → 200, shows "no Neon project is configured yet".
  - `/login` → 200. `/dashboard` → 200, shows "Neon Auth not
    configured".
  - `GET /api/devices` → **503** with the honest "Neon is not
    configured…" message.
  - `POST /api/auth/sign-in/email` → **503** with the honest
    "Authentication is not configured…" message.
- Grep sweep: no `supabase` / `auth.uid` / `auth.users` references
  remain in app code except intentional historical comments (migration
  header, `lib/auth/session.ts` comment, test names). No `.env.local`
  exists; no real secret appears in code, `.env.example`, or this
  report.

## 6. What still needs a live database (NOT verified)

1. **Apply the migration** — run `db/migrations/0001_init.sql` in the
   Neon SQL editor (or `psql` against `DATABASE_URL_UNPOOLED`) on the
   `nexvora` project (shiny-math-25799090). Never tested against a
   live Postgres: the SQL is written for Postgres 18, but syntax,
   policy behaviour and the `FORCE RLS` interaction with the Neon
   connection role are all unverified until this runs.
2. **Enable Managed Better Auth** in the Neon Console (Auth page) and
   copy the branch Auth URL → `NEON_AUTH_BASE_URL`; generate a ≥32-char
   `NEON_AUTH_COOKIE_SECRET`. Set both plus `DATABASE_URL` /
   `DATABASE_URL_UNPOOLED` via the secure flow (never in chat).
3. **Run the integration tests** against a throwaway Neon branch:
   `NEXVORA_TEST_DATABASE_URL='postgresql://...' npm test --
   db.integration` — covers fail-closed `current_app_user_id()`,
   lazy profile upsert, cross-user RLS isolation, transaction rollback.
4. **Two-account end-to-end test** (never live-tested, even under
   Supabase): register devices on two accounts, generate a pairing code
   on A, redeem + request scopes on B, approve a subset on A, verify
   the session appears for both, revoke a scope and verify the session
   ends, verify a second redeem of the same code fails.
5. **Vercel deploy** — set the five env vars in Vercel, set
   `NEXT_PUBLIC_APP_URL` to the deployed URL, add the production
   `/api/auth/callback/google` URL to the Neon Auth Google provider
   settings, then re-test against the deployed URL.
6. **Google OAuth end-to-end** — the sign-in button calls
   `signIn.social({ provider: 'google', callbackURL: '/dashboard' })`;
   the provider must be enabled in the Neon Auth project with real
   Google credentials, otherwise the button will error at runtime.

## 7. Known limitations / risks

- **RLS depends on the app setting the session variable correctly.**
  Every query path goes through `withUser()` / `RequestDb`, but a
  future code path that queries the Pool directly without `SET LOCAL`
  would see nothing (fail-closed) rather than leak — safe direction,
  but worth a code-review check on every new route.
- **The Pool connects as the table owner.** Forced RLS is the only
  thing standing between the app role and cross-user reads; if a
  future migration forgets `FORCE ROW LEVEL SECURITY` on a new table,
  RLS would silently not apply to the owner connection. The
  migration-consistency test guards the current 10 tables.
- **Rate limiting is still in-memory per server instance**
  (unchanged from Milestone 1) — must move to Postgres/Redis for
  multi-instance deployments.
- **No `ws` package needed:** `@neondatabase/serverless@1.2.1`
  ships no dependencies and uses the Node 22+ global WebSocket;
  `lib/db/client.ts` assigns it explicitly when present.
- **Session-cache TTL:** the SDK caches session data (default 300s);
  revocation of the auth session itself (as opposed to device grants)
  may take up to the cache TTL to be visible server-side. Device-grant
  revocation is immediate (checked against the database per request).
- **The `?next=` post-login redirect is lost** (see §3.9) — users land
  on `/dashboard` after sign-in even if they started at a deeper page.
- **`auth.getSession()` shape** is normalised defensively in
  `lib/auth/session.ts` because the shipped runtime and the SDK's own
  guide disagree; if a future `@neon/auth` version changes the shape
  again, sign-in would silently return null (fail-closed, visible as
  "not signed in"). Pin `@neon/auth` to `^0.8.2` and re-verify on
  upgrade.

## 8. Exact next steps (for the parent)

1. Get `DATABASE_URL` / `DATABASE_URL_UNPOOLED` + the Managed Better
   Auth URL/secret from the user via the secure flow; confirm Managed
   Better Auth is enabled in the Neon Console.
2. Apply `db/migrations/0001_init.sql` to the Neon project.
3. Run the integration tests against a throwaway Neon branch.
4. Run the two-account end-to-end test (§6.4) and record the result.
5. Push to GitHub (`giveandtake349-sys/nexvora`) — parent-owned step,
   not done by this task.
6. Deploy to Vercel with the five env vars; re-test against the
   deployed URL.
7. Milestone 2: remote session architecture, WebRTC signaling, session
   lifecycle.
