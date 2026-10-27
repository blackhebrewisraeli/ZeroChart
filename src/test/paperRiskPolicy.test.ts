import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEE_RATE } from '@/components/TradeTicket';
import { MAX_SERVER_ATR_AGE_MS } from '@/hooks/usePaperRisk';
import { REGIME_HIGH_VOLATILITY } from '@/lib/canonicalModel';
import { ASSET_COUNT_BY_RISK, type RiskProfile } from '@/lib/portfolioBuilder';
import {
  DEFAULT_ATR_STOP_MULTIPLIER,
  DEFAULT_RISK_PERCENT,
  MAX_PORTFOLIO_RISK_PERCENT,
} from '@/lib/risk';
import { RISK_PROFILE_POLICIES } from '@/lib/roboAdvisor';

// The server enforces what the browser previews: paper_risk_policy() must
// carry the same numbers as the TypeScript engine.
const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261022130000_paper_portfolio_execution.sql'),
  'utf8',
);
const policy = sql.slice(sql.indexOf('function public.paper_risk_policy('));

/** The number on the policy line commented with `name`. */
const constant = (name: string) =>
  Number(new RegExp(`^\\s*([\\d.]+),\\s*-- ${name}\\b`, 'm').exec(policy)?.[1]);

/** The per-profile CASE whose `then` values come right after `marker`. */
function perProfile(marker: string): Record<RiskProfile, number> {
  const line = policy
    .split('\n')
    .find((text) => text.includes('case risk_profile') && text.includes(marker));
  const values = [...(line ?? '').matchAll(/when '(\w+)' then ([\d.]+)/g)];
  return Object.fromEntries(values.map(([, profile, value]) => [profile, Number(value)])) as Record<
    RiskProfile,
    number
  >;
}

describe('paper_risk_policy matches the TypeScript engine', () => {
  it('shares the fee, stop, risk and volatility constants', () => {
    expect(constant('FEE_RATE')).toBe(FEE_RATE);
    expect(constant('DEFAULT_ATR_STOP_MULTIPLIER')).toBe(DEFAULT_ATR_STOP_MULTIPLIER);
    expect(constant('DEFAULT_RISK_PERCENT')).toBe(DEFAULT_RISK_PERCENT);
    expect(constant('MAX_PORTFOLIO_RISK_PERCENT')).toBe(MAX_PORTFOLIO_RISK_PERCENT);
    expect(constant('REGIME_HIGH_VOLATILITY')).toBe(REGIME_HIGH_VOLATILITY);
    expect(policy).toContain(`interval '${MAX_SERVER_ATR_AGE_MS / 3_600_000} hours', -- two daily`);
  });

  it('shares every profile limit', () => {
    const profiles = Object.keys(RISK_PROFILE_POLICIES) as RiskProfile[];
    const pick = (field: 'maxAllocation' | 'minimumScore') =>
      Object.fromEntries(
        profiles.map((profile) => [profile, RISK_PROFILE_POLICIES[profile][field]]),
      );
    expect(perProfile('then 0.10')).toEqual(pick('maxAllocation'));
    expect(perProfile('then 8')).toEqual(ASSET_COUNT_BY_RISK);
    expect(perProfile('then 60')).toEqual(pick('minimumScore'));
  });
});
