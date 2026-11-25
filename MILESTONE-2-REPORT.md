# NEXVORA — Milestone 2 Final Report

**Date:** Nov 25, 2026
**Scope:** Session architecture + WebRTC signaling (DB-backed + short-polling),
plus the 9th permission scope "notifications".
**Status:** Code complete and verified locally (build / lint / tests all
pass). **Live-database verification is still pending** — the new
migration has NOT been applied to Neon and no two-party live poll test
has run (no Neon access from the build VM).

## 1. What was built

### Signaling (the core of Milestone 2)

Vercel Hobby is serverless: there is no long-lived process to hold a
WebSocket server, and a third-party realtime service would add another
vendor, another credential, and another place where grant checks could
be skipped. Signaling messages are small and infrequent (one SDP
offer/answer pair + a handful of ICE candidates per session) and
already need the same server-side grant re-checks as every other
route. So signaling is **DB-backed + short-polled**:

- `signaling_messages` table: one row per message (`session_id`,
  `sender_user_id`, `recipient_user_id`, `kind`, `payload jsonb`,
  `seq` from one global Postgres sequence,
  `created_at`). The global sequence gives a total order: polling with
  `after=<seq>` can never miss or double-deliver a message.
- Clients poll `GET /api/sessions/[id]/signal?after=<seq>` every ~2s
  (returned as `poll_interval_ms` in every poll response). No
  long-polling: holding a serverless function open would burn the
  Hobby execution budget for no benefit at this message rate.
- `remote_sessions` gains `signaling_state` (`created` → `connecting`
  → `live` → `ended`/`revoked`, terminal) and per-party heartbeats
  (`owner_last_heartbeat_at`, `participant_last_heartbeat_at`). One
  shared heartbeat column could not tell the parties apart, so "is my
  peer alive?" would be unanswerable; a separate heartbeat table
  would be a second write per heartbeat for no benefit at this scale.
  A peer is alive if it heartbeated within 30s; clients heartbeat
  every ~10s.
- `status` and `signaling_state` are always set together (ending sets
  both, revoking sets both) — they can never disagree.

### API routes (all via `requireAuth()`, server-validated, rate-limited)

| Route | What it does |
| --- | --- |
| `POST /api/sessions/[id]/start` | `created` → `connecting`. Caller must be a party, session `active`, participant must hold ≥1 live grant (owner exempt). Grant gone → session revoked server-side + 403. Idempotent for `connecting`/`live`. 10/min. |
| `POST /api/sessions/[id]/signal` | Send one message `{kind, payload}`. Kind validated, payload must be a JSON object ≤ 64 KiB (oversize → 413). Recipient derived server-side (the other party), never from the client. Grant + insert run in ONE transaction so a revocation landing mid-request cannot slip a message through; grant gone → session revoked + 403. One `session_events` row per send (kind + seq only — SDP never copied into the audit log). 120/min. |
| `GET /api/sessions/[id]/signal?after=<seq>` | Short-poll: messages to the caller with `seq > after`, oldest first, max 100, plus `signaling_state`, `peer_last_seen_at` + `peer_alive`, `grantsValid`. Grant re-checked on delivery too — a party whose grant is gone gets 403 and no messages. 120/min. |
| `POST /api/sessions/[id]/heartbeat` | Updates ONLY the caller's own heartbeat column; also refreshes `devices.last_seen_at` (under RLS that only succeeds for the device owner — a participant's update is a silent no-op). Grant gone → session revoked + 403. 60/min. |
| `POST /api/sessions/[id]/state` | Explicit transition (`connecting`/`live`/`ended`) with the allowed-transition map enforced server-side. `revoked` is server-driven only and can never be set here; `ended` also sets `status='ended'` + `ended_at`. 30/min. |
| `POST /api/sessions/disconnect` (extended) | Now also sets `signaling_state='ended'`. Existing behaviour/tests untouched. |

Consistency fixes in the same spirit (same one-line change):
`disconnect-all` and both revoke paths (`DELETE /api/permissions`,
`POST /api/permissions/revoke-device`) now set `signaling_state`
alongside `status`, so ending/revoking a session anywhere in the app
keeps the two in sync.

### Pure helpers — `lib/signaling.ts`

Message-kind validation (`offer`, `answer`, `ice-candidate`, `bye`,
`session-state`), 64 KiB payload limit (UTF-8 byte length, 413 on
overflow), the allowed-transition map, 30s heartbeat-staleness
threshold, poll guidance (2s interval, max 100 messages), `after`
parsing, per-party heartbeat/recipient resolution, plus the shared
server helpers (`loadSessionForParty`, `callerHasLiveGrant`,
`revokeSessionForLostGrant` — reuses the Milestone 1 pure
`checkGrantValidity`, never a second implementation).

### Remote Access page

Copy only: "Disconnected — no live media yet. Session signaling is
ready in Milestone 2; screen / camera arrive in Milestone 3". No fake
live states. The 9th scope renders as a card automatically (see §3).

### 9th permission scope: "notifications"

- `lib/permissions.ts`: `"notifications"` added to
  `PERMISSION_SCOPES`, label "Notifications", milestone 4, description
  stating it is owner-granted only, with a visible indicator on the
  device and instant revocation.
- `db/migrations/0002_signaling.sql` replaces the
  `device_permissions.scope` CHECK (0001 is already applied live and
  was NEVER edited): drops `device_permissions_scope_check` (verified
  name — 0001 defines the CHECK inline on that column) and re-adds it
  with all 9 scopes. The 8 original scopes are untouched.
- The scope goes through the exact same owner-approval flow, grant
  rows, reuse, revocation and audit as the other 8. The notification
  *feed UI/transport* is Milestone 4 work, delivered over the
  Milestone 2 signaling / Milestone 3 data-channel path — no second
  channel. On-device capture (Android NotificationListenerService,
  owner opts in on their own phone) is Milestone 6.

## 2. Hard boundary — no stealth monitoring (stated explicitly)

**No stealth / hidden-monitoring capability was built in this
milestone, and none will be.** The user asked (Nov 25) that the other
phone's owner should not notice the monitoring. That was refused and
is not in this code:

- Every permission — including `notifications` — is explicitly granted
  by the device owner, through the same approval flow as the other 8.
- Screen sharing (Milestone 3) is explicitly started by the owner
  (system dialog + persistent OS indicator); a grant alone never
  switches a screen on.
- Every active feature shows a visible indicator on the remote
  device; the owner can stop/revoke instantly (revocation ends the
  session server-side immediately, including mid-signaling).
- Nothing is shown as active unless a real connection exists.
- OS consent (screen-capture prompt, camera/mic indicators,
  notification-listener opt-in) is never bypassed, hidden, or worked
  around — and on Android it cannot be: the OS enforces its own
  camera/mic indicator and screen-capture notification while live.
- The one-time-grant half of the request IS the existing design
  (Trusted Device: grant once, reused on reconnect; re-approval only
  for a new permission, device change, expiry, revocation, or security
  event). The zero-notification half is not — and stays not — built.
- No Facebook login, no Messenger API, no credential storage, no
  scraping or unofficial APIs anywhere in this milestone. Meta
  provides no API for reading a personal Messenger inbox. The two
  legitimate routes are screen share (M3, owner-started, visible) and
  the owner-granted `notifications` scope (device-reported feed only).
- No notification data is faked anywhere.

## 3. Files created / modified

### Created (7)
- `db/migrations/0002_signaling.sql` — `signaling_messages` +
  `signaling_message_seq`, lifecycle + heartbeat columns on
  `remote_sessions` (with backfill: `status='active'` → `live`),
  scope CHECK extended to 9 scopes, forced RLS + party-only
  policies on the new table (no UPDATE/DELETE policies — messages
  are immutable, removed only by session cascade).
- `lib/signaling.ts` — pure helpers + shared server helpers.
- `lib/__tests__/signaling.test.ts` — 20 unit tests.
- `app/api/sessions/[id]/start/route.ts`
- `app/api/sessions/[id]/signal/route.ts` (POST send + GET poll)
- `app/api/sessions/[id]/heartbeat/route.ts`
- `app/api/sessions/[id]/state/route.ts`

### Modified (12)
- `lib/types.ts` — `RemoteSession` gains `signaling_state` +
  per-party heartbeats; new `SignalingMessage` + `SignalingState`.
- `lib/db/schema.ts` — `SCHEMA_TABLES_0002 = ["signaling_messages"]`
  (kept separate from the 0001 registry so the 0001 consistency
  test still checks exactly its 10 tables).
- `lib/permissions.ts` — 9th scope `notifications` (label, milestone
  4, description with the consent wording).
- `app/api/sessions/disconnect/route.ts` — also sets
  `signaling_state='ended'`.
- `app/api/sessions/disconnect-all/route.ts` — same sync.
- `app/api/permissions/route.ts` (single-grant revoke) — also sets
  `signaling_state='revoked'`.
- `app/api/permissions/revoke-device/route.ts` — same sync.
- `app/dashboard/remote-access/page.tsx` — copy only (see §1).
- `README.md` — setup step 4 now lists `0002_signaling.sql`.
- `lib/__tests__/db.test.ts` — 0002 consistency checks (table,
  sequence, forced RLS, party policies, lifecycle columns, backfill,
  9-scope CHECK).
- `lib/__tests__/db.integration.test.ts` — applies 0002 after 0001;
  2 new live-DB tests (default `created` + null heartbeats; seq
  ordering + RLS confinement + per-party heartbeat update).
- `lib/__tests__/permissions.test.ts` — 3 new tests for the 9th
  scope (9 scopes total, milestone 4, grant validates).

### Unchanged (as required)
- `db/migrations/0001_init.sql`, `.env.local`, `vercel.json`
  (region `sin1` stays), `~/MEMORY.md`, live test data.

## 4. Verification (real numbers, Nov 25, 2026)

- `npm test` — **58 passed, 6 skipped** (7 files). New: 20
  signaling unit tests, 3 notifications tests, 1 extra
  migration-consistency test (0002). The 6 skipped are the
  live-DB integration tests — they need
  `NEXVORA_TEST_DATABASE_URL` pointing at a throwaway database.
- `npm run lint` — **clean, 0 errors, 0 warnings.**
- `npm run build` — **passes** (Next.js 16.4.6, Turbopack,
  TypeScript strict). The build caught one real bug during the run:
  a discriminated-union type whose error member carried a union
  discriminant (`"not_found" | "not_active" | "signaling_ended"`)
  defeated narrowing in the signal route — fixed by splitting it
  into single-literal members; `tsc --noEmit` then clean. The 4 new
  routes appear in the route table (`/api/sessions/[id]/start`,
  `/signal`, `/heartbeat`, `/state`).
- No live smoke test was possible against the deployed app from this
  VM (no browser, no Neon access) — see §5.

## 5. What still needs live verification (NOT verified)

1. **Apply the migration** — run `db/migrations/0002_signaling.sql`
   in the Neon SQL Editor (or `psql` against
   `DATABASE_URL_UNPOOLED`) on the `nexvora` project, AFTER 0001
   (already applied). Never tested against a live Postgres: the SQL
   is written for Postgres 18, but syntax, the CHECK replacement,
   policy behaviour and the `FORCE RLS` interaction with the Neon
   connection role are all unverified until this runs. Note the
   backfill marks pre-existing `status='active'` sessions as
   `signaling_state='live'`.
2. **Run the integration tests** against a throwaway Neon branch:
   `NEXVORA_TEST_DATABASE_URL='postgresql://...' npm test --
   db.integration` — covers the new table/policies, seq ordering,
   RLS confinement, and heartbeat columns.
3. **Live two-party poll test** (never live-tested): two accounts
   with an approved session — A calls POST `.../start`, A sends an
   `offer` via POST `.../signal`, B polls GET `.../signal?after=0`
   and receives it; B answers; both heartbeat and see each other
   `peer_alive: true`; revoke B's grant mid-session and confirm the
   next send/poll gets 403 and the session shows `revoked`.
4. **Deploy** — the new routes deploy with the existing Vercel
   project (no env changes, no region change).
5. Milestone 3 (live media over WebRTC) will use this signaling
   layer as-is; no second channel is planned.

## 6. Push

Pushed to GitHub `giveandtake349-sys/nexvora`, branch `main`, via
the snapshot-push procedure. Commit SHA: _see parent report / sync
record_ (filled in after the provider confirms success).
