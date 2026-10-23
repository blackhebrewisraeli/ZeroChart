begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- The build holds only the publishable key.
select ok(
  has_function_privilege('anon', 'public.release_contract(text[], text[])', 'execute'),
  'anon can execute release_contract()'
);
select ok(
  not has_function_privilege('authenticated', 'public.release_contract(text[], text[])', 'execute'),
  'authenticated cannot execute release_contract()'
);

set local role anon;

select is(
  public.release_contract(array['20261023120000', '29991231000000'], '{}') -> 'missing_migrations',
  '["29991231000000"]'::jsonb,
  'an applied migration is not missing; an unknown one is'
);

select is(
  public.release_contract('{}', array['execute_paper_portfolio']) -> 'functions',
  '[{"name": "execute_paper_portfolio",
     "args": ["request_id", "risk_profile", "budget", "holdings", "dry_run", "expected"],
     "defaults": 2, "anon": false, "authenticated": true}]'::jsonb,
  'reports each input argument, how many may be left out, and who may execute it'
);

select is(
  public.release_contract('{}', array['rotate_signal_webhook_token']) -> 'functions' -> 0 -> 'args',
  '[]'::jsonb,
  'a function without arguments reports none'
);

select is(
  jsonb_array_length(public.release_contract('{}', '{}') -> 'functions'),
  0,
  'it reports nothing about functions it was not asked about'
);

reset role;

select * from finish();
rollback;
