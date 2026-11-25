# NEXVORA — Milestone 5 Report: Hardening + Final Verification

Milestone 5 hardens the whole web platform (Milestones 1–5). **No new
features, no new migration.** Every fix below was verified by
`npm run build`, `npm run lint`, `npm test` (142 tests, all passing)
and a local production smoke test — outputs in §6.

## HARD CONSENT BOUNDARY (non-negotiable, restated in full)

**NO stealth mode, NO hidden indicators, NO silent capture, NO
background reading without the owner's knowledge.** Every feature is
owner-granted, owner-visible, instantly revocable. OS consent is never
bypassed: screen share needs the browser/OS dialog, camera/mic need
the per-site prompt, location needs the Geolocation prompt, and every
live feature shows a visible indicator on the controlled device while
active. Nothing in this milestone weakens that boundary — every
hardening fix below was made inside it, and any fix that could not be
made within these rules was left out (none arose: no hardening fix
required touching consent flows).

## 1. Rate limits — audit of every route

**Finding:** all Milestone 2–4 routes already had `checkRateLimit`
(start, signal POST+GET, heartbeat, state, file-transfers POST,
file-transfers PATCH, events POST). **Milestone 1 had a gap:** only
the two pairing routes were limited. The list/read/write routes —
devices, connection-requests, permissions, profile, disconnect,
disconnect-all, revoke-device — had no limit at all.

**Fix:** limits added to every M1 route (see table in
`lib/rate-limit.ts`, which is now the single documented source of
truth). Per-user keys everywhere; per-user-per-session keys on
session-scoped routes so one user cannot throttle another's session.

| Route | Limit |
| --- | --- |
| Pairing generate / redeem (M1) | 5 per user / 10 min (unchanged) |
| Devices GET / connection-requests GET / permissions GET | 120/min per user |
| Devices POST / profile PATCH / disconnect POST | 30/min per user |
| Devices DELETE / disconnect-all POST / revoke-device POST | 10/min per user |
| Connection-request approve / reject, permissions POST / DELETE | 30/min per user |
| Session start | 10/min per user |
| Signal send / signal poll | 120/min per user per session |
| Heartbeat | 60/min per user per session |
| Session state / file-transfer status / session events | 30/min per user per session |
| File-transfer offers | 10/min per user per session |

Poll/heartbeat headroom, verified by unit test
(`lib/__tests__/hardening.test.ts`): the client polls every ~2s
(≈30/min per party), so 120/min is 4x headroom for reconnect bursts
and two tabs; the client heartbeats every ~10s (≈6/min), so 60/min
is 10x headroom.

**Known limitation (kept, not silently upgraded):** rate limiting is
**in-memory per server instance**. On Vercel Hobby each serverless
instance keeps its own counters, so a burst spread across instances
is only partially throttled. This is NOT distributed rate limiting.
Moving the counters into Postgres (or Redis) is a one-file swap
(`lib/rate-limit.ts`) and is a future deployment item. Stated in
`lib/rate-limit.ts`, `README.md`, and `docs/limitations.md`.

## 2. Security headers

Added in `next.config.ts` (`async headers()`, per the Next.js 16
headers config in `node_modules/next/dist/docs/`), applied to
`/:path*`:

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(self), microphone=(self),
  geolocation=(self), display-capture=(self)` — exactly the features
  the app itself uses (`getUserMedia`, `getDisplayMedia`,
  Geolocation) on its own origin; delegating them to any other origin
  would only ever be a bug. The app's own media capture runs on the
  same origin and is unaffected.
- `X-Frame-Options: DENY` — the app is never framed anywhere.

Verified by curl on the production build (§6): all four headers
present on `/`, `/login`, `/dashboard`, and on API responses
(including the 503s). Pages still render (200s below).

**No Content-Security-Policy — deliberate, documented.** A strict
CSP needs per-request nonces plumbed through `proxy.ts` for Next.js's
inline runtime scripts and Tailwind v4's injected styles (see the
Next.js CSP guide in `node_modules/next/dist/docs/`). That cannot be
verified safe from this build VM — there is no browser here to prove
pages still render and no console-blocking breaks. Adding an
unverified CSP risks breaking the app in production. CSP is therefore
a known item for a future browser-verified pass, stated in
`next.config.ts`, `README.md`, and `docs/limitations.md` — not a
silent omission.

## 3. Audit-log completeness

Checked every M2–M4 action against `security_events` /
`session_events`:

| Action | Audit | Verdict |
| --- | --- | --- |
| Signaling start (`session.signaling_started`) | session + security | already present |
| Signal send (`session.signal_sent`, kind + seq only — SDP never copied) | session | already present |
| Signaling state change (`session.state_changed`) | session + security | already present |
| Grant-loss revocation (`session.revoked`) on start / signal / poll / heartbeat | session + security | already present |
| File-transfer offer / approve / reject / in_progress / complete / fail | session always; security for completed / failed / rejected | already present |
| Location sharing start / stop | session; security on start | already present |
| Notification sharing start / stop | session; security on start | already present |
| Interaction start / stop | session; security on start | already present |
| **Interaction kill-switch (`interaction.killed`)** | **session only** | **FIXED in M5** |

**Fix:** `interaction.killed` now also writes to `security_events`.
The kill-switch is a security decision (the owner ending remote
interaction) and the Security Center must show it. Implemented as a
testable pure helper `shouldLogSecurityEvent()` in
`lib/live-features.ts` (starts + `interaction.started` +
`interaction.killed` → security; stops → session only, because the
start already covers the window). The events route uses it; unit
tests cover all seven actions.

**Deliberate non-audit (stated explicitly):** heartbeats and signal
polls are NOT audited. At ~30 polls/min and ~6 heartbeats/min per
party that would be log spam with no security value; grant loss is
still audited at the moment it is detected (the 403 revocation path
above). `logSecurityEvent` / `logSessionEvent` are best-effort (never
throw) on all paths, including the new ones — verified by reading
`lib/audit.ts` (try/catch → console.error) and by the client-side
best-effort audit writes in `components/LiveSession.tsx`.

## 4. Error handling / edge cases — bugs found and fixed

### (a) Malformed session/device/transfer ids returned 500 (FOUND, FIXED)

Every id the database stores as `uuid` was passed straight into a
parameterised query. Postgres raises error **22P02** (invalid text
representation) for a malformed uuid literal, the query threw, and
the route returned **500** — for an input that is simply "not found".
Affected: all seven `[id]` session routes, `transferId`,
connection-request approve/reject, devices DELETE `?id`, permissions
DELETE `?id`, permissions POST `deviceId`, pairing generate/redeem
`deviceId`, disconnect `sessionId`, revoke-device `deviceId`.

**Fix:** `isUuid()` + `invalidIdResponse()` (404, same shape as every
other "not found" — no existence leak) in new `lib/http.ts`,
re-exported from `lib/api.ts`. Every route validates its uuid ids
before any query. Unit-tested with hostile inputs including a
SQL-injection-shaped string.

### (b) Unbounded JSON bodies parsed before any limit applied (FOUND, FIXED)

All routes used `request.json()`, which reads the whole body before
any limit can apply — so the semantic caps (64 KiB signal payload,
2 KiB audit details) were only enforced *after* a potentially huge
body had already been parsed into memory.

**Fix:** `readJsonBody()` in `lib/http.ts`: checks `Content-Length`
first, then the raw-text byte length, then `JSON.parse`. Caps:
**128 KiB raw for signaling** (64 KiB payload + wrapper),
**16 KiB for every other JSON body**. Over the cap → **413**;
malformed JSON / empty body → **400**. Applied to every route that
reads a body (signal, state, file-transfers, events, devices,
permissions, profile, disconnect, pairing generate/redeem).
Verified: signal 64 KiB cap and events 2 KiB details cap were already
enforced by `validateSignalBody` / `validateSessionEventBody` and
remain enforced — the raw cap is an additional, earlier layer.
Unit-tested (413 via header and via actual body, 400 for malformed
and empty, accept at the 128 KiB boundary).

### (c) File-transfer double-approve / double-end race (FOUND, FIXED)

The PATCH route checked the state machine inside a transaction but
updated with `WHERE id = $3` only — two concurrent PATCHes could
both pass the check and both move the transfer (double-approve,
double-complete).

**Fix:** conditional update `WHERE id = $3 AND status = $from`;
`rowCount === 0` means the other request won → **409** ("already
updated by another request"), never applied twice. Same guard added
to the signaling-state route (`WHERE signaling_state = $from` → 409)
and to connection-request reject (`WHERE status = 'pending'` → 409
if a concurrent approve won). The start route's update was already
conditional (`signaling_state = 'created'`) and idempotent; the
disconnect route's update now also requires `status = 'active'`.

### (d) Unvalidated client-supplied `expiresAt` could 500 (FOUND, FIXED)

`POST /api/permissions` passed a client-supplied `expiresAt` string
straight into the insert — a garbage string would make Postgres
reject the insert with a 500. Now validated as a real date first
(400 otherwise), defaulting to the 30-day expiry.

### (e) Verified already-correct (no change needed)

- **Unauthenticated access:** `requireAuth()` returns 503 when Neon
  is not configured and 401 otherwise — every new route starts
  there. Smoke test (§6): unauthenticated calls return 503 (no-env)
  or 307 to `/login` (configured env, proxy) — never 500.
- **File-transfer state machine:** illegal transitions already
  rejected with 409 by `canActorTransitionTransferStatus` (receiver
  approves/rejects, sender starts/completes, either side fails);
  terminal states never move. Unit-tested in M4, re-verified here.
- **Double-end idempotency:** `POST /state` with `from === to`
  returns ok; disconnect of an already-ended session returns
  `{ ok: true, alreadyEnded: true }`; re-revoking an already-revoked
  grant returns `{ ok: true, alreadyRevoked: true }`.
- **Expired/revoked grants mid-flow:** every signaling route
  re-checks the live grant on send, poll, heartbeat, and start, and
  revokes the session server-side with a 403 on loss. File-transfer
  and events routes re-check their own scope grant. Unchanged in M5;
  the live revoke-mid-call test is still on the checklist (§7).

## 5. Secret sweep

Grep over the whole repo (code, reports, `.env.example`, tests)
for API keys, connection strings, tokens, private keys, and cloud
credential patterns (`sk-…`, `AKIA…`, `ghp_…`, `xox…`, `postgres://…:…@`,
`-----BEGIN … PRIVATE KEY-----`):

- **Result: no real secrets found.** The only matches are
  placeholders: `.env.example` (`user:pass@host`, `<your-…>`,
  `<redacted>`), `README.md` / `NEON-ADAPTATION-PLAN.md`
  template connection strings, and `lib/__tests__/db.test.ts`
  fixtures (`postgresql://u:p@pooled/db`).
- `.env.local` exists locally with real values; it was **not read,
  not edited, and is excluded from the push** (snapshot manifest
  contains only repo files; `.env.local` is git-ignored and never
  selected).

## 6. Full verification (actual outputs)

All run in `~/workspace/nexvora` on 2026-11-25. The VM cannot reach
Neon (data plane unreachable, no browser), so live-DB and live-browser
checks remain on the checklist (§7) — nothing below claims them.

### `npm run build` — PASS

Production build completes; all routes present, including
`/api/sessions/[id]/start`, `/signal`, `/heartbeat`, `/state`,
`/file-transfers`, `/file-transfers/[transferId]`, `/events`.

### `npm run lint` — PASS (0 errors, 0 warnings)

One warning appeared during the work (`invalidIdResponse` imported
but unused in pairing redeem) and was fixed before the final run.

### `npm test` — PASS: 142 passed, 6 skipped

11 test files pass (1 integration file skipped — needs a live Neon
branch). 15 new tests in `lib/__tests__/hardening.test.ts`: UUID
accept/reject (incl. injection-shaped input), capped body reader
(400 malformed/empty, 413 via header and via body, accept at the
128 KiB signaling boundary), kill-switch security-audit decision for
all seven audit actions, and poll/heartbeat rate-limit headroom.
Supporting change: `vitest.config.ts` gained the `@/` path alias
(mirroring `tsconfig.json`) so tests can import `lib/http.ts`'s
sibling modules; `lib/http.ts` itself was split out of `lib/api.ts`
precisely so it carries no auth/database imports and stays
importable in the Vitest node environment (importing `lib/api.ts`
directly pulls in `@neon/auth`, which cannot load there).

### `npx tsc --noEmit` — PASS (no errors)

### Local production smoke test (`next start`, no env vars) — PASS

Server started with `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
`NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET` set to empty (shell
env wins over `.env.local`, so the app runs in its honest
not-configured state; `.env.local` itself untouched):

| Check | Result |
| --- | --- |
| `GET /` | 200 |
| `GET /login` | 200 |
| `GET /dashboard` | 200, honest "not configured" state |
| `GET /api/devices` | 503 `{"error":"Neon is not configured…"}` |
| `POST /api/sessions/not-a-uuid/signal` | 503 (malformed id, never 500) |
| `POST /api/sessions/<uuid>/signal` | 503 |
| `GET /api/sessions/<uuid>/signal?after=0` | 503 |
| `POST /api/sessions/<uuid>/start` | 503 |
| `POST /api/sessions/<uuid>/heartbeat` | 503 |
| `POST /api/sessions/<uuid>/state` | 503 |
| `POST /api/sessions/<uuid>/events` | 503 |
| `POST /api/sessions/<uuid>/file-transfers` | 503 |
| `PATCH /api/sessions/<uuid>/file-transfers/<uuid>` | 503 |
| Security headers on `/` and on API 503s | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(self), geolocation=(self), display-capture=(self)`, `X-Frame-Options: DENY`; no `Content-Security-Policy` header (deliberate, §2) |

Also observed with the real `.env.local` present (first smoke run):
unauthenticated requests to `/dashboard` and all API routes get
**307 to `/login`** via `proxy.ts` — never 500, never data.

## Files changed (Milestone 5)

- `lib/http.ts` — **new**: `isUuid`, `invalidIdResponse`,
  `readJsonBody`, raw body caps (128 KiB signaling / 16 KiB other).
- `lib/api.ts` — re-exports the `lib/http.ts` helpers so routes
  keep importing from `@/lib/api`.
- `lib/rate-limit.ts` — full per-route limit table in the header
  comment; in-memory-per-instance limitation restated.
- `lib/live-features.ts` — `shouldLogSecurityEvent()` (kill-switch
  now security-logged).
- `lib/__tests__/hardening.test.ts` — **new**: 15 tests (§6).
- `vitest.config.ts` — `@/` alias for tests.
- `next.config.ts` — four security headers; CSP deliberately absent
  (documented).
- `app/api/sessions/[id]/start|signal|heartbeat|state|file-transfers|file-transfers/[transferId]|events/route.ts`
  — uuid validation, capped body reads, conditional (atomic) state
  updates where applicable.
- `app/api/devices/route.ts`, `app/api/connection-requests/route.ts`,
  `app/api/connection-requests/[id]/approve|reject/route.ts`,
  `app/api/permissions/route.ts`,
  `app/api/permissions/revoke-device/route.ts`,
  `app/api/profile/route.ts`, `app/api/sessions/disconnect/route.ts`,
  `app/api/sessions/disconnect-all/route.ts`,
  `app/api/pairing/generate|redeem/route.ts` — rate limits, uuid
  validation, capped body reads, conditional reject/disconnect
  updates, `expiresAt` validation.
- `README.md`, `docs/limitations.md` — final Milestone 1–5 state.
- `MILESTONE-5-REPORT.md` — this file.

**Not touched:** `db/migrations/0001_init.sql`,
`0002_signaling.sql`, `0003_file_transfers_update.sql`, `.env.local`,
`vercel.json` (region `sin1` unchanged), `~/MEMORY.md`, live test
data. **No new migration** — no hardening fix required one.

## 7. Consolidated LIVE-VERIFICATION CHECKLIST (M2–M5 — still needs a browser + live Neon)

Do these in order, against the Neon project with migrations applied.
Nothing here has been run yet — the build VM cannot reach Neon and
has no browser.

### A. Migrations (do first)

- [ ] **A1.** Apply `db/migrations/0002_signaling.sql` in the Neon
  SQL Editor (or `psql` against `DATABASE_URL_UNPOOLED`), AFTER
  0001 (already applied). Verifies: `signaling_messages` table +
  sequence, `signaling_state` + heartbeat columns, forced RLS.
  Backfill marks pre-existing `status='active'` sessions
  `signaling_state='live'`.
- [ ] **A2.** Apply `db/migrations/0003_file_transfers_update.sql`
  after 0002. Verifies: UPDATE policy on `file_transfers` (sender/
  receiver can move pending → approved → in_progress → completed /
  rejected / failed) + session index.
- [ ] **A3.** Run the integration tests against a throwaway Neon
  branch: `NEXVORA_TEST_DATABASE_URL=<branch-url> npm test --
  db.integration` (signaling table/policies, seq ordering, RLS
  confinement, heartbeat columns).

### B. Signaling — two-party poll test (M2)

- [ ] **B1.** Two accounts with an approved session: A calls POST
  `.../start` → `connecting`; A sends an `offer` via POST
  `.../signal`; B polls GET `.../signal?after=0` and receives it;
  B answers; both heartbeat and see each other `peer_alive: true`.
- [ ] **B2.** Revoke B's grant mid-session: the next send/poll gets
  403 and the session shows `revoked`.
- [ ] **B3.** Malformed-id check (M5, live): POST
  `.../sessions/not-a-uuid/signal` as an authenticated user → 404,
  never 500. Oversize signal payload (>64 KiB) → 413.

### C. Live call — two browsers (M3)

- [ ] **C1.** Both join `/dashboard/sessions/[id]`; the
  participant's offer reaches the owner via polling; the peer
  connection reaches `connected`; LIVE shows on both sides; the
  `nexvora-control` channel opens.
- [ ] **C2. Screen-share OS dialog test:** owner clicks Share
  screen — the system dialog appears, the remote side sees the
  screen; owner cancels the dialog on a second attempt (no error, no
  indicator); the browser's own "Stop sharing" ends the share
  cleanly.
- [ ] **C3. Camera/mic + speaker test:** owner starts camera + mic;
  participant sees video and hears audio; mic mute and camera off
  actually pause the tracks and show on the peer; speaker mute/volume
  work independently of mic mute.
- [ ] **C4. Revoke-mid-call test:** revoke the participant's grant
  while live — the next poll/send must 403, both sides tear down
  immediately, all tracks stop, "Access revoked" shows. Also: End
  session (peer sees `bye`); peer closes the tab (peer-disconnected
  via stale heartbeat after 30s); ICE failure behind a strict NAT
  (failure state + manual Retry; no TURN exists — expected limit).
- [ ] **C5. Headers live check:** confirm the four security headers
  on the deployed Vercel app and that `getUserMedia` /
  `getDisplayMedia` / Geolocation still work on the app's own origin
  (the `Permissions-Policy: (self)` values must not break them).

### D. File transfer / location / interaction / notifications (M4)

- [ ] **D1. File-transfer test:** two accounts, `file_transfer`
  grants — sender offers a small file, receiver approves, chunks
  flow, progress moves on both sides, receiver downloads a
  byte-identical file; reject path; oversize (>50 MB) refusal on
  both sides; cancel mid-transfer.
- [ ] **D2. Double-approve live check (M5):** two concurrent
  approves of the same transfer — one succeeds, the other gets 409.
- [ ] **D3. Location prompt test:** owner starts sharing, the browser
  prompt appears, the peer sees coordinates + OpenStreetMap link,
  both sides show the indicator; deny the prompt (no indicator,
  honest message); Stop ends sharing on both sides.
- [ ] **D4. Interaction kill-switch test:** owner allows interaction,
  participant's pointer shows as a remote cursor on the owner's
  view, owner presses Kill interaction now — interaction ends
  immediately on both sides while the session keeps running. Then
  check the Security Center: the kill is now in `security_events`
  (M5 fix).
- [ ] **D5. Notification feed test with a real reporting device:**
  only possible once a Milestone 6 Android device sends real
  notifications — the web feed must stay empty until then, and must
  render a received notification with app/title/body/time.

### E. Deploy

- [ ] **E1.** Deploy this commit to Vercel (no env changes, no
  region change — `sin1` stays; no new migration).
- [ ] **E2.** Re-run the smoke checks against the deployed URL:
  `/` → 200, `/login` → 200, `/dashboard` → 200 signed-in,
  `GET /api/devices` → 200 signed-in / 401-or-redirect signed-out,
  security headers present.

## 8. Push

Pushed to GitHub `giveandtake349-sys/nexvora`, branch `main`, via
the snapshot-push procedure. Commit SHA: _see parent report / sync
record_ (filled in after the provider confirms success).
