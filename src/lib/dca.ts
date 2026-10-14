import type { RiskProfile } from '@/lib/portfolioBuilder';

/** Assumed annual return by risk profile, used for long-term projections. */
export const ANNUAL_RETURN_BY_RISK: Record<RiskProfile, number> = {
  conservative: 0.05,
  moderate: 0.08,
  aggressive: 0.12,
};

export interface WealthProjection {
  years: number;
  futureValue: number;
  totalContributions: number;
  growth: number;
}

/**
 * Projects the future value of a dollar-cost-averaging plan. Compounds the
 * principal monthly and adds recurring end-of-month contributions at the same
 * monthly rate (derived from the annual return).
 */
export function projectWealth(opts: {
  principal: number;
  monthlyDeposit: number;
  annualReturn: number;
  years: number;
}): WealthProjection {
  const months = opts.years * 12;
  const monthlyRate = opts.annualReturn / 12;

  let futureValue = opts.principal * Math.pow(1 + monthlyRate, months);
  if (monthlyRate === 0) {
    futureValue += opts.monthlyDeposit * months;
  } else {
    futureValue += opts.monthlyDeposit * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  }

  const totalContributions = opts.principal + opts.monthlyDeposit * months;

  return {
    years: opts.years,
    futureValue,
    totalContributions,
    growth: futureValue - totalContributions,
  };
}
