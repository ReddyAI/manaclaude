import type { Look } from '@manaclaude/shared';
import { LOOK_TOKENS, type Scheme } from './tokens';

export type ThemeName = `${Look}-${Scheme}`;

function buildTheme(look: Look, scheme: Scheme) {
  const tokens = LOOK_TOKENS[look];
  return {
    name: `${look}-${scheme}` as ThemeName,
    look,
    scheme,
    colors: tokens.colors[scheme],
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
