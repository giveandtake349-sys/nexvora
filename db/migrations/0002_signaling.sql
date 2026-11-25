-- NEXVORA Milestone 2 — WebRTC signaling (DB-backed, short-polling)
--
-- Design (why DB-backed signaling, not a WebSocket server):
-- Vercel Hobby is serverless — there is no long-lived process to hold a
-- WebSocket server, and a third-party realtime service would add another
-- vendor, another credential, and another place where grant checks could
-- be skipped. Signaling messages are small, infrequent (one SDP
-- offer/answer pair + a handful of ICE candidates per session), and
-- already need the same server-side grant re-checks as every other
-- route. Storing them in Postgres means:
--   - every send and every delivery re-checks the live grant in the
--     same database that owns the grant (no stale in-memory state);
--   - ordering is total and durable (one global sequence);
--   - RLS confines each message to its two session parties;
--   - short-polling (GET .../signal?after=<seq>, ~2s interval) works
--     from any serverless function with no extra infrastructure.
-- Live media itself is NOT in this milestone — signaling only carries
-- the SDP/ICE handshake; screen/camera/mic arrive in Milestone 3.
--
-- Tables/columns added:
--   - public.signaling_messages (new) + sequence signaling_message_seq
--   - public.remote_sessions.signaling_state ('created' | 'connecting'
--     | 'live' | 'ended' | 'revoked')
--   - public.remote_sessions.owner_last_heartbeat_at /
--     participant_last_heartbeat_at (per-party heartbeats — one shared
--     column could not tell the parties apart, so liveness of the peer
--     would be unknowable; a separate heartbeat table would be a second
--     write per heartbeat for no benefit at this scale)
--   - device_permissions.scope CHECK extended to a 9th scope,
--     'notifications' (0001 is already applied live and is never
--     edited, so the CHECK is replaced here — see below).
--
-- Apply with the Neon SQL Editor (or psql against
-- DATABASE_URL_UNPOOLED). Do NOT re-run 0001_init.sql.
-- This migration is NOT applied by the app and has NOT been run against
-- a live database yet (no Neon access from the build VM).

-- ---------------------------------------------------------------------------
-- signaling_messages
-- ---------------------------------------------------------------------------

-- One global sequence: seq is strictly increasing across ALL sessions,
-- so `seq > after` polling gives a total order per session and a client
-- can never miss or double-deliver a message by polling with the last
-- seq it saw. (A per-session sequence would need a lock per session to
-- allocate gaplessly; the global sequence is lock-free.)
create sequence public.signaling_message_seq;

create table public.signaling_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.remote_sessions (id) on delete cascade,
  sender_user_id text not null references public.profiles (id) on delete cascade,
  recipient_user_id text not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in (
    'offer', 'answer', 'ice-candidate', 'bye', 'session-state'
  )),
  -- SDP offer/answer, ICE candidate, or a small control payload.
  -- The API enforces a 64 KiB JSON limit (lib/signaling.ts); the column
  -- itself is jsonb so malformed payloads can never be stored.
  payload jsonb not null default '{}'::jsonb,
  seq bigint not null default nextval('public.signaling_message_seq'),
  created_at timestamptz not null default now()
);
-- Poll query: messages for one recipient, after a seq, in seq order.
create index signaling_messages_poll_idx
  on public.signaling_messages (recipient_user_id, seq);
create index signaling_messages_session_idx
  on public.signaling_messages (session_id, seq);
create index signaling_messages_created_idx
  on public.signaling_messages (created_at);

-- ---------------------------------------------------------------------------
-- remote_sessions — lifecycle columns
-- ---------------------------------------------------------------------------

alter table public.remote_sessions
  add column signaling_state text not null default 'created'
    check (signaling_state in ('created', 'connecting', 'live', 'ended', 'revoked')),
  add column owner_last_heartbeat_at timestamptz,
  add column participant_last_heartbeat_at timestamptz;

-- Backfill: sessions that were already active before signaling existed
-- are live sessions; ended/revoked ones keep their terminal state.
-- (signaling_state is kept in sync with status by the API routes from
-- here on: ending a session sets both, revoking sets both.)
update public.remote_sessions set signaling_state = 'live' where status = 'active';
update public.remote_sessions set signaling_state = 'ended' where status = 'ended';
update public.remote_sessions set signaling_state = 'revoked' where status = 'revoked';

create index remote_sessions_signaling_state_idx on public.remote_sessions (signaling_state);

-- ---------------------------------------------------------------------------
-- device_permissions — 9th scope: "notifications" (Milestone 2 addition)
-- ---------------------------------------------------------------------------
-- 0001_init.sql constrained device_permissions.scope with an inline
-- CHECK over the 8 original scopes. 0001 is already applied live and
-- must NEVER be edited, so the CHECK is replaced here. The inline
-- CHECK's auto-generated name is device_permissions_scope_check
-- (verified against the 0001 definition); `if exists` keeps this safe
-- if the name ever differs. The new CHECK lists all 9 scopes — the 8
-- existing ones untouched, plus 'notifications'.
--
-- HONEST BOUNDARY (non-negotiable): there is no Facebook/Messenger API
-- for reading a personal inbox and no app may log in to someone's
-- Facebook account, so this scope grants nothing of that kind. It
-- covers the device's own notification feed (including Messenger
-- notification previews the device itself reports) while sharing is
-- active — granted explicitly by the owner, with a visible indicator
-- on the remote device, and revocable instantly, exactly like the
-- other 8 scopes. There is NO stealth mode: no hidden indicators, no
-- silent screen capture, no background notification reading without
-- the owner's knowledge, and no bypass of OS consent (screen-capture
-- prompt, camera/mic indicators, notification-listener opt-in). The
-- feed UI/transport is Milestone 4 work (over the Milestone 2
-- signaling / Milestone 3 data-channel path — no second channel);
-- on-device capture (Android NotificationListenerService, owner opts
-- in on their own phone) is Milestone 6. No notification data is
-- faked anywhere.
alter table public.device_permissions drop constraint if exists device_permissions_scope_check;
alter table public.device_permissions
  add constraint device_permissions_scope_check
  check (scope in (
    'screen', 'camera', 'microphone', 'speaker',
    'file_transfer', 'location', 'remote_interaction', 'device_info',
    'notifications'
  ));

-- ---------------------------------------------------------------------------
-- Row Level Security (forced — the app connects as table owner)
-- ---------------------------------------------------------------------------

alter table public.signaling_messages enable row level security;
alter table public.signaling_messages force row level security;

-- A message is visible only to its sender and its recipient.
create policy "signaling_messages_select_parties" on public.signaling_messages
  for select using (
    sender_user_id = public.current_app_user_id()
    or recipient_user_id = public.current_app_user_id()
  );

-- Insert: the sender must be the caller AND the recipient must be the
-- other party of the session the message belongs to. The recipient is
-- therefore derived server-side by the API (never trusted from the
-- client) and re-checked here as a second layer.
create policy "signaling_messages_insert_sender" on public.signaling_messages
  for insert with check (
    sender_user_id = public.current_app_user_id()
    and exists (
      select 1 from public.remote_sessions rs
      where rs.id = signaling_messages.session_id
        and (
          (rs.owner_id = public.current_app_user_id()
           and rs.participant_user_id = signaling_messages.recipient_user_id)
          or (rs.participant_user_id = public.current_app_user_id()
           and rs.owner_id = signaling_messages.recipient_user_id)
        )
    )
  );

-- No UPDATE or DELETE policies: signaling messages are immutable and
-- are removed only by session deletion (ON DELETE CASCADE). Any update
-- or delete attempt is denied by RLS.
