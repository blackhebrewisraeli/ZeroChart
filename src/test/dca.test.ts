import { describe, expect, it } from 'vitest';
import { ANNUAL_RETURN_BY_RISK, projectWealth } from '@/lib/dca';

describe('projectWealth', () => {
  it('compounds principal without monthly deposits', () => {
    const result = projectWealth({
      principal: 10000,
      monthlyDeposit: 0,
      annualReturn: 0.1,
      years: 1,
    });
    expect(result.futureValue).toBeCloseTo(11047.13, 1);
    expect(result.totalContributions).toBe(10000);
    expect(result.growth).toBeCloseTo(result.futureValue - 10000, 5);
  });

  it('accumulates monthly contributions at zero return', () => {
    const result = projectWealth({
      principal: 0,
      monthlyDeposit: 100,
      annualReturn: 0,
      years: 1,
    });
    expect(result.futureValue).toBeCloseTo(1200, 5);
    expect(result.totalContributions).toBe(1200);
    expect(result.growth).toBe(0);
  });

  it('projects growth over multiple years', () => {
    const result = projectWealth({
      principal: 0,
      monthlyDeposit: 250,
      annualReturn: 0.08,
      years: 10,
    });
    // $250/mo for 10 years at 8% APY yields a future value greater than the
    // $30,000 of contributions alone.
    expect(result.totalContributions).toBe(30000);
    expect(result.futureValue).toBeGreaterThan(30000);
    expect(result.growth).toBeGreaterThan(0);
  });

  it('maps risk profiles to assumed annual returns', () => {
    expect(ANNUAL_RETURN_BY_RISK.conservative).toBe(0.05);
    expect(ANNUAL_RETURN_BY_RISK.moderate).toBe(0.08);
    expect(ANNUAL_RETURN_BY_RISK.aggressive).toBe(0.12);
  });
});
