# NEXVORA — Known Limitations (Milestones 1–5)

## What is NOT built yet

- **No native Android app.** Milestone 6. The schema carries a `platform`
  field (`web` | `android` | `ios` | `desktop`) so Android trusted-device
  authorization can be added later, subject to Android's permission and
  background-execution restrictions. Android is also the capture route
  for real notification data (NotificationListenerService) — the web
  notification feed stays empty until a real reporting device exists.
- **No TURN server** (see below) and no file storage bucket: files are
  peer-to-peer only by design, never stored server-side.

## What IS built now (Milestones 2–5)

- **Hardening** (Milestone 5): rate limits on every route, security
  headers (no CSP — see below), malformed-uuid / oversized-body /
  race-condition fixes, kill-switch audit, secret sweep, full
  build + lint + test + smoke-test verification. No new features,
  no new migration. See `MILESTONE-5-REPORT.md` — the live
  verification checklist there is still open (migrations 0002 +
  0003 need live application; two-browser live tests need a
  live tests need a
  browser + live Neon). Migrations 0002 + 0003 were applied live in
  the Neon SQL Editor on Nov 25 17:05–17:08 (see
  `MILESTONE-5-REPORT.md` §7) — the remaining live work is the
  two-browser tests, not the migrations.

- **WebRTC signaling** (Milestone 2): DB-backed, short-polled
  offer/answer/ICE over `/api/sessions/[id]/signal`, with per-party
  heartbeats and grant re-checks on every send and delivery.
- **Live screen / camera / microphone / speaker** (Milestone 3): one
  `RTCPeerConnection` per live session (`/dashboard/sessions/[id]`),
  owner-started screen share via `getDisplayMedia`, camera/mic via
  `getUserMedia`, mute state + track started/stopped + kill-switch over
  the `nexvora-control` data channel, speaker playback separate from
  the microphone mute. Live-verified? **Not yet** — the two-browser
  call test, the screen-share OS dialog test, and the revoke-mid-call
  test are still pending (no browser / no Neon access from the build
  VM). See `MILESTONE-3-REPORT.md`.
- **File transfer / location / remote interaction / notification feed**
  (Milestone 4): in the same live session — chunked file transfer over
  a dedicated `nexvora-file` data channel with per-file owner approval
  and a 50 MB limit; location sharing via the browser Geolocation
  prompt (explicit start, both-side indicator); in-page-only remote
  interaction (remote cursor overlay + click/key forwarding, instant
  kill-switch); a notification feed fed only by a real reporting
  device. Live-verified? **Not yet** — the two-browser transfer test,
  the location prompt test, the interaction kill-switch test, and the
  notification-feed test with a real reporting device are still pending
  (no browser / no Neon access from the build VM). See
  `MILESTONE-4-REPORT.md`.

## Live-media limitations (Milestone 3, honest)

- **STUN only — no TURN server.** The peer connection uses only the
  public Google STUN server (`stun:stun.l.google.com:19302`). No TURN
  credentials exist and none is faked. Direct peer-to-peer connections
  can fail when both sides sit behind symmetric NATs or restrictive
  firewalls: the UI shows a clear failure state with a manual Retry
  button. A TURN server is a future deployment item.
- **ICE candidates that arrive before the remote description is set**
  are queued and flushed once it is set; a candidate that still fails
  to apply is dropped (ICE keeps gathering — not fatal).
- **Renegotiation when the owner adds a track mid-call** is triggered
  by the participant on receiving the `track-started` control message
  (or a `session-state` signaling message if the data channel is not
  open yet). If the data channel and the signaling fallback both fail
  to reach the participant, the new track is not picked up until the
  next renegotiation or retry.
- **Leaving the page without pressing End** does not send a `bye` —
  the peer learns about it from the stale heartbeat (peer-disconnected
  after 30s) and the dropped peer connection.
- **Speaker scope interpretation:** playing the remote audio on this
  device requires the `speaker` scope (or being the device owner).
  The scope's original Milestone 1 wording ("play audio on the remote
  device speaker") is about remote output; in the Milestone 3 live
  session it gates local playback of the incoming audio, because that
  is the speaker control the web session actually has.

## Browser limitations

- **Screen sharing** (`getDisplayMedia`) can only be started by an explicit
  user gesture on the sharing device, shows the browser's own sharing
  indicator, and can be stopped by the user at any time from the browser UI.
  NEXVORA cannot start it silently or hide it.
- **Camera / microphone** (`getUserMedia`) require a per-site permission
  prompt, show a persistent browser/OS indicator while active, and cannot be
  activated in the background. Microphone capture and speaker output are
  separate permissions and are treated separately throughout.
- **Location** requires the browser geolocation permission and only reports
  while sharing is active.
- **Remote interaction** in a browser is limited to what web APIs allow:
  a remote-cursor overlay plus click/key forwarding to the shared view
  (Milestone 4). Real remote control of a device needs the native
  Android app (Milestone 6) and Android's accessibility / device-admin
  APIs, which the user must explicitly enable. Milestone 4 never
  presents the in-page interaction as OS-level control.
- **Notifications:** web browsers cannot capture OS notifications, so
  the web side sends no notification data and the feed stays empty
  until a real reporting device (Android NotificationListenerService,
  Milestone 6, owner opts in on their own phone) sends validated
  notification messages. No notification data is faked.
- **File transfer:** 50 MB max per file, 16 KiB chunks, one transfer at
  a time per side in the UI, peer-to-peer only (no server storage, no
  resume after a dropped connection — a failed transfer must be
  re-offered). The receiver must approve every file; the sender's
  declared size is re-checked by the receiver and the server.
- **Online/offline status** is derived from `last_seen_at` heartbeats
  (online = seen in the last 5 minutes). It is not a live socket presence
  signal in Milestone 1.
- **Rate limiting** is in-memory per server instance (Milestone 5:
  every route is now limited — see the table in
  `lib/rate-limit.ts`). On a multi-instance deployment it must move
  into Postgres (or Redis) — the limiter is a single function
  (`lib/rate-limit.ts`) so the swap is one file. Do not present it
  as distributed rate limiting.
- **No Content-Security-Policy yet** (Milestone 5, deliberate): a
  strict CSP needs per-request nonces plumbed through `proxy.ts`
  for Next.js's inline runtime scripts and Tailwind v4's injected
  styles. That cannot be verified safe from this build VM (no
  browser), and an unverified CSP risks breaking the app in
  production — so the other four headers shipped and CSP is a
  future item for a browser-verified pass.
- **Raw request-body caps** (Milestone 5): signaling bodies are
  capped at 128 KiB raw (64 KiB payload + wrapper) and all other
  JSON bodies at 16 KiB, enforced before JSON.parse — the semantic
  caps (64 KiB signal payload, 2 KiB audit details) were previously
  only checked after an unbounded parse.
- **Login history** in the Security Center is sourced from the audit log in
  Milestone 1. A dedicated auth-event table is a Milestone 2 hardening item;
  no login rows are invented.

## Honest-state rules enforced in this codebase

- The app builds and renders with no Neon project configured, and every
  auth/data surface says so instead of faking a login.
- No page ever shows an "active" remote-access state unless a real
  connection exists.
- No mock data is used as production functionality. `db/seed.sql` is
  clearly marked demo-only and must not be run on production.
- There is no privileged service key in this setup. The database connection
  string and the Neon Auth cookie secret are server-only (never
  `NEXT_PUBLIC_`, never committed, never in client code, never pasted
  into chat). Row Level Security is forced on every table, so even the
  table-owner connection cannot bypass the per-user policies.
