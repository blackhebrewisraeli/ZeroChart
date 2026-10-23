// What this frontend needs from the database before it may go live: every
// migration in its checkout, plus the RPCs below. scripts/check-db-contract.ts
// asks production's release_contract() and fails the Vercel production build
// on any gap (docs/RELEASE.md). Plain TypeScript with no runtime imports, so
// that script runs it under Node's type stripping.
import type { Database } from '@/integrations/supabase/types';

type Functions = Database['public']['Functions'];
type Role = 'anon' | 'authenticated';

/** Whether the frontend sends an argument on every call or leaves it out of some. */
type Usage = 'always' | 'sometimes';

interface Requirement<Name extends keyof Functions> {
  /** Every argument the typed client can send, so a renamed one fails typecheck here. */
  args: Record<keyof Functions[Name]['Args'] & string, Usage>;
  /** Exactly the roles that may execute it. */
  roles: readonly Role[];
}

type FrontendRpc =
  | 'execute_paper_portfolio'
  | 'execute_tactical_signal'
  | 'get_shared_portfolio'
  | 'rotate_signal_webhook_token';

export const DB_CONTRACT: { [Name in FrontendRpc]: Requirement<Name> } = {
  execute_paper_portfolio: {
    args: {
      request_id: 'always',
      risk_profile: 'always',
      budget: 'always',
      holdings: 'always',
      dry_run: 'always',
      // Previews and recoveries leave it out; Confirm sends it.
      expected: 'sometimes',
    },
    roles: ['authenticated'],
  },
  execute_tactical_signal: {
    args: { signal_id: 'always', user_id: 'always', execution_price: 'always' },
    roles: ['authenticated'],
  },
  get_shared_portfolio: { args: { share_id: 'always' }, roles: ['anon', 'authenticated'] },
  rotate_signal_webhook_token: { args: {}, roles: ['authenticated'] },
};

/** One public function overload as release_contract() reports it. */
export interface CatalogFunction {
  name: string;
  /** Input argument names in order; the last `defaults` of them are optional. */
  args: string[];
  defaults: number;
  anon: boolean;
  authenticated: boolean;
}

export interface ReleaseCatalog {
  missing_migrations: string[];
  functions: CatalogFunction[];
}

/** PostgREST's overload match: every named argument exists, and none it requires is missing. */
function accepts(fn: CatalogFunction, sent: readonly string[]): boolean {
  const required = fn.args.slice(0, fn.args.length - fn.defaults);
  return sent.every((arg) => fn.args.includes(arg)) && required.every((arg) => sent.includes(arg));
}

/** Whether one call shape resolves to exactly one overload, and (if `roles`) who may run it. */
function callGaps(
  name: string,
  overloads: readonly CatalogFunction[],
  sent: readonly string[],
  roles: readonly Role[] | null,
): string[] {
  const call = `${name}(${sent.join(', ')})`;
  const matches = overloads.filter((fn) => accepts(fn, sent));
  const [fn] = matches;
  if (!fn) {
    return [
      `${call}: no function accepts these arguments (PGRST202), or none that anon or authenticated may execute`,
    ];
  }
  if (matches.length > 1) {
    return [
      `${call}: ${matches.length} overloads accept it, so PostgREST can't choose one (PGRST203)`,
    ];
  }
  if (!roles) return [];
  return (['anon', 'authenticated'] as const)
    .filter((role) => fn[role] !== roles.includes(role))
    .map(
      (role) =>
        `${call}: ${role} ${fn[role] ? 'can' : 'cannot'} execute it; the frontend needs ${roles.join(' and ')} only`,
    );
}

/** Why the database can't serve this frontend; empty when it can. */
export function contractGaps(
  catalog: ReleaseCatalog,
  contract: Record<string, { args: Record<string, Usage>; roles: readonly Role[] }> = DB_CONTRACT,
): string[] {
  const gaps = catalog.missing_migrations.map((version) => `migration ${version} is not applied`);
  for (const [name, rpc] of Object.entries(contract)) {
    const overloads = catalog.functions.filter((fn) => fn.name === name);
    const every = Object.keys(rpc.args);
    const always = every.filter((arg) => rpc.args[arg] === 'always');
    // Each call shape the frontend sends must resolve to exactly one overload;
    // grants are checked once, on the full call.
    gaps.push(...callGaps(name, overloads, every, rpc.roles));
    if (always.length < every.length) gaps.push(...callGaps(name, overloads, always, null));
  }
  return gaps;
}
