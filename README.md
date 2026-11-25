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
- Supabase Auth (email/password + Google OAuth + email verification + password recovery)
- Supabase PostgreSQL + Row Level Security (RLS)
- Supabase Storage (bucket + policies only in Milestone 1)
- Vitest for unit tests

## Quick start (no Supabase yet)

The app builds and runs without a Supabase project. Auth and device data are
disabled in that state and every page says so clearly — nothing is faked.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build
npm test           # vitest run
```

## Full setup (real auth + database)

### 1. Create a Supabase project

1. Go to https://supabase.com/dashboard → New project.
2. Note the project URL and anon key (Settings → API).

### 2. Environment variables

```bash
cp .env.example .env.local
```

Fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service-role key>   # server-only, never NEXT_PUBLIC_, never commit
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 3. Run the database migrations

In the Supabase dashboard → SQL Editor, run in order:

1. `supabase/migrations/0001_init.sql` — all 10 tables, indexes, RLS policies,
   profile auto-creation trigger.
2. `supabase/migrations/0002_storage.sql` — private `file-transfers` bucket + policies.

Or with the Supabase CLI (if installed):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

`supabase/seed.sql` is **demo data only** — do not run it against production.

### 4. Enable Google OAuth

1. Supabase dashboard → Authentication → Providers → Google → enable.
2. Create OAuth credentials in Google Cloud Console and paste the client ID/secret
   into Supabase.
3. Supabase → Authentication → URL Configuration:
   - Site URL: `http://localhost:3000` (local) / your Vercel URL (production)
   - Redirect URLs: add `http://localhost:3000/auth/callback` (and the production
     equivalent). The app uses `/auth/callback?next=/dashboard`.

Email verification and password recovery use Supabase's built-in email templates;
confirm the redirect URL above is allow-listed or the links will fail.

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

## Project structure

```
app/                  Routes: landing, auth pages, dashboard pages, /api/*
  api/devices/        Register / list / remove devices
  api/pairing/        generate + redeem pairing codes
  api/connection-requests/   list, approve (with scope checklist), reject
  api/permissions/    list, grant, revoke one grant, revoke whole device
  api/sessions/       disconnect one, disconnect all
  api/profile/        update display name
components/           ui.tsx (brand system), DashboardShell, AuthForms, DashboardActions
lib/                  Supabase clients, permissions, pairing, rate-limit,
                      device helpers, audit logging, API auth helper
  __tests__/          Vitest unit tests
supabase/migrations/  0001_init.sql (10 tables + RLS), 0002_storage.sql
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

Set the same four env vars in the Vercel project settings, set
`NEXT_PUBLIC_APP_URL` to the deployed URL, and add the production
`/auth/callback` URL to Supabase's redirect allow-list (step 4 above).
Do not deploy unverified code — run `npm run build` and `npm test` first.
