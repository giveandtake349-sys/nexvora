-- NEXVORA — DEMO SEED DATA ONLY.
-- !!! DO NOT run this against a production database. !!!
-- These are obviously fake demo rows (demo users / demo devices) for local
-- development only, so the dashboard can be viewed before real users exist.
-- They never bypass RLS: the rows are owned by the two demo UUIDs below,
-- and a real signed-in user will not see them.
-- To use: create two auth users, replace the UUIDs with their real ids,
-- then run this file in the Supabase SQL editor.

-- Demo owner: 11111111-1111-1111-1111-111111111111
-- Demo guest: 22222222-2222-2222-2222-222222222222
-- (Replace both UUIDs with real auth.users ids before running.)

insert into public.profiles (id, display_name)
values
  ('11111111-1111-1111-1111-111111111111', 'Demo Owner'),
  ('22222222-2222-2222-2222-222222222222', 'Demo Guest')
on conflict (id) do nothing;

insert into public.devices (id, owner_id, name, device_fingerprint, platform, browser, os, is_trusted)
values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Demo Laptop', 'demo-fingerprint-laptop', 'desktop', 'Chrome', 'Windows', true),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'Demo Phone', 'demo-fingerprint-phone', 'web', 'Chrome', 'Android', false)
on conflict (id) do nothing;
