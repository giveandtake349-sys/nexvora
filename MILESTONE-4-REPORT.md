# NEXVORA — Milestone 4 Final Report

**Date:** Nov 25, 2026
**Scope:** File transfer, location sharing, remote interaction, and the
notification feed — all inside the Milestone 3 live session, on the
Milestone 2 signaling API and the Milestone 3 peer connection. M2/M3
were extended, not redesigned.
**Status:** Code complete and verified locally (build / lint / tests all
pass). **Live verification is still pending** — no two-browser test has
run (no browser, no Neon access from the build VM), and the new
migration has NOT been applied to a live database yet.

## 1. Hard consent boundary — no stealth monitoring (stated explicitly)

**No stealth / hidden-monitoring capability was built in this
milestone, and none will be.** The rules from Milestones 1–3 apply in
full:

- **NO stealth mode, NO hidden indicators, NO silent capture, NO
  background reading without the owner's knowledge.** Every feature
  below is owner-granted, owner-visible (a visible indicator on the
  remote device while active), and instantly revocable/stoppable by
  the owner.
- **File transfer:** nothing is sent silently — every file needs the
  receiver's explicit per-file approval, and the sender's declared
  size is re-checked by the receiver and the server.
- **Location:** shared only from an explicit button click + the
  browser's Geolocation permission prompt, only under a live
  `location` grant. Denying the prompt is a silent no-op. The OS
  consent prompt is never bypassed.
- **Remote interaction:** explicit opt-in by the controlled side, a
  visible remote cursor, and a one-tap kill-switch. It is in-page
  only and is never presented as OS-level control.
- **Notifications:** the web side sends no notification data at all —
  browsers cannot capture OS notifications, and nothing is faked to
  fill the feed.
- If a feature could not be built within these rules, it was left out
  and is named in §6 — the rules were not weakened.

## 2. What was built

### Channel design

| Channel | Carries | Why |
| --- | --- | --- |
| `nexvora-control` (M3) | All JSON control messages: M3 mute/track/kill-switch PLUS M4 `file-offer` / `file-approve` / `file-reject` / `file-cancel` / `file-complete`, `location-start` / `location-stop` / `location-update`, `interaction-start` / `interaction-stop` / `interaction-pointer` / `interaction-key`, `notification-sharing-start` / `notification-sharing-stop` / `notification` | One control path, strictly validated (`parseControlMessage` — malformed or unknown messages are ignored, never crash the session). |
| `nexvora-file` (M4, new) | Binary file chunks only (ArrayBuffer: 4-byte big-endian chunk index + payload) | Binary framing + backpressure differ fundamentally from JSON control messages. A stalled 50 MB transfer must never delay a kill-switch, a mute state, or an interaction stop. Mixing binary into the control channel would also force the control parser to distinguish binary from text on every message. |

The offerer (participant) creates both channels; the answerer (owner)
receives both via `ondatachannel`. Both close on teardown/revocation.

### 1. File transfer

- **Flow:** sender picks a file → client validates the bare file name
  (no paths, no control characters, ≤255 chars) and the 50 MB limit →
  `POST /api/sessions/[id]/file-transfers` records metadata (name,
  size, sender, receiver, `pending`; 10 offers/user/session/min) →
  sender sends `file-offer` (with the server-issued transfer id) →
  receiver approves or rejects → only after approval do 16 KiB
  chunks flow over `nexvora-file` with backpressure (pause above
  256 KiB buffered, resume below 64 KiB) → receiver assembles the
  Blob only when every chunk index is present and the byte count
  matches, then gets a Download link and sends `file-complete`.
- **Progress:** shown on both sides (whole-number percent + bar).
- **Server record:** `PATCH .../file-transfers/[transferId]`
  enforces the state machine (`pending → approved → in_progress →
  completed`, `pending → rejected`, any live state → `failed`) AND
  who may perform each transition (receiver approves/rejects, sender
  starts/completes, either side may fail). Terminal states never
  move; a second "completed" is a 409. Only the sender/receiver of
  that transfer may update it; the caller must be a session party
  and (for offers) hold a live `file_transfer` grant (owner exempt).
- **Files are peer-to-peer only — the server never stores file
  bytes.** There is no storage bucket and none is faked.
- **"Cancelled" is not a table status:** a cancelled transfer is
  recorded as `failed` (reason in the audit details), so the 0001
  table constraint never needed changing.

### 2. Location sharing

- Explicit **Share my location** button → `watchPosition` with the
  browser Geolocation prompt. Denial/unavailability is a silent
  no-op with an honest message — no fake "sharing" indicator.
- Fixes travel as `location-start` / `location-update` /
  `location-stop` over the control channel, throttled to one update
  per 5s, only while a live `location` grant holds. Inbound fixes
  are validated (latitude ±90, longitude ±180, sane accuracy,
  timestamp) and accepted only while the peer says it is sharing.
- The viewer sees the latest coordinates + accuracy + timestamp +
  an OpenStreetMap link (built from the coordinates, no map API
  key). A "sharing location" indicator shows on BOTH sides; Stop is
  one tap. Start/stop are audit-logged (`location.sharing_started` /
  `location.sharing_stopped`).

### 3. Remote interaction (in-page only — honest web limit)

- The controlled side presses **Allow remote interaction on my view**
  (explicit opt-in, `interaction-start`); the other side's pointer
  over the remote screen sends normalised `interaction-pointer`
  events (move/click, coordinates 0–1, validated in range) and
  `interaction-key` events (short keys only). The controlled side
  sees a remote-cursor overlay on its shared view (with a click
  pulse) and a visible log of keys received — shown only, never
  typed into the device or its OS.
- **Kill-switch:** **Kill interaction now** sends
  `interaction-stop` over the control channel and ends interaction
  immediately on both sides; the session itself keeps running.
  Either side can also stop with the allow-toggle. Start/stop/kill
  are audit-logged.
- **HONEST LIMIT, stated in the code, the README, the docs, and the
  UI:** a browser cannot synthesize OS-level input on the remote
  device. This is a cursor overlay + click/key forwarding to the
  shared view — never full OS remote control. Real remote control
  needs the native Android app (Milestone 6).

### 4. Notification feed (9th scope, wired in this milestone)

- Validated notification schema over the control channel:
  `{ type: 'notification', app, title, body, receivedAt }` —
  app ≤100 chars, title ≤200, body ≤1000, `receivedAt` a valid
  timestamp. Malformed or oversize notifications are dropped on
  receipt. `notification-sharing-start` / `-stop` bracket sharing.
- The live session shows a Notification Feed panel (max 50 entries,
  newest first) with a visible "notification sharing active"
  indicator, only while a live `notifications` grant holds.
  Start/stop are audit-logged.
- **HONEST LIMIT, stated in the code, the README, the docs, and the
  UI:** web browsers cannot capture OS notifications, so the web
  side has NO "send notification" button and sends no notification
  data. The feed populates only from a real reporting device
  (Android NotificationListenerService is a Milestone 6 capture
  route). **No notification data is faked anywhere in production
  code.** Unit tests use fixture payloads to test validation and
  rendering — that is test data, not production mock data.

### Server routes (new)

| Route | Purpose |
| --- | --- |
| `POST /api/sessions/[id]/file-transfers` | Record a transfer offer (metadata only). Validates name/size, session party, live `file_transfer` grant. Rate-limited 10/min. |
| `PATCH /api/sessions/[id]/file-transfers/[transferId]` | Move a transfer's status. Enforces the state machine + actor rules; sets `completed_at` on completion. Rate-limited 30/min. |
| `POST /api/sessions/[id]/events` | Write one allowlisted M4 audit event (location / notifications start-stop, interaction start/stop/kill). Details capped at 2 KiB, scope-checked server-side. Rate-limited 30/min. |

### Pure modules (new)

- `lib/file-transfer.ts` — channel name, 50 MB / 16 KiB limits,
  backpressure watermarks, file-name/size validation, chunk count &
  ranges, progress math, 4-byte chunk framing, transfer state
  machine + actor rules, API body validation.
- `lib/live-features.ts` — location fix validation, 5s throttle,
  OpenStreetMap link, notification validation + feed capping,
  pointer/key validation, audit-action allowlist + scope map +
  events-body validation.
- `lib/webrtc.ts` (extended) — 15 new control-message types with
  strict parsing, and `canTransferFiles` / `canShareLocation` /
  `canUseRemoteInteraction` / `canShareNotifications` gating
  (owner exempt, participant needs the live scope).
- `lib/types.ts` — `FileTransfer` row shape.

### UI (extended, not forked)

`components/LiveSession.tsx` keeps all M3 controls working and adds
four panels (File transfer, Location, Remote interaction,
Notification feed) plus a remote-cursor overlay on the local preview
and pointer/key forwarding on the remote screen view. The live
session page now computes all eight live scopes server-side
(`app/dashboard/sessions/[id]/page.tsx`); the Remote Access page no
longer says "Coming in Milestone 4" for the four M4 scopes.

## 3. Files created / modified

### Created (8)
- `lib/file-transfer.ts` — pure file-transfer rules.
- `lib/live-features.ts` — pure location / notification / interaction / audit rules.
- `lib/__tests__/file-transfer.test.ts` — 21 unit tests.
- `lib/__tests__/live-features.test.ts` — 14 unit tests.
- `app/api/sessions/[id]/file-transfers/route.ts` — POST offer (metadata only).
- `app/api/sessions/[id]/file-transfers/[transferId]/route.ts` — PATCH status.
- `app/api/sessions/[id]/events/route.ts` — POST M4 audit events.
- `db/migrations/0003_file_transfers_update.sql` — UPDATE policy + session index on `file_transfers`.

### Modified (7)
- `lib/webrtc.ts` — 15 new control-message types + parsing + 4 gating helpers.
- `lib/types.ts` — `FileTransfer` row shape.
- `components/LiveSession.tsx` — `nexvora-file` channel, transfer
  engine (offer/approve/chunks/progress/download), location sharing,
  remote interaction + cursor overlay + kill-switch, notification
  feed, audit-event calls.
- `lib/__tests__/webrtc.test.ts` — M4 control-message + gating tests.
- `app/dashboard/sessions/[id]/page.tsx` — all 8 live scopes.
- `app/dashboard/remote-access/page.tsx` — M4 scopes shown as live in sessions.
- `README.md`, `docs/limitations.md` — M4 documented with honest limits.

### Unchanged (as required)
- `db/migrations/0001_init.sql`, `0002_signaling.sql`, `.env.local`,
  `vercel.json` (region `sin1` stays), `~/MEMORY.md`, live test data.

## 4. Migration needing application

**YES — one new file: `db/migrations/0003_file_transfers_update.sql`.**
Apply once, after 0002, in the Neon SQL Editor (or psql against
`DATABASE_URL_UNPOOLED`). It adds an UPDATE policy on the existing
`file_transfers` table (sender/receiver/device-owner may update
status + `completed_at`) and a `(session_id, created_at)` index. No
new table, no new column. **It has NOT been run against a live
database yet** (no Neon access from the build VM). Until it is
applied, the PATCH status route will fail at the RLS layer — the
peer-to-peer transfer itself (channels + UI) does not depend on it,
but the server metadata row will stay `pending`.

## 5. Verification (real numbers, Nov 25, 2026)

- `npm test` — **127 passed, 6 skipped** (11 files). New: 21
  file-transfer tests + 14 live-features tests + 6 new webrtc tests
  (M4 control messages + gating). The 6 skipped are the live-DB
  integration tests — they need `NEXVORA_TEST_DATABASE_URL`
  pointing at a throwaway database.
- `npm run lint` — **clean, 0 errors, 0 warnings.**
- `npm run build` — **passes** (Next.js 16.4.6, Turbopack, TypeScript
  strict). The build caught two real type errors during the run
  (a dropped `export interface SecurityEvent {` line in types.ts,
  and `Uint8Array<ArrayBufferLike>` vs `ArrayBufferView<ArrayBuffer>`
  on `dc.send` / `Blob`) — both fixed, `tsc` then clean. The three
  new routes appear in the route table
  (`/api/sessions/[id]/events`, `/api/sessions/[id]/file-transfers`,
  `/api/sessions/[id]/file-transfers/[transferId]`).
- No live smoke test was possible against the deployed app from this
  VM (no browser, no Neon access) — see §6.

## 6. What still needs live verification (NOT verified)

1. **Two-browser file transfer test:** two accounts with an approved
   session and `file_transfer` grants — sender offers a small file,
   receiver approves, chunks flow, progress moves on both sides,
   receiver downloads an identical file (byte-compare); reject path;
   oversize (>50 MB) refusal on both sides; cancel mid-transfer.
2. **Location prompt test:** owner starts sharing, the browser prompt
   appears, the peer sees coordinates + OpenStreetMap link, both
   sides show the indicator; deny the prompt (no indicator, honest
   message); Stop ends sharing on both sides.
3. **Interaction kill-switch test:** owner allows interaction,
   participant's pointer shows as a remote cursor on the owner's
   view, owner presses Kill interaction now — interaction ends
   immediately on both sides while the session keeps running.
4. **Notification feed test with a real reporting device:** only
   possible once a Milestone 6 Android device sends real
   notifications — the web feed must stay empty until then, and must
   render a received notification with app/title/body/time.
5. **Migration + deploy:** apply `0003_file_transfers_update.sql` to
   Neon, then deploy with the existing Vercel project (no env
   changes, no region change).

## 7. Known limits (honest)

- **Remote interaction is in-page only.** No OS-level input, no
  control of the remote device outside the shared view. Stated in
  the UI, README, and docs.
- **Web sends no notification data.** The feed is empty in a pure
  web session by design; it fills only from a real reporting device.
- **File transfer:** 50 MB max, 16 KiB chunks, one transfer at a time
  per side in the UI, no resume after a dropped connection (re-offer
  the file). No server storage by design.
- **Location:** browser Geolocation only (accuracy depends on the
  device); updates throttled to one per 5s; no background reporting.
- **Two-browser behaviour is unverified** (see §6) — the channel
  setup, state machines, and validation are unit-tested at the logic
  layer and type-checked end to end, but no real session has run.

## 8. Push

Pushed to GitHub `giveandtake349-sys/nexvora`, branch `main`, via
the snapshot-push procedure. Commit SHA: _see parent report / sync
record_ (filled in after the provider confirms success).
