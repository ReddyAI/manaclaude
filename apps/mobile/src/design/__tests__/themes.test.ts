import { themes } from '../themes';
import { LOOK_TOKENS } from '../tokens';

function shape(value: unknown): unknown {
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shape(v)]),
    );
  }
  return typeof value;
}

describe('themes', () => {
  const names = Object.keys(themes) as (keyof typeof themes)[];

  it('has three looks, each light and dark', () => {
    expect(names.sort()).toEqual(
      [
        'compact-dark',
        'compact-light',
        'midnight-dark',
        'midnight-light',
        'warm-dark',
        'warm-light',
      ].sort(),
    );
  });

  it('gives every theme the same token shape (Unistyles needs this)', () => {
    const reference = shape(themes['midnight-dark']);
    for (const n of names) expect(shape(themes[n])).toEqual(reference);
  });

  it('uses the Midnight canvas from the brief', () => {
    expect(themes['midnight-dark'].colors.canvas).toBe('#000814');
    expect(themes['midnight-dark'].colors.text).toBe('rgba(255,255,255,0.90)');
  });

  it('makes Compact denser than Midnight', () => {
    const c = LOOK_TOKENS.compact;
    const m = LOOK_TOKENS.midnight;
    expect(c.size.rowHeight).toBeLessThan(m.size.rowHeight);
    expect(c.type.body.fontSize).toBeLessThan(m.type.body.fontSize);
    expect(c.space.lg).toBeLessThan(m.space.lg);
    expect(c.layout.light.denseTables).toBe(true);
  });

  it('uses Inter for every text style', () => {
    for (const n of names) {
      for (const style of Object.values(themes[n].type))
        expect(style.fontFamily).toMatch(/^Inter_/);
    }
  });

  it('turns category colours into translucent tints', () => {
    expect(themes['warm-light'].colors.categoryMuted.c1).toMatch(/^rgba\(\d+,\d+,\d+,0\.12\)$/);
  });
});
