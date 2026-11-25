# NEXVORA — ONE ECOSYSTEM. EVERY DEVICE.

Premium remote device access and management platform.
**Milestone 1 (this repo state):** brand foundation, landing page, authentication,
database, device registration, secure pairing, approval and revocation.

> Live screen / camera / microphone / speaker (Milestone 3) and file transfer /
> location / remote interaction (Milestone 4) are **not** built yet. The Remote
> Access workspace shows them as Disconnected / "Coming in Milestone 3/4" —
> never as active.

## Stack

- Next.js 16 (App Router) + TypeScript (strict) + Tailwind CSS v4
- Neon Postgres + Managed Better Auth (Neon Auth) for sign-in
  (email/password + Google OAuth + email verification + password recovery)
- Raw SQL over the Neon serverless Pool + Row Level Security (RLS, forced)
- Vitest for unit tests

## Quick start (no Neon yet)

The app builds and runs without a Neon project. Auth and device data are
disabled in that state and every page says so clearly — nothing is faked.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npm test           # vitest run
```

## Full setup (real auth + database)

### 1. Create a Neon project

1. Go to https://console.neon.tech → New project (any region; Singapore
   `ap-southeast-1` is the current project).
2. Note the **pooled** connection string (`DATABASE_URL`) and the **direct**
   connection string (`DATABASE_URL_UNPOOLED`) from the project dashboard →
   Connection Details. The direct string is used for migrations.

### 2. Enable Managed Better Auth

1. In the Neon Console, open the project → **Auth** page → enable
   **Managed Better Auth** (this is the current Neon Auth product; the
   older Stack Auth-based Neon Auth is legacy and closed to new users).
2. Copy the branch **Auth URL** — this is `NEON_AUTH_BASE_URL`.
3. Generate a cookie secret of **at least 32 characters**
   (e.g. `openssl rand -base64 48`) — this is `NEON_AUTH_COOKIE_SECRET`.
   The app refuses to start auth with a shorter secret.
4. In the Auth settings, enable the **Google** social provider and add your
   Google OAuth client ID/secret (Google Cloud Console), and set the app's
   callback URL to `<your-app-url>/api/auth/callback/google`.

### 3. Environment variables

```bash
cp .env.example .env.local
```

Fill in:

```
DATABASE_URL=postgresql://<user>:<password>@<pooled-host>/<db>?sslmode=require
DATABASE_URL_UNPOOLED=postgresql://<user>:<password>@<direct-host>/<db>?sslmode=require
NEON_AUTH_BASE_URL=https://<your-branch-auth-url>.neon.tech
NEON_AUTH_COOKIE_SECRET=<at least 32 characters>
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

All of these are server-only except `NEXT_PUBLIC_APP_URL`. Never commit
`.env.local`, never paste real values into chat.

### 4. Run the database migration

In the Neon dashboard → SQL Editor (or with `psql` against
`DATABASE_URL_UNPOOLED`), run:

1. `db/migrations/0001_init.sql` — all 10 tables, indexes, forced RLS
   policies, `current_app_user_id()` helper. Profile rows are created by
   the app on first sign-in (lazy upsert) — there is no auth trigger.

`db/seed.sql` is **demo data only** — do not run it against production.

### 5. Run

```bash
npm run dev
```

Sign up, verify your email, register a device, generate a pairing code, and
approve/reject requests from a second account.

## How the Trusted Device system works

- **Pairing:** Device A generates a 6-digit code (10 min, single use, SHA-256
  hashed — never stored in plaintext). Device B enters it; the server validates
  it and creates a **pending connection request**. The code alone grants nothing.
- **Approval:** the device owner sees the requester + requested scopes and
  approves a subset or rejects. Approved scopes become one
  `device_permissions` row each (owner, device, granted-to user, scope,
  granted_at, expires_at = 30 days by default, revocation status).
  Approval writes grants + session + status flip in one transaction.
- **Reuse:** on reconnect the server re-checks the grant — valid grants are
  reused without re-approval. Re-approval is only needed for a new scope, a
  changed device identity, an expiry, a revocation, or a security event.
- **Revocation:** revoking a permission or a whole device immediately marks the
  grant revoked **and** ends the affected active sessions server-side.
- **Audit:** every grant, change, revocation, pairing outcome, approval,
  rejection and disconnect writes to `security_events` / `session_events`,
  visible in the Security Center.
- **OS consent is separate:** a NEXVORA grant never turns on a camera,
  microphone or screen share. Those need explicit browser/OS consent at use
  time (Milestone 3). See `docs/limitations.md`.

## How auth + RLS work here

- Auth is **Managed Better Auth (Neon Auth)**, package `@neon/auth`
  (`^0.8.2`). Sign-in lives at `/api/auth/[...path]` (same-origin proxy);
  the browser client (`lib/auth/client.ts`) never sees a key.
- User ids are Better Auth ids — opaque **text** strings, not uuids. Every
  user-id column in the schema is `text`; device / session / request ids
  stay `uuid`.
- Every database query runs inside a transaction that first sets
  `app.current_user_id` to the validated session user id
  (`lib/db/client.ts` `withUser()`). The migration's
  `public.current_app_user_id()` reads that variable, and every RLS policy
  is written against it. Unset → NULL → every policy denies (fail-closed).
- All 10 tables carry **FORCE ROW LEVEL SECURITY**: the app connects as the
  table owner, which Postgres would otherwise exempt from RLS.

## Project structure

```
app/                  Routes: landing, auth pages, dashboard pages, /api/*
  api/auth/           Managed Better Auth handler (sign-up, sign-in, Google, reset)
  api/devices/        Register / list / remove devices
  api/pairing/        generate + redeem pairing codes
  api/connection-requests/   list, approve (with scope checklist), reject
  api/permissions/    list, grant, revoke one grant, revoke whole device
  api/sessions/       disconnect one, disconnect all
  api/profile/        update display name
components/           ui.tsx (brand system), DashboardShell, AuthForms, DashboardActions
lib/                  db/ (Neon pool + config), auth/ (Neon Auth server/client/session),
                      permissions, pairing, rate-limit, device helpers,
                      audit logging, API auth helper
  __tests__/          Vitest unit tests
db/migrations/        0001_init.sql (10 tables + forced RLS)
db/seed.sql           Demo data only — never run on production
docs/limitations.md   Browser limits + Android future work
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Run the production build |
| `npm test` | Vitest unit tests |
| `npm run lint` | ESLint |

## Deploy on Vercel

Set the same five env vars in the Vercel project settings, set
`NEXT_PUBLIC_APP_URL` to the deployed URL, and add the production
`/api/auth/callback/google` URL to the Neon Auth Google provider settings
(step 2 above). Do not deploy unverified code — run `npm run build` and
`npm test` first.
