import type { ColorSlot, Look } from '@manaclaude/shared';
import { CATEGORY_TEXT_LIGHT, LOOK_TOKENS, type Scheme } from './tokens';

/** "#7AA2FF" + 0.16 -> "rgba(122,162,255,0.16)" */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export type ThemeName = `${Look}-${Scheme}`;

function buildTheme(look: Look, scheme: Scheme) {
  const tokens = LOOK_TOKENS[look];
  const palette = tokens.colors[scheme];
  const tint = scheme === 'dark' ? 0.18 : 0.12;
  const categoryMuted = Object.fromEntries(
    Object.entries(palette.category).map(([slot, hex]) => [slot, withAlpha(hex, tint)]),
  ) as Record<ColorSlot, string>;
  return {
    name: `${look}-${scheme}` as ThemeName,
    look,
    scheme,
    colors: {
      ...palette,
      categoryMuted,
      /** Category colour for text on its own tint (readable in light schemes too). */
      categoryText: scheme === 'light' ? CATEGORY_TEXT_LIGHT : palette.category,
    },
    type: tokens.type,
    space: tokens.space,
    radius: tokens.radius,
    size: tokens.size,
    motion: tokens.motion,
    haptics: tokens.haptics,
    layout: tokens.layout[scheme],
  };
}

export type AppTheme = ReturnType<typeof buildTheme>;

export const themes = {
  'midnight-dark': buildTheme('midnight', 'dark'),
  'midnight-light': buildTheme('midnight', 'light'),
  'warm-light': buildTheme('warm', 'light'),
  'warm-dark': buildTheme('warm', 'dark'),
  'compact-light': buildTheme('compact', 'light'),
  'compact-dark': buildTheme('compact', 'dark'),
} satisfies Record<ThemeName, AppTheme>;

export function themeNameFor(look: Look, scheme: Scheme): ThemeName {
  return `${look}-${scheme}`;
}

/** Screen-width breakpoints. md and up gets the sidebar and two-column layouts. */
export const breakpoints = {
  xs: 0,
  sm: 600,
  md: 900,
  lg: 1200,
} as const;
