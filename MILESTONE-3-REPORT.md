# NEXVORA — Milestone 3 Final Report

**Date:** Nov 25, 2026
**Scope:** Live media over WebRTC (screen / camera / microphone / speaker),
on top of the Milestone 2 signaling API — no second signaling path.
**Status:** Code complete and verified locally (build / lint / tests all
pass). **Live verification is still pending** — no two-browser call test
has run (no browser, no Neon access from the build VM).

## 1. Hard consent boundary — no stealth monitoring (stated explicitly)

**No stealth / hidden-monitoring capability was built in this
milestone, and none will be.** The rules from Milestones 1–2 apply in
full and are restated in the code (`lib/webrtc.ts`, `components/
LiveSession.tsx`):

- **NO stealth mode, NO hidden indicators, NO silent screen capture.**
  Screen sharing is explicitly started by the device owner via
  `getDisplayMedia` — the browser/OS system dialog + persistent OS
  indicator are never bypassed, hidden, or worked around. If the owner
  cancels the system dialog, nothing happens: no error state, no fake
  "sharing" indicator.
- A NEXVORA grant alone never turns on a camera, microphone, or screen.
  Every track starts only from an explicit button click + the browser
  prompt, and every active feature shows a visible indicator on the
  remote device.
- The owner can stop/revoke instantly (Stop buttons, the browser's own
  "Stop sharing", End session, or revoking the grant — revocation ends
  the session server-side and tears the call down immediately).
- Nothing is shown as active unless a real connection exists: the LIVE
  indicator appears only when the peer connection is actually
  `connected`; every other phase shows its own honest state.
- If a feature could not be built within these rules, it was left out
  and is named in §6 — the rules were not weakened.

## 2. What was built

### How the Milestone 2 signaling API is used (exactly as specified)

`lib/signaling-client.ts` is the browser half of the Milestone 2 API.
It calls **only** the five M2 endpoints plus disconnect — no second
signaling path was invented:

| Call | Endpoint | Use |
| --- | --- | --- |
| `start()` | `POST /api/sessions/[id]/start` | Join: `created` → `connecting`. A 403 here means the grant is gone → revoked state. |
| `send(kind, payload)` | `POST /api/sessions/[id]/signal` | Sends `offer` / `answer` / `ice-candidate` / `bye` / `session-state`. Returns the server `seq`. |
| `poll(after)` | `GET /api/sessions/[id]/signal?after=<seq>` | Short-poll, validates the response shape (`parsePollResponse`) before trusting it. |
| `heartbeat()` | `POST /api/sessions/[id]/heartbeat` | Every 10s (`HEARTBEAT_INTERVAL_MS`). A 403 revokes; any other failure is transient. |
| `setState(state)` | `POST /api/sessions/[id]/state` | Best-effort `live` when the peer connection connects. |
| `disconnect()` | `POST /api/sessions/disconnect` | End session (after sending `bye`, so the peer hears it first). |

The poller (`createSignalPoller`) polls every ~2s (the server-returned
`poll_interval_ms`), never fires two polls concurrently, backs off
exponentially on consecutive failures (2s → 4s → 8s → … capped at 30s,
`nextPollDelayMs`), and stops itself on revocation (403 or
`grantsValid: false`) or session end (`signaling_state` ended/revoked).
It never loops forever and never tight-loops on a dead network.

### Peer connection — `components/LiveSession.tsx`

One `RTCPeerConnection` per live session, STUN-only ICE (see §6).
**Fixed roles, so the handshake can never glare:** the participant
creates the offer; the device owner waits for it and answers. The
offerer creates the `nexvora-control` data channel; the answerer
receives it via `ondatachannel`. ICE candidates that arrive before the
remote description is set are queued and flushed once it is set.

Joining is an explicit **Join live session** button (not auto-start on
mount): the click is the user gesture browsers need to allow remote
audio/video autoplay with sound, and it means no session starts before
the user is ready. Joining calls the M2 start endpoint — it never
creates a session (sessions still come only from the Milestone 1
approval flow; the page refuses non-parties and non-active sessions
server-side).

### Screen share

Owner clicks **Share screen** → `getDisplayMedia({ video: true,
audio: false })` → track added to the peer connection only after the
owner approves the system dialog. Cancelling the dialog
(`NotAllowedError` / `AbortError`) is a silent no-op. Stopping — the
button, or the browser's own "Stop sharing" (`track.onended`) — removes
the track (`removeTrack` + `track.stop()`) and notifies the peer over
the control channel. The peer labels the incoming track as "screen"
from the control message's `trackId`, not by guessing.

### Camera + microphone (grant-gated publishing)

`getUserMedia` for camera (720p ideal) and mic (echo cancellation +
noise suppression), same explicit-click rule. **Grant model:** a side
may publish a track only for a scope it holds a live grant for. The
server page (`app/dashboard/sessions/[id]/page.tsx`) computes the valid
scopes — owner implicitly holds all four on their own device, a
participant gets only scopes with a live, unrevoked, unexpired grant —
and the client never decides grant validity itself. Buttons for
ungranted scopes are disabled with an explanation. Mute (mic) and
camera on/off actually enable/disable the tracks (`track.enabled`) and
are signalled to the peer as `mute-state` control messages; the peer's
mute state is shown in the track list.

### Speaker (separate from mic)

The remote audio plays in its own `<audio>` element with a separate
mute button + volume slider. It is never conflated with the microphone
mute: muting the mic never mutes the speaker and vice versa. Playing
remote audio needs the `speaker` scope (or being the device owner);
without it the controls are disabled with an explanation. Note on the
scope's meaning: its Milestone 1 wording ("play audio on the remote
device speaker") is about remote output; in the Milestone 3 web session
it gates local playback of the incoming audio, because that is the
speaker control the web session actually has. Documented in
`docs/limitations.md`.

### Session UI — dedicated page `/dashboard/sessions/[id]`

Chosen over embedding the call in the Remote Access page: a live call
wants the full screen (remote video, controls, track states) and a deep
link the other side can open directly; the Remote Access page stays the
permission workspace and links here for every active session (as does
the Overview page's active-sessions list). The view shows: session /
device, LIVE indicator (only when actually connected), which local and
remote tracks are active, both sides' mute states, connection state
(`waiting` / `connecting` / `live` / `reconnecting` / `failed` /
`ended` / `revoked` / `peer-disconnected`), peer liveness, control-
channel state, and a prominent **End session** button.

### Data channel — `nexvora-control`

One channel, created by the offerer. Message types (validated strictly
in `lib/webrtc.ts` `parseControlMessage` — malformed or unknown
messages are ignored, never crash the session):

- `mute-state` `{ micMuted, cameraOff }`
- `track-started` `{ track, trackId }` / `track-stopped` `{ track, trackId? }`
- `kill-switch` — the owner ends the session for the other side now;
  the receiver tears down and sees "ended by the device owner".

Documented as the channel Milestone 4 will extend for file transfer /
location / remote interaction. **No M4 features are built here.**

### Graceful failure handling

- **Peer disconnects:** `bye` signal, poll reporting the session
  ended, or a stale peer heartbeat (30s) after the call was live →
  tear down the peer connection, stop all local tracks, show
  "Peer disconnected" / "Session ended". (Before the call was ever
  live, `peer_alive: false` just means "not joined yet" — it does not
  tear anything down.)
- **Grant revoked mid-session:** poll `grantsValid: false` or any 403
  (start / send / poll / heartbeat) → tear down immediately, stop all
  tracks, show "Access revoked by owner". A stream is never kept alive
  after revocation.
- **ICE failure:** `connectionState === "failed"` → clear failure state
  (explaining the no-TURN limit) with a manual **Retry** button. Retry
  replaces the peer connection, re-attaches any still-live local tracks,
  and re-runs the handshake. Nothing retries in a loop.
- **Leaving the page without pressing End** sends no `bye` — the peer
  learns about it from the stale heartbeat and the dropped connection
  (documented in `docs/limitations.md`).
- **Renegotiation when the owner adds a track mid-call:** the
  participant renegotiates on receiving the `track-started` control
  message (fallback: a `session-state` signaling message with
  `{ renegotiate: true }` if the data channel is not open yet).

### Pure helpers — `lib/webrtc.ts`

ICE config (STUN only + a `iceConfigHasTurn` guard), the control-
channel message format + validation, the live-phase state machine
(`transitionLivePhase` — `ended`/`revoked` terminal, `failed` /
`peer-disconnected` allow one manual retry), poll backoff, and the
grant model (`canPublishTrack`, `canPlayRemoteAudio`).

## 3. Files created / modified

### Created (6)
- `lib/webrtc.ts` — pure WebRTC rules (ICE, control channel, phase
  machine, backoff, grant model).
- `lib/signaling-client.ts` — browser signaling client + poller over
  the M2 API (injectable fetch for tests).
- `lib/__tests__/webrtc.test.ts` — 17 unit tests.
- `lib/__tests__/signaling-client.test.ts` — 11 unit tests.
- `components/LiveSession.tsx` — the live session view (client
  component: peer connection, media capture, controls, failure states).
- `app/dashboard/sessions/[id]/page.tsx` — dedicated session page
  (server component: party + active checks, server-computed scopes).

### Modified (5)
- `lib/permissions.ts` — screen/camera/microphone/speaker descriptions
  now state the M3 live behaviour honestly (owner-started, grant alone
  never switches anything on, speaker separate from mic).
- `app/dashboard/remote-access/page.tsx` — "Live sessions" section
  (active sessions with Join links); scope cards no longer say "Coming
  in Milestone 3" for the four live scopes; M4 scopes still do.
- `app/dashboard/page.tsx` — active sessions get a "Join live session"
  link.
- `README.md` — Milestone 3 state, "How live sessions work" section,
  no-new-migration note, updated project structure.
- `docs/limitations.md` — M2/M3 marked built; new honest limits
  section (STUN-only, ICE-candidate queueing, renegotiation path,
  no-`bye`-on-page-leave, speaker-scope interpretation).

### Unchanged (as required)
- `db/migrations/0001_init.sql`, `0002_signaling.sql`, `.env.local`,
  `vercel.json` (region `sin1` stays), `~/MEMORY.md`, live test data.
- **No new migration file:** Milestone 3 stores nothing new
  server-side — signaling rides on the 0002 tables and control
  messages ride on the data channel. **Nothing needs applying.**

## 4. Verification (real numbers, Nov 25, 2026)

- `npm test` — **86 passed, 6 skipped** (9 files). New: 17 WebRTC
  tests + 11 signaling-client tests (endpoint paths/methods, 403
  surfacing, poll-response validation, poller delivery / revocation
  stop / session-end stop / exponential backoff). The 6 skipped are
  the live-DB integration tests — they need
  `NEXVORA_TEST_DATABASE_URL` pointing at a throwaway database.
- `npm run lint` — **clean, 0 errors, 0 warnings.**
- `npm run build` — **passes** (Next.js 16.4.6, Turbopack, TypeScript
  strict). The build caught two real type errors during the run
  (SDP payload guard not narrowing to `RTCSdpType`; `track.kind`
  typed as `string`) — both fixed, `tsc` then clean. The new route
  appears in the route table (`/dashboard/sessions/[id]`, dynamic).
- No live smoke test was possible against the deployed app from this
  VM (no browser, no Neon access) — see §5.

## 5. What still needs live verification (NOT verified)

1. **Two-browser live call test** (never live-tested): two accounts
   with an approved session — both join `/dashboard/sessions/[id]`,
   the participant's offer reaches the owner via polling, the peer
   connection reaches `connected`, LIVE shows on both sides, and the
   control channel opens.
2. **Screen-share OS dialog test:** owner clicks Share screen, the
   system dialog appears, the remote side sees the screen, the owner
   cancels the dialog on a second attempt (no error, no indicator),
   and the browser's own "Stop sharing" ends the share cleanly.
3. **Camera/mic + speaker test:** owner starts camera + mic, the
   participant sees video and hears audio, mic mute and camera off
   actually pause the tracks and show on the peer, speaker mute/volume
   work independently of mic mute.
4. **Revoke-mid-call test:** revoke the participant's grant while live
   — the next poll/send must 403, both sides tear down immediately,
   all tracks stop, "Access revoked" shows. Also: End session (peer
   sees `bye`), peer closes the tab (peer-disconnected via stale
   heartbeat), and ICE failure behind a strict NAT (failure state +
   manual Retry).
5. **Deploy** — the new page + component deploy with the existing
   Vercel project (no env changes, no region change, no migration).

## 6. Known limits (honest)

- **No TURN server.** The peer connection uses only the public Google
  STUN server (`stun:stun.l.google.com:19302`). No TURN credentials
  exist and none is faked. Direct P2P can fail behind symmetric NATs
  or restrictive firewalls; the UI says so and offers a manual retry.
  A TURN server is a future deployment item.
- **Screen share is video-only** (`getDisplayMedia` audio is not
  requested) — system-audio sharing is not part of this milestone.
- **No simulcast / adaptive bitrate / recording.** One peer
  connection, default browser negotiation.
- **Two-browser behaviour is unverified** (see §5) — the handshake,
  renegotiation, and revoke-mid-call paths are unit-tested at the
  logic layer and type-checked end to end, but no real call has run.
- File transfer, location, and remote interaction remain Milestone 4
  (the `nexvora-control` channel is ready for them; nothing is built).

## 7. Push

Pushed to GitHub `giveandtake349-sys/nexvora`, branch `main`, via
the snapshot-push procedure. Commit SHA: _see parent report / sync
record_ (filled in after the provider confirms success).
