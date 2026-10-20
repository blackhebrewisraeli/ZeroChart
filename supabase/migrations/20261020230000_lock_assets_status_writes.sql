-- Production's assets_status has a hand-made policy "allow_agent_upsert"
-- (FOR ALL TO public USING (true) WITH CHECK (true)), and anon and
-- authenticated hold the default insert/update/delete/truncate grants. Anyone
-- with the public anon key can write quotes, and check_paper_transaction
-- (20261020210000) trusts those quotes: forge a fresh one next to any price
-- and that fill passes the 5% check.
--
-- The only writer is the trading-agent scanner, which upserts with the
-- service-role key and bypasses RLS. The app only reads the table. Clients keep
-- SELECT ("Allow anonymous read"), which the fill trigger also needs because it
-- runs as the inserting user.
drop policy if exists "allow_agent_upsert" on public.assets_status;

revoke insert, update, delete, truncate on table public.assets_status from anon, authenticated;
