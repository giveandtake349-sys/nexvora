# NEXVORA — Known Limitations (Milestone 1)

## What is NOT built yet

- **No live screen sharing, camera, microphone, or speaker output.** These are
  Milestone 3. The Remote Access cards show them as Disconnected with a
  "Live in Milestone 3" badge. A NEXVORA permission grant alone never turns
  on a camera or microphone.
- **No file transfer, location sharing, or remote interaction.** Milestone 4.
  The `file_transfers` table, RLS policies and the private Storage bucket
  exist already; the transfer flow does not.
- **No WebRTC signaling / live session media.** Milestone 2.
- **No native Android app.** Milestone 6. The schema carries a `platform`
  field (`web` | `android` | `ios` | `desktop`) so Android trusted-device
  authorization can be added later, subject to Android's permission and
  background-execution restrictions.

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

- The app builds and renders with no Supabase project configured, and every
  auth/data surface says so instead of faking a login.
- No page ever shows an "active" remote-access state unless a real
  connection exists.
- No mock data is used as production functionality. `supabase/seed.sql` is
  clearly marked demo-only and must not be run on production.
- The service-role key is server-only (`SUPABASE_SERVICE_ROLE_KEY`, never
  `NEXT_PUBLIC_`, never committed, never in client code).
