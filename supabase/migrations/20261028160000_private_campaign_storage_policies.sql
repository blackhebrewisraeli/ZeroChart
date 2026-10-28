-- The bucket itself is created explicitly in the Dashboard during activation.
-- These policies grant a dedicated Auth user create/read access only under its
-- own UID prefix. Objects are immutable: there is intentionally no UPDATE or
-- DELETE policy, and the client never sends an upsert.
create policy "campaign automation reads owned evidence"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'private-campaign-evidence'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'campaign_automation'
);

create policy "campaign automation creates owned evidence"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'private-campaign-evidence'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (select auth.jwt() -> 'app_metadata' ->> 'role') = 'campaign_automation'
);
