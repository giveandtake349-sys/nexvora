-- NEXVORA — DEMO SEED DATA ONLY.
-- !!! DO NOT run this against a production database. !!!
-- These are obviously fake demo rows (demo users / demo devices) for local
-- development only, so the dashboard can be viewed before real users exist.
-- They never bypass RLS: the rows are owned by the two demo user ids below,
-- and a real signed-in user will not see them.
-- To use: create two users in Neon Auth, replace the ids with their real
-- Better Auth user ids (opaque text strings), then run this file in the
-- Neon SQL editor or with psql against DATABASE_URL_UNPOOLED.

-- Demo owner: demo-owner-user-id
-- Demo guest: demo-guest-user-id
-- (Replace both ids with real Neon Auth user ids before running.)

insert into public.profiles (id, email, display_name)
values
  ('demo-owner-user-id', 'owner@example.com', 'Demo Owner'),
  ('demo-guest-user-id', 'guest@example.com', 'Demo Guest')
on conflict (id) do nothing;

insert into public.devices (id, owner_id, name, device_fingerprint, platform, browser, os, is_trusted)
values
  ('33333333-3333-3333-3333-333333333333', 'demo-owner-user-id', 'Demo Laptop', 'demo-fingerprint-laptop', 'desktop', 'Chrome', 'Windows', true),
  ('44444444-4444-4444-4444-444444444444', 'demo-guest-user-id', 'Demo Phone', 'demo-fingerprint-phone', 'web', 'Chrome', 'Android', false)
on conflict (id) do nothing;
