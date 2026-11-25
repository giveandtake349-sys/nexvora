# NEXVORA — Known Limitations (Milestones 1–3)

## What is NOT built yet

- **No file transfer, location sharing, or remote interaction.** Milestone 4.
  The `file_transfers` table and RLS policies exist already; the transfer
  flow and its storage (deferred to Milestone 4 — no Storage bucket exists
  yet in the Neon setup) do not.
- **No native Android app.** Milestone 6. The schema carries a `platform`
  field (`web` | `android` | `ios` | `desktop`) so Android trusted-device
  authorization can be added later, subject to Android's permission and
  background-execution restrictions.

## What IS built now (Milestones 2–3)

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
- **Remote interaction** in a browser is limited to what web APIs allow
  (e.g. scrolling a shared page, clicking through a co-browsing layer).
  Real remote control of a device needs the native Android app (Milestone 6)
  and Android's accessibility / device-admin APIs, which the user must
  explicitly enable.
- **Online/offline status** is derived from `last_seen_at` heartbeats
  (online = seen in the last 5 minutes). It is not a live socket presence
  signal in Milestone 1.
- **Rate limiting** for pairing endpoints is in-memory per server instance.
  On a multi-instance deployment it must move into Postgres (or Redis) —
  the limiter is a single function (`lib/rate-limit.ts`) so the swap is
  one file.
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
