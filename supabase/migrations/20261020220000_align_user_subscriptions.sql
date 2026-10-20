-- Production's user_subscriptions was made by hand before 20261020200100, and
-- that migration's create table if not exists left it as it was: defaults of
-- status 'active' and tier 'pro' (so a service-role insert setting only
-- user_id granted Pro), no check constraints, and a second select policy.
-- Bring it in line with 20261020200100. Existing rows are left as they are.
alter table public.user_subscriptions
  alter column status set default 'inactive',
  alter column tier set default 'free';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_status_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_status_check check (status in ('active', 'inactive'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.user_subscriptions'::regclass
      and conname = 'user_subscriptions_tier_check'
  ) then
    alter table public.user_subscriptions
      add constraint user_subscriptions_tier_check check (tier in ('pro', 'free'));
  end if;
end;
$$;

-- Hand-made duplicate of "Users can read their own subscription" (20261020200100).
drop policy if exists "Users can view own subscription" on public.user_subscriptions;
