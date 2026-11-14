/**
 * Monte Carlo retirement projection, run on the device.
 *
 * Each run draws one market return per year from a lognormal distribution
 * whose average is the yearly return setting and whose spread is the
 * volatility setting, takes inflation out, and within each year compounds
 * monthly with the same monthly saving the straight-line projection uses
 * (packages/shared/src/planning/fire.ts). With volatility 0 every run equals
 * that projection.
 *
 * A seeded generator makes it repeatable: the same inputs always give the
 * same answer. Money stays in integer minor units at the edges: inputs are
 * minor units, and every balance returned is rounded to a whole minor unit.
 */

/** Runs per projection. 2,000 runs x 60 years takes a few milliseconds on a laptop. */
export const MONTE_CARLO_RUNS = 2_000;
/** Fixed seed: the same inputs give the same percentiles and chance every time. */
export const MONTE_CARLO_SEED = 20_261_114;
/** Default yearly volatility (standard deviation of returns): a stock-heavy mix. */
export const DEFAULT_VOLATILITY = 0.15;

export interface MonteCarloInput {
  /** Invested money today, minor units. */
  currentSavings: number;
  /** Saved each month, minor units, rising with inflation. */
  monthlyContribution: number;
  /** Average nominal yearly return (0.07 = 7%). */
  annualReturn: number;
  /** Yearly inflation (0.03 = 3%). */
  inflation: number;
  /** Yearly standard deviation of returns (0.15 = 15%). */
  volatility: number;
  currentAge: number;
  retirementAge: number;
  /** Target in today's money, minor units. */
  target: number;
  /** Years to project; the chart's length. */
  years: number;
  runs?: number;
  seed?: number;
}

export interface Percentiles {
  p10: number;
  p50: number;
  p90: number;
}

export interface MonteCarloResult {
  runs: number;
  /** One entry per year from now (index 0 is today), today's money, minor units. */
  p10: number[];
  p50: number[];
  p90: number[];
  /** Balance at the retirement age, today's money. */
  atRetirement: Percentiles;
  /** Share of runs (0 to 1) that reach the target at or before the retirement age. */
  chance: number;
}

/** mulberry32: small, fast, good enough for a projection, and seedable. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Standard normal draws (Box-Muller), two per pair of uniforms. */
function normals(random: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = random();
    const v = random();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Nearest-rank percentile of a sorted array. */
function pick(sorted: Float64Array, q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return Math.round(sorted[i] ?? 0);
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const runs = Math.max(1, Math.floor(input.runs ?? MONTE_CARLO_RUNS));
  const years = Math.max(0, Math.floor(input.years));
  const retireYear = Math.min(years, Math.max(0, input.retirementAge - input.currentAge));
  const sigma = Math.max(0, input.volatility);
  const mu = Math.log(1 + input.annualReturn) - (sigma * sigma) / 2;
  const deflate = 1 + input.inflation;
  const draw = normals(seededRandom(input.seed ?? MONTE_CARLO_SEED));

  // balances[y * runs + r]: run r's balance at the end of year y.
  const balances = new Float64Array((years + 1) * runs);
  let reached = 0;
  for (let r = 0; r < runs; r += 1) {
    let balance = input.currentSavings;
    balances[r] = balance;
    let hit = balance >= input.target;
    for (let y = 1; y <= years; y += 1) {
      const growth = Math.exp(mu + sigma * draw()) / deflate;
      const monthly = growth ** (1 / 12) - 1;
      const saved =
        Math.abs(monthly) < 1e-12
          ? input.monthlyContribution * 12
          : (input.monthlyContribution * (growth - 1)) / monthly;
      balance = balance * growth + saved;
      balances[y * runs + r] = balance;
      if (y <= retireYear && balance >= input.target) hit = true;
    }
    if (hit) reached += 1;
  }

  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  let atRetirement: Percentiles = { p10: 0, p50: 0, p90: 0 };
  for (let y = 0; y <= years; y += 1) {
    const year = balances.slice(y * runs, (y + 1) * runs).sort();
    const row = { p10: pick(year, 0.1), p50: pick(year, 0.5), p90: pick(year, 0.9) };
    p10.push(row.p10);
    p50.push(row.p50);
    p90.push(row.p90);
    if (y === retireYear) atRetirement = row;
  }
  return { runs, p10, p50, p90, atRetirement, chance: reached / runs };
}

/** "62%", with "less than 1%" and "more than 99%" at the ends so 0 and 100 mean exactly that. */
export function chanceText(chance: number): string {
  if (chance <= 0) return '0%';
  if (chance >= 1) return '100%';
  if (chance < 0.01) return 'less than 1%';
  if (chance > 0.99) return 'more than 99%';
  return `${Math.round(chance * 100)}%`;
}
