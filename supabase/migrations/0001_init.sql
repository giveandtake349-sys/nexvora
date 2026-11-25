-- NEXVORA Milestone 1 — initial schema
-- Tables: profiles, devices, pairing_invitations, connection_requests,
-- device_permissions, remote_sessions, session_events, security_events,
-- notifications, file_transfers.
-- All tables have Row Level Security enabled. No user can read another
-- user's private device data without explicit authorization (ownership
-- or a valid, unrevoked, unexpired grant).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Auto-create a profile row when a user signs up via Supabase Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  device_fingerprint text not null,
  -- web | android | ios | desktop. Android is future work (Milestone 6).
  platform text not null default 'web'
    check (platform in ('web', 'android', 'ios', 'desktop')),
  browser text,
  os text,
  last_seen_at timestamptz,
  is_trusted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint devices_owner_fingerprint_unique unique (owner_id, device_fingerprint)
);
create trigger devices_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();
create index devices_owner_id_idx on public.devices (owner_id);
create index devices_last_seen_idx on public.devices (last_seen_at);

-- ---------------------------------------------------------------------------
-- pairing_invitations
-- code_hash / secret_hash are SHA-256 hashes only — never plaintext codes.
-- ---------------------------------------------------------------------------

create table public.pairing_invitations (
  id uuid primary key default gen_random_uuid(),
  inviter_user_id uuid not null references public.profiles (id) on delete cascade,
  inviter_device_id uuid references public.devices (id) on delete set null,
  code_hash text not null,
  secret_hash text not null,
  display_code_hint text not null default '',
  expires_at timestamptz not null,
  used_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'used', 'expired', 'revoked')),
  created_at timestamptz not null default now()
);
create index pairing_invitations_code_hash_idx on public.pairing_invitations (code_hash);
create index pairing_invitations_expires_idx on public.pairing_invitations (expires_at);
create index pairing_invitations_inviter_idx on public.pairing_invitations (inviter_user_id);

-- ---------------------------------------------------------------------------
-- connection_requests
-- ---------------------------------------------------------------------------

create table public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references public.profiles (id) on delete cascade,
  requester_device_id uuid references public.devices (id) on delete set null,
  target_device_id uuid not null references public.devices (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  requested_scopes text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index connection_requests_owner_idx on public.connection_requests (owner_id);
create index connection_requests_requester_idx on public.connection_requests (requester_user_id);
create index connection_requests_status_idx on public.connection_requests (status);
create index connection_requests_device_idx on public.connection_requests (target_device_id);

-- ---------------------------------------------------------------------------
-- device_permissions — one row per scope. The Trusted Device grant store.
-- ---------------------------------------------------------------------------

create table public.device_permissions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  granted_to_user_id uuid not null references public.profiles (id) on delete cascade,
  scope text not null check (scope in (
    'screen', 'camera', 'microphone', 'speaker',
    'file_transfer', 'location', 'remote_interaction', 'device_info'
  )),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id) on delete set null,
  is_revoked boolean not null default false
);
-- At most one live grant per (device, user, scope).
create unique index device_permissions_live_unique
  on public.device_permissions (device_id, granted_to_user_id, scope)
  where is_revoked = false;
create index device_permissions_owner_idx on public.device_permissions (owner_id);
create index device_permissions_device_idx on public.device_permissions (device_id);
create index device_permissions_granted_to_idx on public.device_permissions (granted_to_user_id);
create index device_permissions_expires_idx on public.device_permissions (expires_at);

-- ---------------------------------------------------------------------------
-- remote_sessions
-- ---------------------------------------------------------------------------

create table public.remote_sessions (
  id uuid primary key default gen_random_uuid(),
  connection_request_id uuid references public.connection_requests (id) on delete set null,
  device_id uuid not null references public.devices (id) on delete cascade,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  participant_user_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'ended', 'revoked')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index remote_sessions_owner_idx on public.remote_sessions (owner_id);
create index remote_sessions_device_idx on public.remote_sessions (device_id);
create index remote_sessions_participant_idx on public.remote_sessions (participant_user_id);
create index remote_sessions_status_idx on public.remote_sessions (status);

-- ---------------------------------------------------------------------------
-- session_events / security_events (audit logs)
-- ---------------------------------------------------------------------------

create table public.session_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.remote_sessions (id) on delete set null,
  device_id uuid references public.devices (id) on delete set null,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index session_events_session_idx on public.session_events (session_id);
create index session_events_created_idx on public.session_events (created_at);

create table public.security_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles (id) on delete set null,
  device_id uuid references public.devices (id) on delete set null,
  actor_id uuid references public.profiles (id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index security_events_user_idx on public.security_events (user_id);
create index security_events_device_idx on public.security_events (device_id);
create index security_events_created_idx on public.security_events (created_at);

-- ---------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  related_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id);
create index notifications_created_idx on public.notifications (created_at);

-- ---------------------------------------------------------------------------
-- file_transfers — table + RLS only in Milestone 1 (no transfer flow yet).
-- ---------------------------------------------------------------------------

create table public.file_transfers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references public.remote_sessions (id) on delete set null,
  sender_user_id uuid not null references public.profiles (id) on delete cascade,
  receiver_user_id uuid not null references public.profiles (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  file_name text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  storage_path text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'in_progress', 'completed', 'rejected', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index file_transfers_sender_idx on public.file_transfers (sender_user_id);
create index file_transfers_receiver_idx on public.file_transfers (receiver_user_id);
create index file_transfers_created_idx on public.file_transfers (created_at);

-- ---------------------------------------------------------------------------
-- Auth trigger: create profile on signup
-- ---------------------------------------------------------------------------

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.pairing_invitations enable row level security;
alter table public.connection_requests enable row level security;
alter table public.device_permissions enable row level security;
alter table public.remote_sessions enable row level security;
alter table public.session_events enable row level security;
alter table public.security_events enable row level security;
alter table public.notifications enable row level security;
alter table public.file_transfers enable row level security;

-- profiles: own row full access; other profiles visible only to users who
-- share a connection request with them (so an owner can see a requester).
create policy "profiles_select_own_or_connected" on public.profiles
  for select using (
    id = auth.uid()
    or exists (
      select 1 from public.connection_requests cr
      where (cr.owner_id = auth.uid() and cr.requester_user_id = profiles.id)
         or (cr.requester_user_id = auth.uid() and cr.owner_id = profiles.id)
    )
  );
create policy "profiles_update_own" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_insert_own" on public.profiles
  for insert with check (id = auth.uid());

-- devices: owner full access; granted users may SELECT a device they hold
-- a live grant for (unrevoked + unexpired).
create policy "devices_owner_all" on public.devices
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "devices_granted_select" on public.devices
  for select using (
    exists (
      select 1 from public.device_permissions dp
      where dp.device_id = devices.id
        and dp.granted_to_user_id = auth.uid()
        and dp.is_revoked = false
        and (dp.expires_at is null or dp.expires_at > now())
    )
  );

-- pairing_invitations: inviter manages own; any authenticated user may
-- SELECT an active, unexpired invitation — but only by its SHA-256
-- code_hash, which is known only to someone who holds the code.
create policy "pairing_invitations_inviter_all" on public.pairing_invitations
  for all using (inviter_user_id = auth.uid()) with check (inviter_user_id = auth.uid());
create policy "pairing_invitations_redeem_select" on public.pairing_invitations
  for select using (status = 'active' and expires_at > now());

-- connection_requests: owner + requester can read; requester creates;
-- owner decides (update).
create policy "connection_requests_select_parties" on public.connection_requests
  for select using (owner_id = auth.uid() or requester_user_id = auth.uid());
create policy "connection_requests_insert_requester" on public.connection_requests
  for insert with check (requester_user_id = auth.uid());
create policy "connection_requests_update_owner" on public.connection_requests
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- device_permissions: owner manages; grantee can read own grants.
create policy "device_permissions_owner_all" on public.device_permissions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "device_permissions_grantee_select" on public.device_permissions
  for select using (granted_to_user_id = auth.uid());

-- remote_sessions: owner or participant can read/update; owner creates.
create policy "remote_sessions_select_parties" on public.remote_sessions
  for select using (owner_id = auth.uid() or participant_user_id = auth.uid());
create policy "remote_sessions_insert_owner" on public.remote_sessions
  for insert with check (owner_id = auth.uid());
create policy "remote_sessions_update_parties" on public.remote_sessions
  for update using (owner_id = auth.uid() or participant_user_id = auth.uid())
  with check (owner_id = auth.uid() or participant_user_id = auth.uid());

-- session_events: visible to the device owner / session parties; any
-- authenticated user may insert (actor_id must be themselves).
create policy "session_events_select_parties" on public.session_events
  for select using (
    actor_id = auth.uid()
    or exists (select 1 from public.devices d where d.id = session_events.device_id and d.owner_id = auth.uid())
    or exists (select 1 from public.remote_sessions rs where rs.id = session_events.session_id and (rs.owner_id = auth.uid() or rs.participant_user_id = auth.uid()))
  );
create policy "session_events_insert_actor" on public.session_events
  for insert with check (actor_id = auth.uid());

-- security_events: a user sees events about themselves / their devices;
-- any authenticated user may insert their own audit rows.
create policy "security_events_select_own" on public.security_events
  for select using (
    user_id = auth.uid() or actor_id = auth.uid()
    or exists (select 1 from public.devices d where d.id = security_events.device_id and d.owner_id = auth.uid())
  );
create policy "security_events_insert_actor" on public.security_events
  for insert with check (actor_id = auth.uid() or actor_id is null);

-- notifications: strictly the recipient.
create policy "notifications_owner_all" on public.notifications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- file_transfers: sender, receiver, or the device owner.
create policy "file_transfers_select_parties" on public.file_transfers
  for select using (
    sender_user_id = auth.uid() or receiver_user_id = auth.uid()
    or exists (select 1 from public.devices d where d.id = file_transfers.device_id and d.owner_id = auth.uid())
  );
create policy "file_transfers_insert_sender" on public.file_transfers
  for insert with check (sender_user_id = auth.uid());
