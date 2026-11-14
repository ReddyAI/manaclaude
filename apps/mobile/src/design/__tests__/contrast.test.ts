import { COLOR_SLOTS } from '@manaclaude/shared';
import { themes } from '../themes';

/**
 * Block U: every text colour in every look and scheme is readable (WCAG AA,
 * 4.5:1) on each surface it is drawn on, including its own tinted badge.
 */

type RGBA = [number, number, number, number];

function parse(c: string): RGBA {
  if (c.startsWith('#')) {
    const h = c.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as RGBA;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not a colour: ${c}`);
  const p = m[1]!.split(',').map((x) => Number(x.trim()));
  return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
}

function over(top: RGBA, under: RGBA): RGBA {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1) as RGBA;
}

function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

function contrast(fg: string, bg: string, under = '#FFFFFF'): number {
  const back = over(parse(bg), parse(under));
  const front = over(parse(fg), back);
  const [a, b] = [luminance(front), luminance(back)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const AA = 4.5;

describe.each(Object.values(themes).map((t) => [t.name, t] as const))('%s', (_name, theme) => {
  const c = theme.colors;
  const surfaces = {
    canvas: c.canvas,
    surface: c.surface,
    surfaceRaised: c.surfaceRaised,
    surfaceSunken: c.surfaceSunken,
  };
  const onCanvas = (bg: string) => over(parse(bg), parse(c.canvas));
  const hex = (x: RGBA) => `rgba(${x[0]},${x[1]},${x[2]},1)`;

  it.each(['text', 'textMuted', 'textFaint'] as const)('%s on every surface', (key) => {
    for (const [name, bg] of Object.entries(surfaces)) {
      expect([name, contrast(c[key], hex(onCanvas(bg))) >= AA]).toEqual([name, true]);
    }
  });

  it.each(['accent', 'income', 'spending', 'pending', 'danger', 'netWorth'] as const)(
    '%s as text on every surface and on its own tint',
    (key) => {
      for (const bg of Object.values(surfaces)) {
        expect(contrast(c[key], hex(onCanvas(bg)))).toBeGreaterThanOrEqual(AA);
      }
      // Tints sit on the page (swipe actions), on cards and on sheets.
      for (const [name, bg] of Object.entries(surfaces)) {
        if (name === 'surfaceSunken') continue;
        const tint = over(parse(c[`${key}Muted`]), onCanvas(bg));
        expect([name, contrast(c[key], hex(tint)) >= AA]).toEqual([name, true]);
      }
    },
  );

  it('tab labels on the tab bar', () => {
    const bar = hex(onCanvas(c.tabBar));
    expect(contrast(c.tabInactive, bar)).toBeGreaterThanOrEqual(AA);
    expect(contrast(c.tabActive, bar)).toBeGreaterThanOrEqual(AA);
  });

  it('text on an accent button', () => {
    expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(AA);
  });

  it('initials on their category tint', () => {
    for (const slot of COLOR_SLOTS) {
      const tint = over(parse(c.categoryMuted[slot]), onCanvas(c.surface));
      expect([slot, contrast(c.categoryText[slot], hex(tint)) >= AA]).toEqual([slot, true]);
    }
  });
});
