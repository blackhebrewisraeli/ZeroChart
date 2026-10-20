-- Pro entitlement. Only the service role (billing webhook, admin) writes it;
-- clients read their own row, and authStore's isPro trusts nothing else.
create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'inactive' check (status in ('active', 'inactive')),
  tier text not null default 'free' check (tier in ('pro', 'free')),
  updated_at timestamptz not null default now()
);

alter table public.user_subscriptions enable row level security;

revoke all on table public.user_subscriptions from anon, authenticated;
grant select on table public.user_subscriptions to authenticated;

drop policy if exists "Users can read their own subscription" on public.user_subscriptions;
create policy "Users can read their own subscription"
  on public.user_subscriptions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Carry over Pro granted through app_metadata, which only the service role can
-- set. user_metadata.is_pro was user-writable, so it carries nothing over.
insert into public.user_subscriptions (user_id, status, tier)
select id, 'active', 'pro'
from auth.users
where raw_app_meta_data ->> 'is_pro' = 'true'
on conflict (user_id) do nothing;
