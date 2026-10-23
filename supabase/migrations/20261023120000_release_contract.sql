-- Release gate: what a production frontend build checks before it goes live.
--
-- On 2026-10-23 a merge to main deployed a frontend whose Confirm called a
-- six-argument execute_paper_portfolio the database didn't have yet: Confirm
-- failed with PGRST202 for about four minutes, until the migration was pushed.
-- scripts/check-db-contract.ts now runs before every Vercel production build.
-- It sends this function the migration versions in its checkout and the RPCs
-- the frontend calls (src/lib/dbContract.ts), and the build fails, leaving the
-- current deployment live, unless every migration is applied and every RPC
-- still accepts the frontend's arguments for the roles that call it.
--
-- Read-only, and it answers only about the versions and names it is given:
-- migration versions are public in the repo, and it describes only functions
-- anon or authenticated may execute, which any client can already probe
-- through /rest/v1/rpc. Service-role-only and hand-made private functions read
-- as absent. SECURITY DEFINER only to read supabase_migrations, which anon
-- can't; anon may call it because the build holds the publishable key, never
-- the service role.
create function public.release_contract(migrations text[], functions text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'missing_migrations', coalesce((
      select jsonb_agg(m.version order by m.version)
      from unnest(migrations) as m(version)
      where not exists (
        select 1 from supabase_migrations.schema_migrations s where s.version = m.version
      )
    ), '[]'),
    -- Per overload, the input arguments PostgREST matches a call's names
    -- against; the last `defaults` of them may be left out.
    'functions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', p.proname,
        'args', to_jsonb(array(
          select a.name
          from unnest(p.proargnames, p.proargmodes) with ordinality as a(name, mode, n)
          where coalesce(a.mode, 'i') in ('i', 'b', 'v')
          order by a.n
        )),
        'defaults', p.pronargdefaults,
        'anon', has_function_privilege('anon', p.oid, 'execute'),
        'authenticated', has_function_privilege('authenticated', p.oid, 'execute')
      ) order by p.proname, p.oid)
      from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = any(functions)
        and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'))
    ), '[]')
  )
$$;

revoke all on function public.release_contract(text[], text[]) from public, authenticated;
grant execute on function public.release_contract(text[], text[]) to anon;
