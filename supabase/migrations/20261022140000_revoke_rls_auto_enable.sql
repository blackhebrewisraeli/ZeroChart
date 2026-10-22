-- public.rls_auto_enable() exists only in production: no migration creates it
-- and nothing in the app calls it. It is a SECURITY DEFINER function, and
-- Supabase granted EXECUTE on it to anon and authenticated, so anyone with the
-- public key could call it through /rest/v1/rpc/rls_auto_enable (advisors
-- anon_ and authenticated_security_definer_function_executable). Revoke by name
-- so any signature is covered, and fail rather than leave it callable: a REVOKE
-- by a role that does not own the function only warns.
do $$
declare
  fn regprocedure;
begin
  for fn in
    select oid::regprocedure
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname = 'rls_auto_enable'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', fn);
    if has_function_privilege('anon', fn, 'execute')
      or has_function_privilege('authenticated', fn, 'execute') then
      raise exception '% is still executable by anon or authenticated', fn;
    end if;
  end loop;
end $$;
