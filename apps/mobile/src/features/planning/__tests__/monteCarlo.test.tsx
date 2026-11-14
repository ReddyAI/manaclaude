import { act, fireEvent, screen } from '@testing-library/react-native';
import { DEFAULT_PLANNING, DEFAULT_SETTINGS, projectFire } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import {
  chanceText,
  DEFAULT_VOLATILITY,
  MONTE_CARLO_RUNS,
  runMonteCarlo,
  seededRandom,
  type MonteCarloInput,
} from '../monteCarlo';
import { PlanningScreen } from '../PlanningScreen';
import { renderScreen } from './helpers';

/** Block W: the range of outcomes on Planning. Invented numbers only. */

/** Average end balance over many one-run projections with different seeds. */
function meanEnd(input: MonteCarloInput): number {
  let sum = 0;
  const n = 4_000;
  for (let i = 0; i < n; i += 1) {
    const r = runMonteCarlo({ ...input, runs: 1, seed: i + 1 });
    sum += r.p50[input.years]!;
  }
  return sum / n;
}

const base: MonteCarloInput = {
  currentSavings: 15_000_000,
  monthlyContribution: DEFAULT_PLANNING.monthlyContribution,
  annualReturn: 0.07,
  inflation: 0.03,
  volatility: DEFAULT_VOLATILITY,
  currentAge: 34,
  retirementAge: 55,
  target: 150_000_000,
  years: 26,
};

describe('runMonteCarlo', () => {
  it('gives the same answer for the same inputs', () => {
    expect(runMonteCarlo(base)).toEqual(runMonteCarlo(base));
    expect(runMonteCarlo({ ...base, seed: 7 })).not.toEqual(runMonteCarlo(base));
  });

  it('with no volatility, every run is the straight-line projection', () => {
    const line = projectFire({
      currentSavings: base.currentSavings,
      monthlyContribution: base.monthlyContribution,
      annualReturn: base.annualReturn,
      inflation: base.inflation,
      currentAge: base.currentAge,
      retirementAge: base.retirementAge,
      annualExpenses: 6_000_000,
      withdrawalRate: 0.04,
    });
    const flat = runMonteCarlo({ ...base, volatility: 0, years: line.points.length - 1 });
    line.points.forEach((p, i) => {
      expect(Math.abs(flat.p10[i]! - p.real)).toBeLessThanOrEqual(1);
      expect(Math.abs(flat.p50[i]! - p.real)).toBeLessThanOrEqual(1);
      expect(Math.abs(flat.p90[i]! - p.real)).toBeLessThanOrEqual(1);
    });
    expect(flat.chance).toBe(line.onTrack ? 1 : 0);
    expect(Math.abs(flat.atRetirement.p50 - line.balanceAtRetirement)).toBeLessThanOrEqual(1);
  });

  it('returns whole minor units, ordered 10th <= 50th <= 90th, and a chance from 0 to 1', () => {
    const r = runMonteCarlo(base);
    expect(r.runs).toBe(MONTE_CARLO_RUNS);
    expect(r.p50).toHaveLength(base.years + 1);
    for (let y = 0; y <= base.years; y += 1) {
      for (const v of [r.p10[y]!, r.p50[y]!, r.p90[y]!]) expect(Number.isInteger(v)).toBe(true);
      expect(r.p10[y]!).toBeLessThanOrEqual(r.p50[y]!);
      expect(r.p50[y]!).toBeLessThanOrEqual(r.p90[y]!);
    }
    expect(r.p10[0]).toBe(base.currentSavings);
    expect(r.atRetirement).toEqual({ p10: r.p10[21], p50: r.p50[21], p90: r.p90[21] });
    expect(r.chance).toBeGreaterThan(0);
    expect(r.chance).toBeLessThan(1);
  });

  it('averages the yearly return setting, after inflation', () => {
    // No saving: the average end balance grows at the real return.
    const years = 10;
    const r = runMonteCarlo({ ...base, monthlyContribution: 0, years, runs: 20_000 });
    const growth = ((1 + base.annualReturn) / (1 + base.inflation)) ** years;
    // The median of a lognormal sits below its mean; the mean is what the setting says.
    expect(r.p50[years]! / base.currentSavings).toBeLessThan(growth);
    const mean = runMonteCarlo({
      ...base,
      monthlyContribution: 0,
      years,
      runs: 20_000,
      volatility: 0,
    });
    expect(mean.p50[years]! / base.currentSavings).toBeCloseTo(growth, 3);
    const m = meanEnd({ ...base, monthlyContribution: 0, years });
    expect(m / base.currentSavings / growth).toBeGreaterThan(0.97);
    expect(m / base.currentSavings / growth).toBeLessThan(1.03);
  });

  it('wider swings widen the range', () => {
    const calm = runMonteCarlo({ ...base, volatility: 0.05 }).atRetirement;
    const wild = runMonteCarlo({ ...base, volatility: 0.3 }).atRetirement;
    expect(wild.p90 - wild.p10).toBeGreaterThan(calm.p90 - calm.p10);
  });

  it('more saving raises the chance; reaching it already makes it certain', () => {
    const low = runMonteCarlo(base).chance;
    const high = runMonteCarlo({ ...base, monthlyContribution: 900_000 }).chance;
    expect(high).toBeGreaterThan(low);
    expect(runMonteCarlo({ ...base, currentSavings: base.target }).chance).toBe(1);
  });

  it('counts only years up to the retirement age', () => {
    // Retiring today: only today's balance counts, even if later years reach the target.
    const now = runMonteCarlo({ ...base, retirementAge: base.currentAge });
    expect(now.chance).toBe(0);
    expect(now.atRetirement.p50).toBe(base.currentSavings);
  });

  it('stays well inside a frame budget even in Jest (a canary; the real timing is in e2e)', () => {
    runMonteCarlo(base);
    const start = performance.now();
    runMonteCarlo({ ...base, years: 60, seed: 3 });
    // Plain Node takes about 18 ms for this; Jest's transformed code is slower.
    expect(performance.now() - start).toBeLessThan(1_000);
  });

  it('draws evenly from the seeded generator', () => {
    const next = seededRandom(1);
    let sum = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 10_000).toBeCloseTo(0.5, 1);
  });
});

describe('chanceText', () => {
  it.each([
    [0, '0%'],
    [0.004, 'less than 1%'],
    [0.624, '62%'],
    [0.996, 'more than 99%'],
    [1, '100%'],
  ])('%s -> %s', (chance, text) => {
    expect(chanceText(chance)).toBe(text);
  });
});

describe('Planning, range of outcomes', () => {
  beforeEach(async () => {
    await act(() => {
      setFinance(createSampleData({ today: '2026-11-05' }));
      updateSettings({ ...DEFAULT_SETTINGS, planning: undefined });
    });
  });

  it('shows the chance, the three percentiles and that it is an estimate', async () => {
    await renderScreen(<PlanningScreen />);
    expect(screen.getByTestId('mc-chance').props.children).toMatch(
      /^(\d+%|less than 1%|more than 99%)$/,
    );
    for (const k of ['mc-p10', 'mc-p50', 'mc-p90']) expect(screen.getByTestId(k)).toBeTruthy();
    expect(screen.getByTestId('mc-chart')).toBeTruthy();
    expect(screen.getByTestId('mc-note')).toHaveTextContent(/^An estimate, not a promise\./);
    expect(screen.getByTestId('mc-note')).toHaveTextContent(/15% swings/);
  });

  it('saves a volatility of 0 and then shows the straight-line chance', async () => {
    await renderScreen(<PlanningScreen />);
    const input = screen.getByTestId('plan-field-volatility');
    expect(input.props.value).toBe('15');
    await fireEvent.changeText(input, '0');
    await fireEvent(input, 'endEditing');
    expect((getSettings().planning as { volatility?: number } | undefined)?.volatility).toBe(0);
    const onTrack = /^On track/.test(String(screen.getByTestId('fire-status').props.children));
    expect(screen.getByTestId('mc-chance').props.children).toBe(onTrack ? '100%' : '0%');
  });
});
