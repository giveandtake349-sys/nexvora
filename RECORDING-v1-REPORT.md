# Session Recording v1 — Report (Nov 25, 2026)

Feature #1 from the Opus top-5 list (user picked #1, Nov 25 20:21):
record the remote stream of a live session and replay it in-app.

## What was built

- **Recorder (web only, no Android changes):** the viewer records the
  remote stream with MediaRecorder — screen video preferred, camera
  video as fallback, remote microphone audio — into a `.webm` file
  (1-second chunks, best supported mime: vp9/opus → vp8/opus → vp9 →
  webm → browser default). 1-hour auto-stop cap.
- **Owner consent (hard gate):** the participant sends
  `recording-request` over the `nexvora-control` channel; the owner
  approves/declines in-session. The owner recording their own session
  is self-approved. The owner can revoke mid-recording
  (`recording-revoke`) and the recorder stops immediately. Both sides
  always see a red REC indicator while recording is active. Audit:
  `recording.started` / `recording.stopped` via
  POST /api/sessions/[id]/events (new allowlist actions; the events
  route gates recording actions on ANY live screen/camera/microphone
  grant — "any-media" — owner exempt).
- **Storage v1 — client-side only:** recordings are saved in the
  viewer's browser IndexedDB (`nexvora-recordings` DB, `recordings`
  store: metadata + Blob chunks). Nothing is uploaded, nothing is in
  Postgres, NO migration.
- **Replay page:** `/dashboard/recordings` — list (newest first) with
  in-app playback, Download .webm, Delete. Linked in the dashboard
  nav. The page states plainly that recordings live only in this
  browser and that clearing site data deletes them.
- **Safety rails:** recording never auto-starts; session teardown /
  revoke / peer-leave stops the recorder but still saves the file via
  onstop; a save failure is reported honestly instead of pretending
  the file exists; the record button is disabled until a remote track
  is live and the control channel is open.

## Files changed

- New: `lib/recording.ts` (consent state machine, track picking, mime
  pick, formatting), `lib/recordings.ts` (IndexedDB store),
  `components/RecordingsList.tsx`, `app/dashboard/recordings/page.tsx`,
  `lib/__tests__/recording.test.ts`,
  `lib/__tests__/recordings-store.test.ts`, `RECORDING-v1-REPORT.md`.
- Edited: `lib/webrtc.ts` (7 control messages), `lib/live-features.ts`
  (2 audit actions + any-media scope), `app/api/sessions/[id]/events/route.ts`
  (any-media grant check), `components/LiveSession.tsx` (recording
  section + card + REC banner), `components/DashboardShell.tsx` (nav),
  `lib/__tests__/webrtc.test.ts`, `lib/__tests__/live-features.test.ts`,
  `docs/limitations.md`.

## Verification

- `npm run lint` clean; `npm run build` clean (`/dashboard/recordings`
  in the route list); `npm test`: 184 passed, 6 skipped (was 154 —
  +30 new: consent machine, track/mime picks, formatting, IndexedDB
  store against a hand-rolled fake factory, control-message and audit
  validation).
- Live (curl, after Vercel deploy): homepage 200; `/dashboard/recordings`
  signed-out → 307 to /login; events route accepts `recording.started`
  / `recording.stopped` from a signed-in session party (see below).

## Live verification detail (events route)

Verified Nov 25 ~20:40 +03 with the documented test accounts
(e2e-alice / e2e-bob) on a FRESH session created for this check only
(session 33d70551, bob granted `screen` only) — the user's live
session a49e23f5 and test session 0837bce4 were not touched, and both
test devices created for the check were deleted afterwards (grants
revoked, session ended). All 14 checks passed:
- sign-in alice/bob 200; device creates 201; pairing
  generate/redeem 201; approve 200.
- bob (non-owner, live `screen` grant) POST recording.started → 200
  (exercises the new any-media path); recording.stopped → 200.
- alice (owner, exempt) POST recording.started → 200.
- bogus action recording.bogus → 400 (allowlist still enforced).
- signed-out POST → 401.
- homepage 200; /dashboard/recordings signed-out → 307 to /login.
- cleanup: both test devices deleted (200).

## Not verified (needs real devices)

- A real two-browser recording: request → approve → record → stop →
  replay. The cloud browser gathers zero ICE candidates, so a peer
  connection cannot go live there. The consent handshake, the
  MediaRecorder path, and the IndexedDB save are covered by unit
  tests only — not by a live call.
- MediaRecorder mime support varies by browser; the vp9/opus-first
  pick falls back gracefully, but actual .webm playback quality was
  not checked on a real phone.
