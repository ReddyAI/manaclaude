import type { MinorUnits } from '../model/common';

/**
 * Retirement / FIRE projection. Everything is in today's money (real terms):
 * the return is the yearly return after inflation, and contributions are
 * assumed to rise with inflation. Compounds monthly. Amounts are minor units.
 */

export interface FireInput {
  /** Invested money today. */
  currentSavings: MinorUnits;
  monthlyContribution: MinorUnits;
  /** Nominal yearly return (0.07 = 7%). */
  annualReturn: number;
  /** Yearly inflation (0.03 = 3%). */
  inflation: number;
  currentAge: number;
  retirementAge: number;
  /** Yearly spending in retirement, today's money. Used with `withdrawalRate` to size the target. */
  annualExpenses: MinorUnits;
  /** Safe withdrawal rate (0.04 = 4%). */
  withdrawalRate: number;
  /** Overrides the target (today's money) instead of annualExpenses / withdrawalRate. */
  targetOverride?: MinorUnits | null;
  /** Longest projection in years. Default 60. */
  maxYears?: number;
}

export interface FirePoint {
  year: number;
  age: number;
  /** Balance in today's money. */
  real: MinorUnits;
  /** Balance in future dollars (real grown by inflation). */
  nominal: MinorUnits;
}

export interface FireResult {
  /** Savings needed in today's money. */
  target: MinorUnits;
  realReturn: number;
  points: FirePoint[];
  /** Years from now until the balance first reaches the target; null if it never does within maxYears. */
  yearsToTarget: number | null;
  /** currentAge + yearsToTarget. */
  fireAge: number | null;
  balanceAtRetirement: MinorUnits;
  /** What the balance at retirement supports per year, today's money. */
  sustainableIncome: MinorUnits;
  /** True when the target is reached by the retirement age. */
  onTrack: boolean;
  /** Monthly saving that reaches the target exactly at retirement age. */
  requiredMonthlyContribution: MinorUnits;
}

export function realReturn(annualReturn: number, inflation: number): number {
  return (1 + annualReturn) / (1 + inflation) - 1;
}

export function fireTarget(
  annualExpenses: MinorUnits,
  withdrawalRate: number,
  override?: MinorUnits | null,
): MinorUnits {
  if (override !== undefined && override !== null) return override;
  if (withdrawalRate <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.round(annualExpenses / withdrawalRate);
}

/** Balance after `months` months of saving `monthly` at a monthly rate. */
function futureValue(start: number, monthly: number, monthlyRate: number, months: number): number {
  if (monthlyRate === 0) return start + monthly * months;
  const growth = (1 + monthlyRate) ** months;
  return start * growth + (monthly * (growth - 1)) / monthlyRate;
}

export function projectFire(input: FireInput): FireResult {
  const rr = realReturn(input.annualReturn, input.inflation);
  const monthlyRate = (1 + rr) ** (1 / 12) - 1;
  const target = fireTarget(input.annualExpenses, input.withdrawalRate, input.targetOverride);
  const yearsToRetire = Math.max(0, input.retirementAge - input.currentAge);
  const maxYears = input.maxYears ?? 60;

  let yearsToTarget: number | null = null;
  if (input.currentSavings >= target) yearsToTarget = 0;
  else {
    for (let m = 1; m <= maxYears * 12; m += 1) {
      if (futureValue(input.currentSavings, input.monthlyContribution, monthlyRate, m) >= target) {
        yearsToTarget = m / 12;
        break;
      }
    }
  }

  const horizon = Math.min(
    maxYears,
    Math.max(yearsToRetire, yearsToTarget === null ? 0 : Math.ceil(yearsToTarget)) + 5,
  );
  const points: FirePoint[] = [];
  for (let y = 0; y <= horizon; y += 1) {
    const real = futureValue(input.currentSavings, input.monthlyContribution, monthlyRate, y * 12);
    points.push({
      year: y,
      age: input.currentAge + y,
      real: Math.round(real),
      nominal: Math.round(real * (1 + input.inflation) ** y),
    });
  }

  const balanceAtRetirement = Math.round(
    futureValue(input.currentSavings, input.monthlyContribution, monthlyRate, yearsToRetire * 12),
  );

  // Contribution that lands exactly on the target at retirement age.
  const months = yearsToRetire * 12;
  let required = 0;
  if (months > 0) {
    const growth = (1 + monthlyRate) ** months;
    const gap = target - input.currentSavings * growth;
    required = gap <= 0 ? 0 : monthlyRate === 0 ? gap / months : (gap * monthlyRate) / (growth - 1);
  } else {
    required = Math.max(0, target - input.currentSavings);
  }

  return {
    target,
    realReturn: rr,
    points,
    yearsToTarget,
    fireAge: yearsToTarget === null ? null : input.currentAge + yearsToTarget,
    balanceAtRetirement,
    sustainableIncome: Math.round(balanceAtRetirement * input.withdrawalRate),
    onTrack: yearsToTarget !== null && yearsToTarget <= yearsToRetire + 1e-9,
    requiredMonthlyContribution: Math.ceil(required),
  };
}
