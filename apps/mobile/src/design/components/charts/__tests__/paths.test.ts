import { arcPath, extent, linePath, nearestIndex, toPoints } from '../paths';

describe('chart paths', () => {
  it('computes an extent and pads flat series', () => {
    expect(extent([[1, 5, 3]])).toEqual({ min: 1, max: 5 });
    expect(extent([[2, 2]])).toEqual({ min: 1.8, max: 2.2 });
    expect(extent([[]])).toEqual({ min: 0, max: 1 });
  });

  it('maps values into the box with y growing downward', () => {
    const pts = toPoints([0, 10], 100, 50, { min: 0, max: 10 });
    expect(pts).toEqual([
      { x: 0, y: 50 },
      { x: 100, y: 0 },
    ]);
  });

  it('stops a partial series part-way across when slots are larger', () => {
    const pts = toPoints([0, 1, 2], 100, 10, { min: 0, max: 2 }, 5);
    expect(pts[2]?.x).toBe(50);
  });

  it('draws a path through every point and picks the nearest point', () => {
    const pts = toPoints([1, 3, 2, 4], 300, 100, extent([[1, 3, 2, 4]]));
    const d = linePath(pts);
    expect(d.startsWith('M0,')).toBe(true);
    expect(d.match(/C/g)).toHaveLength(3);
    expect(nearestIndex(pts, 140)).toBe(1);
    expect(nearestIndex(pts, 290)).toBe(3);
  });

  it('draws donut arcs', () => {
    expect(arcPath(50, 50, 40, 0, Math.PI)).toMatch(/^M50,10 A40,40 0 0 1 /);
    expect(arcPath(50, 50, 40, 0, Math.PI * 1.5)).toContain(' 0 1 1 ');
  });
});
