# NEXVORA — ONE ECOSYSTEM. EVERY DEVICE.

Premium remote device access and management platform.
**Milestone 5 (this repo state):** brand foundation, landing page, authentication,
database, device registration, secure pairing, approval and revocation,
DB-backed WebRTC signaling (Milestone 2), live screen / camera /
microphone / speaker over WebRTC (Milestone 3), file transfer /
location sharing / remote interaction / notification feed in live
sessions (Milestone 4), and hardening + final verification of the
whole platform (Milestone 5): rate limits on every route, security
headers, audit-log completeness, malformed-input and race-condition
fixes — no new features, no new migration.

> File transfer / location / remote interaction / notifications are
> **live in Milestone 4** — in the same live session as screen /
> camera / mic. Each needs its own live grant, and each shows a
> visible indicator while active. Honest limits still apply: remote
> interaction is in-page only (a browser cannot synthesize OS-level
> input), and the web side sends no notification data (browsers cannot
> capture OS notifications) — see "How Milestone 4 works" below and
> `docs/limitations.md`.

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
2. `db/migrations/0002_signaling.sql` — Milestone 2: the
   `signaling_messages` table + `signaling_message_seq` sequence,
   `signaling_state` and per-party heartbeat columns on
   `remote_sessions`, forced RLS on the new table. Run it after 0001,
   once, on the same database.
3. `db/migrations/0003_file_transfers_update.sql` — Milestone 4: an
   UPDATE policy on the existing `file_transfers` table (0001 created
   it with SELECT + INSERT policies only) so the sender/receiver can
   move a transfer through pending → approved → in_progress →
   completed / rejected / failed, plus a session index. No new table,
   no new column, no file bytes anywhere — files are peer-to-peer
   only. Run it after 0002, once, on the same database.

No new migration in Milestone 3: live media rides on the Milestone 2
signaling tables (offer/answer/ICE/bye over the API) and on one WebRTC
data channel (`nexvora-control`) for mute/track/kill-switch control
messages — nothing new is stored server-side.

`db/seed.sql` is **demo data only** — do not run it against production.

### 5. Run

```bash
npm run dev
```

Sign up, verify your email, register a device, generate a pairing code, and
approve/reject requests from a second account.

## How live sessions work (Milestone 3)

An approved session (created by the Milestone 1 approval flow) can be
joined from Remote Access or the Overview page — **Join live session**
opens `/dashboard/sessions/[id]`. Joining calls the Milestone 2 start
endpoint; it never creates a session. One `RTCPeerConnection` is then
established over the Milestone 2 signaling API (short-polled offer /
answer / ICE, 2s interval, exponential backoff on poll failures). The
participant creates the offer; the device owner answers — a fixed
initiator, so the handshake can never glare.

- **Screen:** the owner starts it from the live session with an
  explicit button click (`getDisplayMedia`). The browser/OS system
  dialog + persistent OS indicator appear; cancelling the dialog is a
  silent no-op. Stopping — button or the browser's own "Stop sharing" —
  removes the track and notifies the peer.
- **Camera / microphone:** `getUserMedia`, same explicit-click rule.
  Mute (mic) and camera on/off actually enable/disable the tracks and
  are signalled to the peer over the `nexvora-control` data channel.
- **Speaker:** the remote audio plays in its own `<audio>` element
  with a separate mute + volume slider. It is never conflated with the
  microphone mute. Playing remote audio needs the `speaker` scope (or
  being the device owner).
- **Grant model:** a side may publish a track only for a scope it holds
  a live grant for (owner exempt on their own device). The server page
  computes the valid scopes; the client never decides grant validity.
- **Revocation / disconnect:** a poll reporting `grantsValid: false`,
  a 403, a `bye`, a stale peer heartbeat (30s) after the call was live,
  or the server ending the session all tear the peer connection down
  immediately, stop every local track, and show a clear state
  ("Access revoked", "Peer disconnected", "Session ended"). ICE failure
  shows a failure state with a manual **Retry** button — nothing
  retries in a loop.
- **ICE:** public Google STUN only (`stun:stun.l.google.com:19302`).
  **There is no TURN server** — no credentials exist for one and none
  is faked. Direct peer-to-peer connections can fail when both sides
  sit behind symmetric NATs or restrictive firewalls; a TURN server is
  a future deployment item.
- **Data channel:** one channel, `nexvora-control`, carries mute state,
  track started/stopped, and the owner kill-switch. Milestone 4
  extends this same channel for file-transfer metadata, location,
  remote interaction, and notifications — binary file bytes are the
  only exception, using a dedicated `nexvora-file` channel (see
  "How Milestone 4 works" below).

No stealth mode exists anywhere in this app: no hidden indicators, no
silent screen capture, no bypass of OS consent. See `docs/limitations.md`
and `MILESTONE-4-REPORT.md` for what is still unverified live (two-browser
transfer test, location prompt test, interaction kill-switch test,
notification feed test with a real reporting device).

## How Milestone 4 works

All four features live in the same live session (`/dashboard/sessions/[id]`,
`components/LiveSession.tsx`) and each needs its own live grant
(`file_transfer` / `location` / `remote_interaction` / `notifications`;
the owner is exempt on their own device). The server page computes the
valid scopes; the client never decides grant validity.

- **File transfer:** sender picks a file → the client validates the bare
  file name (no paths) and the 50 MB size limit → `POST
  /api/sessions/[id]/file-transfers` records metadata (name, size,
  sender, receiver, `pending`) → the sender offers the metadata over
  `nexvora-control` (`file-offer`) → the receiver approves or rejects
  → only after approval do 16 KiB binary chunks flow over the
  dedicated `nexvora-file` data channel (4-byte chunk-index header,
  backpressure at 256 KiB buffered, progress shown on both sides) →
  the receiver assembles the Blob and gets a Download link; both sides
  update the server row (`approved` / `in_progress` / `completed` /
  `rejected` / `failed`) via `PATCH .../file-transfers/[transferId]`,
  which enforces the state machine and who may perform each transition.
  Files are peer-to-peer only — the server never stores file bytes.
  Why a second channel: binary framing + backpressure differ from JSON
  control messages, and a stalled transfer must never delay a
  kill-switch or mute message.
- **Location sharing:** the owner presses **Share my location** →
  the browser Geolocation prompt appears (denial is a silent no-op
  with an honest message) → fixes are sent over `nexvora-control`
  (`location-start` / `location-update` / `location-stop`, throttled
  to one update per 5s) only while a live `location` grant holds →
  the viewer sees the latest coordinates + timestamp + an
  OpenStreetMap link (no map API key), and a "sharing location"
  indicator shows on BOTH sides. Stop is one tap; start/stop are
  audit-logged.
- **Remote interaction (in-page only):** the controlled side presses
  **Allow remote interaction on my view** (explicit opt-in) → the
  other side's pointer over the remote screen sends normalised
  `interaction-pointer` events (move/click) and `interaction-key`
  events → the controlled side sees a remote-cursor overlay on its
  shared view and a visible log of keys received. **Honest limit:** a
  browser cannot synthesize OS-level input on the remote device — this
  is a cursor overlay + event forwarding to the shared view, never
  full OS remote control. The controlled side ends it instantly with
  **Kill interaction now** (`interaction-stop` over the control
  channel); the session itself keeps running.
- **Notification feed:** the reporting device announces
  `notification-sharing-start`, then sends validated `notification`
  messages (`{ app, title, body, receivedAt }`, size-capped) over
  `nexvora-control`; the viewer sees them in a feed (max 50, newest
  first) with a "notification sharing active" indicator. **Honest
  limit:** web browsers cannot capture OS notifications, so the web
  side has NO "send notification" button and sends no notification
  data — the feed populates only from a real reporting device
  (Android NotificationListenerService is a Milestone 6 capture
  route). No notification data is faked anywhere.
- **Audit:** location / notification sharing start-stop and
  interaction start/stop/kill are written via `POST
  /api/sessions/[id]/events` (allowlisted actions only, details
  capped at 2 KiB, scope-checked server-side) to `session_events`
  (+ `security_events` for starts **and for the interaction
  kill-switch** — Milestone 5), visible in the Security Center.
  File-transfer lifecycle events are written by the transfer routes.

## Milestone 5 — hardening (no new features, no new migration)

- **Rate limits on every route** (`lib/rate-limit.ts` carries the full
  table): pairing 5 per user per 10 min; device / request / permission /
  profile / disconnect writes 10–30/min per user, list reads 120/min;
  session start 10/min; signal send and poll 120/min per user per
  session (the client polls every ~2s ≈ 30/min, so 120/min is 4x
  headroom); heartbeat 60/min (client beats every ~10s ≈ 6/min, 10x
  headroom); state / file-status / events 30/min; file offers 10/min.
  **Known limit: the limiter is in-memory per server instance** — on a
  multi-instance deployment it must move into Postgres or Redis.
- **Security headers** (`next.config.ts`, verified by curl on the
  production build): `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(self), microphone=(self),
  geolocation=(self), display-capture=(self)` (the app's own media
  capture runs on its own origin and is unaffected),
  `X-Frame-Options: DENY`. **No Content-Security-Policy** — a strict
  CSP needs per-request nonces for Next.js's inline runtime scripts
  and Tailwind v4's injected styles, and that cannot be verified safe
  without a real browser pass; see `docs/limitations.md`.
- **Malformed input can no longer 500:** every uuid id (session,
  device, transfer, connection request, permission) is validated
  before it reaches Postgres (a malformed uuid used to raise 22P02
  and surface as a 500 — now a 404); every JSON body is read through
  a capped reader (`lib/http.ts`: 128 KiB raw cap for signaling,
  16 KiB for everything else — 413 over the cap, 400 for malformed
  JSON); `expiresAt` on direct grants must be a valid date.
- **Race conditions closed:** the file-transfer status update and
  the signaling-state update are conditional on the row still being
  in the expected state (`WHERE status = $from` /
  `WHERE signaling_state = $from`); a concurrent second request gets
  409 instead of a double-approve / double-end. Rejecting a
  connection request is likewise conditional on it still being
  pending.
- **Audit completeness:** the interaction kill-switch now also
  writes to `security_events` (it was session-only). Heartbeats and
  signal polls are deliberately NOT audited — that would be log spam
  at 30 polls/min per party.
- **Secret sweep:** no real credentials anywhere in the repo —
  `.env.example` and tests carry placeholders only (see
  `MILESTONE-5-REPORT.md`).
- **Verification:** `npm run build`, `npm run lint`, `npm test`
  (142 tests) and a local production smoke test all pass — see
  `MILESTONE-5-REPORT.md` for the full output and the consolidated
  live-verification checklist. Note: migrations 0002 + 0003 were
  applied live in the Neon SQL Editor on Nov 25 17:05–17:08 (see
  `MILESTONE-5-REPORT.md` §7); two-browser live tests still need a
  browser + live Neon.

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
  api/sessions/       disconnect one, disconnect all, start / signal /
                      heartbeat / state (Milestone 2 signaling),
                      file-transfers + events (Milestone 4)
components/           ui.tsx (brand system), DashboardShell, AuthForms, DashboardActions,
                      LiveSession (Milestone 3 live call view + Milestone 4 panels)
lib/                  db/ (Neon pool + config), auth/ (Neon Auth server/client/session),
                      permissions, pairing, rate-limit, device helpers,
                      audit logging, API auth helper, signaling (M2 helpers),
                      signaling-client (M3 browser signaling client),
                      webrtc (M3 pure WebRTC rules: ICE, control channel,
                      phase machine, grant model — extended in M4),
                      file-transfer (M4: chunking, framing, state machine,
                      name/size validation), live-features (M4: location,
                      notification feed, remote interaction, audit actions)
  __tests__/          Vitest unit tests
db/migrations/        0001_init.sql (10 tables + forced RLS),
                      0002_signaling.sql (M2), 0003_file_transfers_update.sql (M4)
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
