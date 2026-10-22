begin;

create extension if not exists pgtap with schema extensions;

select plan(1);

-- Only production has public.rls_auto_enable(), so a fresh database has no row
-- to find; the check bites on any database that does have it.
select is_empty(
  $$
    select role, fn.oid::regprocedure
    from pg_proc as fn
    cross join unnest(array['anon', 'authenticated']) as role
    where fn.pronamespace = 'public'::regnamespace
      and fn.proname = 'rls_auto_enable'
      and has_function_privilege(role, fn.oid, 'execute')
  $$,
  'anon and authenticated cannot execute public.rls_auto_enable()'
);

select * from finish();
rollback;
