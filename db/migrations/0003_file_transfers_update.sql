-- NEXVORA Milestone 4 — file_transfers status updates.
--
-- Why this migration exists: 0001_init.sql created `file_transfers`
-- with SELECT + INSERT RLS policies only — enough for Milestone 1,
-- where no transfer flow existed. Milestone 4 records each transfer's
-- lifecycle (pending -> approved -> in_progress -> completed, or
-- rejected / failed) in that same table, so the sender and receiver
-- need UPDATE. No new table, no new column, no file bytes anywhere:
-- files are transferred peer-to-peer over WebRTC; the server stores
-- metadata only (file name, size, sender, receiver, status).
--
-- 0001 and 0002 are already applied live and are NEVER edited.
-- Apply this file once, after 0002, with the Neon SQL Editor (or
-- psql against DATABASE_URL_UNPOOLED). This migration has NOT been
-- run against a live database yet (no Neon access from the build VM).

-- Lookup: transfers of one session, in creation order.
create index if not exists file_transfers_session_idx
  on public.file_transfers (session_id, created_at);

-- UPDATE policy: the sender, the receiver, or the device owner may
-- update a transfer row (status + completed_at). The API route — not
-- RLS — enforces WHICH transitions each party may perform
-- (receiver approves/rejects, sender starts/completes, either side
-- may fail) and validates the new status against the table CHECK.
-- No DELETE policy is added: transfer rows are audit history and are
-- removed only by session/device deletion (ON DELETE SET NULL).
create policy "file_transfers_update_parties" on public.file_transfers
  for update using (
    sender_user_id = public.current_app_user_id()
    or receiver_user_id = public.current_app_user_id()
    or exists (
      select 1 from public.devices d
      where d.id = file_transfers.device_id
        and d.owner_id = public.current_app_user_id()
    )
  )
  with check (
    sender_user_id = public.current_app_user_id()
    or receiver_user_id = public.current_app_user_id()
    or exists (
      select 1 from public.devices d
      where d.id = file_transfers.device_id
        and d.owner_id = public.current_app_user_id()
    )
  );
