/** Pure helpers that turn number series into SVG paths. Tested in __tests__/paths.test.ts. */

export interface Point {
  x: number;
  y: number;
}

export interface Extent {
  min: number;
  max: number;
}

export function extent(series: readonly (readonly number[])[], includeZero = false): Extent {
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

/** Map values to points in a width x height box (y grows downward). */
export function toPoints(
  values: readonly number[],
  width: number,
  height: number,
  domain: Extent,
  /** Total slots on the x axis (lets a partial month line stop mid-chart). */
  slots = values.length,
  padTop = 0,
  padBottom = 0,
): Point[] {
  const span = domain.max - domain.min || 1;
  const usable = Math.max(1, height - padTop - padBottom);
  const step = slots > 1 ? width / (slots - 1) : 0;
  return values.map((v, i) => ({
    x: slots > 1 ? i * step : width / 2,
    y: padTop + usable - ((v - domain.min) / span) * usable,
  }));
}

/** Smooth path through points (monotone cubic, so it never overshoots). */
export function linePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  if (points.length === 1) return `M${first.x},${first.y}`;
  const n = points.length;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    dx.push(b.x - a.x);
    slope.push((b.y - a.y) / (b.x - a.x || 1));
  }
  const tangent: number[] = [slope[0] ?? 0];
  for (let i = 1; i < n - 1; i += 1) {
    const s0 = slope[i - 1] ?? 0;
    const s1 = slope[i] ?? 0;
    tangent.push(
      s0 * s1 <= 0
        ? 0
        : (3 * (dx[i - 1]! + dx[i]!)) /
            ((2 * dx[i]! + dx[i - 1]!) / s0 + (dx[i]! + 2 * dx[i - 1]!) / s1),
    );
  }
  tangent.push(slope[n - 2] ?? 0);
  let d = `M${first.x},${first.y}`;
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const h = dx[i]! / 3;
    d += ` C${a.x + h},${a.y + h * tangent[i]!} ${b.x - h},${b.y - h * tangent[i + 1]!} ${b.x},${b.y}`;
  }
  return d;
}

/** Line path closed down to the baseline, for area fills. */
export function areaPath(points: readonly Point[], baseline: number): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${linePath(points)} L${last.x},${baseline} L${first.x},${baseline} Z`;
}

/** Index of the point closest to x. */
export function nearestIndex(points: readonly Point[], x: number): number {
  let best = 0;
  let bestDist = Infinity;
  points.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** SVG arc path for a donut segment between two angles (radians, 0 = 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const sweep = Math.min(end - start, Math.PI * 2 - 0.0001);
  const x0 = cx + r * Math.sin(start);
  const y0 = cy - r * Math.cos(start);
  const x1 = cx + r * Math.sin(start + sweep);
  const y1 = cy - r * Math.cos(start + sweep);
  const large = sweep > Math.PI ? 1 : 0;
  return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}`;
}

/** Closed straight-segment shape between an upper and a lower line (a range band). */
export function bandPath(upper: readonly Point[], lower: readonly Point[]): string {
  if (upper.length === 0 || lower.length === 0) return '';
  const top = upper.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const bottom = [...lower]
    .reverse()
    .map((p) => `L${p.x},${p.y}`)
    .join(' ');
  return `${top} ${bottom} Z`;
}
