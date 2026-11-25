# NEXVORA — Claude Coding Prompt (Milestone 1 ONLY)

Copy everything below the line and paste it to Claude as one prompt.
Do NOT add Milestone 2–6 work to this prompt.

---

You are a senior full-stack engineer, security architect, and premium SaaS product designer.

Build NEXVORA — a production-oriented, web-first Remote Device Access & Management Platform. This is a REAL software project, not a static UI prototype. Implement working authentication, database operations, device registration, pairing, permission management, and session management. Never represent a simulated feature as functional. Do not use mock data as production functionality. Do not fabricate successful API calls.

## 0. SCOPE — MILESTONE 1 ONLY

Build ONLY Milestone 1 in this task:
Brand foundation, landing page, authentication, database, device registration, secure pairing, approval and revocation.

DO NOT build in this task:
- Milestone 2: Remote session architecture, WebRTC signaling, session lifecycle
- Milestone 3: Screen sharing, camera sharing, microphone streaming, two-way audio, speaker output
- Milestone 4: File transfer, location sharing, remote interaction
- Milestone 5: Production hardening / deployment (beyond a working local build + Vercel-ready config)
- Milestone 6: Native Android app

If a later-milestone feature is referenced in the UI, show it as "Coming in Milestone 2/3/4 — not available yet" with a DISABLED button. Never show it as active or working.

Work incrementally. Preserve existing working code. Do not rewrite the whole app unnecessarily.

## 1. BRAND IDENTITY

- Name: NEXVORA
- Tagline: ONE ECOSYSTEM. EVERY DEVICE.
- Visual style: Premium Futuristic
- Logo: Geometric Tech Symbol (build a clean inline SVG logo, no stock image)
- Primary background: #080D12
- Primary accent: #00E5A8
- Secondary accent: #D4AF37
- UI: Premium dark interface, clean typography, subtle gradients, glass effects, precise spacing. Avoid a generic template look. Maintain one consistent custom NEXVORA design system (shared Tailwind tokens / CSS variables, shared Button / Card / Input / Badge components).

## 2. TECH STACK (do not substitute)

- Next.js (App Router) + TypeScript (strict) + Tailwind CSS
- Supabase Authentication (email/password + Google OAuth + email verification + password recovery)
- Supabase PostgreSQL + Supabase Row Level Security (RLS)
- Supabase Realtime (only where Milestone 1 needs it: connection requests / session status updates)
- Supabase Storage (set up the bucket + policies only; do NOT build file transfer in Milestone 1)
- Vercel deployment-ready (no hardcoded localhost URLs, env-based config)
- Keep the architecture modular and API-driven so a native Android app can be added later using the same backend (all business logic in API routes / Supabase, never only in the browser).

## 3. AUTHENTICATION (must be real, via Supabase Auth)

Implement all of these, wired to Supabase Auth — not localStorage fake auth:
- Email registration + email verification
- Email/password login
- Google OAuth
- Password recovery (forgot / reset)
- Secure logout
- User profile (name, avatar/initials, email — editable display name)
- Protected dashboard (unauthenticated users are redirected to /login)
- Session management (Supabase session, middleware route protection)

## 4. PERSONAL AND UNIVERSAL MODES

- Personal Mode: users manage their own registered devices.
- Universal Mode: users can request permission to connect to another user's device.
- Every new connection requires explicit approval from the device owner. No auto-approve, no silent access.

## 5. TRUSTED DEVICE & ONE-TIME AUTHORIZATION SYSTEM (core of this milestone)

This is the most important part. Implement it exactly as specified:

### 5.1 Initial pairing — owner chooses permissions
During initial pairing, the device owner must see the requesting user + requesting device, and a permission checklist they can select/deselect BEFORE approving. Permission scopes for Milestone 1 (grantable, but NOT yet usable for live media — live media is Milestone 2/3):
`screen`, `camera`, `microphone`, `speaker`, `file_transfer`, `location`, `remote_interaction`, `device_info`
Only the permissions the owner approves become available. Nothing else.

### 5.2 Persist grants securely in the backend
Save every approved application-level grant in the `device_permissions` table, associated with:
- owner account (owner_id)
- trusted device ID (device_id — the device being accessed)
- requesting account (granted_to_user_id)
- permission scope (one row per scope, or a scopes array — pick one and document it)
- grant timestamp (granted_at)
- expiration policy (expires_at — set a default, e.g. 30 days, and let the owner change it; NULL only if the owner explicitly chose "no expiry", and show that clearly in the UI)
- revocation status (revoked_at, revoked_by, is_revoked)

Never store raw sensitive credentials. Never store passwords, tokens, or pairing secrets in plaintext (see §6).

### 5.3 Reuse on reconnect — no repeated approval
When the same trusted device reconnects (same device fingerprint / device_id + same requesting user), reuse valid previously approved application-level permissions WITHOUT repeating the whole authorization workflow. Check validity server-side on every connection attempt: grant exists, not revoked, not expired, device identity matches, no security event flag.

### 5.4 Re-authorization is required ONLY when:
- A new permission is requested (approve only the new scope; keep the old valid grants)
- The device identity changes (new device_id / fingerprint mismatch)
- The authorization expires
- The owner revokes access
- A security event requires reauthorization

Do NOT ask for approval repeatedly for permissions that remain valid.

### 5.5 Separate NEXVORA authorization from OS / browser permissions — HARD RULE
NEXVORA application-level authorization is SEPARATE from native Android and browser permissions.
- Never bypass browser permission prompts, Android runtime permissions, screen-capture consent, camera indicators, microphone indicators, or operating-system security controls.
- Screen sharing must be explicitly started by the device owner when required by the browser or OS.
- In Milestone 1, do NOT implement live screen/camera/mic capture at all. Add clear in-UI text: "Live screen / camera / microphone require explicit OS + browser consent at use time (Milestone 3). A NEXVORA grant alone never turns on a camera or microphone."

### 5.6 Trusted Devices management page
Build `/dashboard/trusted-devices` where owners can:
- View authorized devices (device name, OS/browser, last seen, owner, granted-to user)
- Review granted permissions per device
- Change application-level access (add/remove a scope — removing takes effect immediately; adding a scope requires the owner's own confirmation)
- Revoke a device (one click)
- Disconnect active sessions for that device

### 5.7 Revocation is immediate
Revocation must immediately invalidate the corresponding authorization AND terminate affected active sessions server-side. A revoked grant must fail the next server-side permission check even if the frontend still shows a cached state. Log it (see §9).

### 5.8 Future Android
Design the schema + API so persistent Android trusted-device authorization can be added later, subject to Android permission and background-execution restrictions. Do NOT claim Android support now. Add a `platform` / `device_type` field (`web` | `android` | `ios` | `desktop`) and a code comment noting Android is future work.

IMPORTANT: One-time authorization means avoiding unnecessary repeated application-level approval. It does NOT mean permanent unrestricted access or bypassing operating-system consent.

## 6. DEVICE PAIRING (secure temporary pairing)

Workflow — implement all 9 steps:
1. Device A generates a temporary pairing code.
2. Device B enters the code.
3. Device A receives a connection request.
4. Device A sees the requesting user and device.
5. Device A reviews requested permissions (checklist, §5.1).
6. Device A approves or rejects.
7. Only approved permissions become available.
8. Both users can see the active session.
9. Either user can terminate the connection.

Security — implement ALL of these, server-side:
- Cryptographically secure random pairing secrets (`crypto.randomBytes` / `crypto.getRandomValues`, minimum 128-bit entropy; 6-digit display code derived from it, never the secret itself)
- Short expiration (10 minutes max)
- Single-use codes (mark used on first successful validation; second use fails)
- Server-side validation (never validate the code only in the browser)
- Hashed pairing secrets in the database (SHA-256 hash, never plaintext; compare hashes)
- Rate limiting (max 5 pairing attempts per user per 10 minutes, then block with a clear error; also rate-limit code generation)
- Replay prevention (used / expired codes cannot be reused)
- Session revocation
- Audit logs (see §9)

A pairing code must NEVER independently grant access. The code only creates a connection REQUEST. Access requires the owner's explicit approval + a valid grant.

## 7. DEVICE MANAGEMENT

Implement:
- Multiple device registration (register current browser/device, with a user-chosen device name)
- Device naming / renaming
- Online/offline status + last seen (heartbeat / last_seen_at updated on activity; offline = no heartbeat for >5 minutes — compute it, don't hardcode)
- Browser and OS details where available (from User-Agent, parsed server-side or with a small parser — store what you can detect, never invent it)
- Trusted device management (§5.6)
- Device removal (owner only, with confirmation; removal revokes its grants and ends its sessions)
- Session history (list past sessions with start/end, users, devices, status)

## 8. REMOTE ACCESS WORKSPACE (Milestone 1 = shell + permissions only)

Create `/dashboard/remote-access` with 8 feature cards:
1. Screen Sharing, 2. Camera, 3. Microphone, 4. Speaker / Audio, 5. File Transfer, 6. Location, 7. Device Information, 8. Remote Interaction

Each card must display: permission status, connected/disconnected state, Request Access button, active indicator, Stop/Revoke button.

HARD RULE: Never display an active state unless the corresponding real connection exists. In Milestone 1 there is NO live media, so all live cards show Disconnected / Not available yet, with Request Access creating a permission request (not starting a stream). Device Information may show real data (device name, OS/browser, last seen) because that data exists. Microphone capture and speaker output are SEPARATE permissions — never merge them.

## 9. SECURITY CENTER + AUDIT LOGS

Create `/dashboard/security` with:
- Active sessions (with Disconnect)
- Pending connection requests (Approve / Reject with permission checklist)
- Permission history (grants, changes, revocations)
- Login history (from Supabase Auth events you record — do not invent logins)
- Security events (pairing failures, revoked access, expired grants, rate-limit blocks)
- Device revocation + Disconnect all sessions
- Session expiration display

Audit logs: write a row to `security_events` (and `session_events` for session actions) for EVERY grant, permission change, revocation, pairing attempt outcome, approval, rejection, session start/end, and disconnect. Include actor, target device/user, action, timestamp, IP/User-Agent where available. Show these logs in the Security Center. Enforce authorization server-side, not just through frontend controls — every API route must re-check ownership / grant validity.

## 10. DATABASE — versioned migrations

Create versioned SQL migrations (e.g. `supabase/migrations/0001_...sql`, `0002_...sql`) for ALL of these tables, with foreign keys, indexes, constraints, and strict RLS policies:
`profiles`, `devices`, `pairing_invitations`, `connection_requests`, `device_permissions`, `remote_sessions`, `session_events`, `security_events`, `notifications`, `file_transfers`

Rules:
- Users must never access another user's private device data without explicit authorization — enforce this in RLS, not just in the UI.
- `profiles`: id (FK to auth.users), display_name, avatar_url, created_at, updated_at.
- `devices`: id, owner_id, name, device_fingerprint (unique per owner), platform, browser, os, last_seen_at, is_online (computed or maintained), is_trusted, created_at.
- `pairing_invitations`: id, inviter_device_id, code_hash, display_code_hint (last 2 chars only, never the full code), expires_at, used_at, status, created_at.
- `connection_requests`: id, requester_user_id, requester_device_id, target_device_id, owner_id, requested_scopes, status (pending/approved/rejected/expired), decided_at, created_at.
- `device_permissions`: id, owner_id, device_id, granted_to_user_id, scope, granted_at, expires_at, revoked_at, revoked_by, is_revoked.
- `remote_sessions`: id, connection_request_id, device_id, owner_id, participant_user_id, status (active/ended/revoked), started_at, ended_at.
- `session_events`, `security_events`: id, session_id/device_id/user_id as applicable, actor_id, action, details (JSONB), created_at.
- `notifications`: id, user_id, type, title, body, related_id, is_read, created_at.
- `file_transfers`: table + RLS only in Milestone 1 (no transfer UI/flow yet).
- Add indexes on: owner_id, device_id, granted_to_user_id, status, expires_at, created_at.
- Add a Postgres function or trigger for `updated_at` where needed. Include a `supabase/seed.sql` ONLY with obviously fake demo data clearly marked as seed — never seed it as real user data in production, and never let seed data bypass RLS.

## 11. UI / PAGES (all routes real, no dead links)

- Public landing page `/` — NEXVORA brand, tagline, features, Milestone 1 scope honestly stated, Login / Get Started
- `/login`, `/register`, `/forgot-password`, `/reset-password`
- Protected dashboard layout: desktop sidebar navigation + main workspace; mobile responsive cards + compact bottom navigation
- `/dashboard` (overview: my devices, pending requests, active sessions, security summary)
- `/dashboard/devices` (My Devices)
- `/dashboard/connect` (Connect Device — generate code + enter code)
- `/dashboard/requests` (Connection Requests)
- `/dashboard/remote-access` (§8)
- `/dashboard/trusted-devices` (§5.6)
- `/dashboard/security` (§9)
- `/dashboard/history` (Session History)
- `/dashboard/settings` (profile + account)

Every page must handle loading, empty, and error states. No page may show fake "live" data.

## 12. DEVELOPMENT RULES (non-negotiable)

- Work incrementally. Preserve existing working code. Do not rewrite the entire application unnecessarily.
- Do not fabricate successful API calls. Do not use mock data as production functionality.
- Never expose service-role credentials. Service-role key is server-only, never in client code, never in a `NEXT_PUBLIC_` variable, never committed. Use the Supabase anon key + RLS for the browser, and a server-only client for privileged operations.
- Validate every operation server-side (API routes + RLS). Frontend checks are UX only.
- Add automated tests: unit tests for pairing-code hashing/expiry/single-use logic, permission-validity logic (valid / expired / revoked / device-mismatch), and RLS-relevant permission checks; plus a smoke test that `npm run build` passes. Use Vitest or Jest — pick one and document it.
- Document browser limitations and features requiring a future native Android app in `docs/limitations.md`.
- Do not deploy unverified code. Do not claim completion until the implementation has been verified (build passes, tests pass, auth + pairing flow tested end-to-end with two test accounts).

## 13. ENVIRONMENT VARIABLES REQUIRED (placeholders only — never put real secrets in code or chat)

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=        # server-only, never NEXT_PUBLIC_, never committed
NEXT_PUBLIC_APP_URL=http://localhost:3000
```
Also provide `.env.example` with these keys and empty values, and a README section explaining how to create a Supabase project, run the migrations, enable Google OAuth, and set the Site URL / redirect URLs.

## 14. FINAL REPORT — you MUST output this at the end, with real results only

Report exactly:
- Files created (full paths)
- Files modified (full paths)
- Database migrations (filenames + tables created)
- Environment variables required
- Tests executed (command + count)
- Tests passed and failed (real numbers — if a test fails, say so and say why)
- Known limitations (including: no live screen/camera/mic in Milestone 1, browser limitations, Android is future work)
- Exact next steps (Milestone 2 items, in order)

Do not claim completion until the implementation has been verified. The result must be the foundation of a real, secure NEXVORA platform.

---

## END OF PROMPT TO CLAUDE
