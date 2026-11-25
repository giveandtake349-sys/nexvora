-- NEXVORA Milestone 1 — Supabase Storage bucket for future file transfers.
-- Bucket + policies only. No file-transfer flow is built in Milestone 1
-- (that is Milestone 4). Files are private by default; access is granted
-- only to the sender, the receiver, or the device owner.

insert into storage.buckets (id, name, public)
values ('file-transfers', 'file-transfers', false)
on conflict (id) do nothing;

-- Upload: the sender, inside an active session they take part in.
create policy "file_transfers_upload_sender"
  on storage.objects for insert
  with check (
    bucket_id = 'file-transfers'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- Download: the uploader, or the receiver named in the matching
-- file_transfers row. Path layout: <sender_id>/<transfer_id>/<filename>
create policy "file_transfers_download_parties"
  on storage.objects for select
  using (
    bucket_id = 'file-transfers'
    and (
      auth.uid()::text = (storage.foldername(name))[1]
      or exists (
        select 1 from public.file_transfers ft
        where ft.receiver_user_id = auth.uid()
          and ft.storage_path = name
      )
    )
  );

-- Delete: the uploader only.
create policy "file_transfers_delete_uploader"
  on storage.objects for delete
  using (
    bucket_id = 'file-transfers'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
