import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractGaps, DB_CONTRACT, type CatalogFunction } from '@/lib/dbContract';

const portfolioArgs = ['request_id', 'risk_profile', 'budget', 'holdings', 'dry_run', 'expected'];

// Production's functions on 2026-10-23, after 20261023090000.
const portfolio: CatalogFunction = {
  name: 'execute_paper_portfolio',
  args: portfolioArgs,
  defaults: 2,
  anon: false,
  authenticated: true,
};
const tactical: CatalogFunction = {
  name: 'execute_tactical_signal',
  args: ['signal_id', 'user_id', 'execution_price'],
  defaults: 0,
  anon: false,
  authenticated: true,
};
const shared: CatalogFunction = {
  name: 'get_shared_portfolio',
  args: ['share_id'],
  defaults: 0,
  anon: true,
  authenticated: true,
};
const rotate: CatalogFunction = {
  name: 'rotate_signal_webhook_token',
  args: [],
  defaults: 0,
  anon: false,
  authenticated: true,
};
const production = [portfolio, tactical, shared, rotate];
const others = [tactical, shared, rotate];

// The function as 20261022130000 left it: no `expected`.
const fiveArgPortfolio: CatalogFunction = {
  ...portfolio,
  args: portfolioArgs.slice(0, 5),
  defaults: 1,
};

const gapsWith = (functions: CatalogFunction[], missing_migrations: string[] = []) =>
  contractGaps({ missing_migrations, functions });

describe('contractGaps', () => {
  it('passes the production database the current frontend runs against', () => {
    expect(gapsWith(production)).toEqual([]);
  });

  it('blocks a release whose migrations are not all applied', () => {
    expect(gapsWith(production, ['20261023120000'])).toEqual([
      'migration 20261023120000 is not applied',
    ]);
  });

  it('blocks the 2026-10-23 release: Confirm sends `expected`, the database has five arguments', () => {
    expect(gapsWith([fiveArgPortfolio, ...others])).toEqual([
      'execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run, expected): no function accepts these arguments (PGRST202)',
    ]);
  });

  it('blocks overloads that make a call ambiguous', () => {
    expect(gapsWith([fiveArgPortfolio, ...production])).toEqual([
      "execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run): 2 overloads accept it, so PostgREST can't choose one (PGRST203)",
    ]);
  });

  it('blocks making an argument required that previews leave out', () => {
    const required = { ...portfolio, defaults: 0 };
    expect(gapsWith([required, ...others])).toEqual([
      'execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run): no function accepts these arguments (PGRST202)',
    ]);
  });

  it('blocks a function missing altogether', () => {
    expect(gapsWith(others)[0]).toMatch(/^execute_paper_portfolio\(.*PGRST202/);
  });

  it('blocks grants that differ from the roles the frontend uses', () => {
    const opened = { ...portfolio, anon: true };
    const closed = { ...shared, anon: false };
    expect(gapsWith([opened, tactical, closed, rotate])).toEqual([
      'execute_paper_portfolio(request_id, risk_profile, budget, holdings, dry_run, expected): anon can execute it; the frontend needs authenticated only',
      'get_shared_portfolio(share_id): anon cannot execute it; the frontend needs anon and authenticated only',
    ]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('DB_CONTRACT', () => {
  it('lists exactly the RPCs the frontend calls', () => {
    const called = new Set(
      sources(join(process.cwd(), 'src')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(/\.rpc\(\s*'(\w+)'/g)].map((match) => match[1]),
      ),
    );
    expect([...called].sort()).toEqual(Object.keys(DB_CONTRACT).sort());
  });
});
