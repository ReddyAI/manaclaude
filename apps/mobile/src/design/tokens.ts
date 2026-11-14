import type { ColorSlot, Look } from '@manaclaude/shared';

/**
 * Design tokens for the three looks. Every component reads these through the
 * active Unistyles theme; screens never hard-code colours or sizes.
 *
 * Midnight: near-black navy canvas, large display numbers, charts first.
 * Warm: warmer palette, card widgets with soft shadows.
 * Compact: short rows, smaller type, dense tables on wide screens.
 */

export type Scheme = 'light' | 'dark';

export interface ColorTokens {
  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  border: string;
  borderStrong: string;
  overlay: string;
  text: string;
  textMuted: string;
  textFaint: string;
  textInverse: string;
  accent: string;
  accentMuted: string;
  onAccent: string;
  income: string;
  incomeMuted: string;
  spending: string;
  spendingMuted: string;
  netWorth: string;
  netWorthMuted: string;
  pending: string;
  pendingMuted: string;
  danger: string;
  dangerMuted: string;
  success: string;
  focus: string;
  chartGrid: string;
  chartComparison: string;
  tabBar: string;
  tabActive: string;
  tabInactive: string;
  skeleton: string;
  /** Shadow colour including its opacity; transparent for flat looks. */
  shadow: string;
  category: Record<ColorSlot, string>;
}

export interface TextStyleToken {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

export interface TypographyTokens {
  display: TextStyleToken;
  title: TextStyleToken;
  headline: TextStyleToken;
  body: TextStyleToken;
  bodyStrong: TextStyleToken;
  label: TextStyleToken;
  caption: TextStyleToken;
  micro: TextStyleToken;
  amountHero: TextStyleToken;
  amountLarge: TextStyleToken;
  amount: TextStyleToken;
  amountSmall: TextStyleToken;
}

export type TypeVariant = keyof TypographyTokens;

export interface SpaceTokens {
  none: number;
  xxs: number;
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
  xxxl: number;
}

export interface RadiusTokens {
  none: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  pill: number;
}

export interface SizeTokens {
  iconXs: number;
  iconSm: number;
  iconMd: number;
  iconLg: number;
  avatarSm: number;
  avatarMd: number;
  avatarLg: number;
  touchTarget: number;
  rowHeight: number;
  tableRowHeight: number;
  buttonSm: number;
  buttonMd: number;
  buttonLg: number;
  inputHeight: number;
  tabBarHeight: number;
  sidebarWidth: number;
  chartHeight: number;
  chartHeightSmall: number;
  progressHeight: number;
  hairline: number;
  borderWidth: number;
  focusRing: number;
  maxContentWidth: number;
  sheetHandleWidth: number;
  sheetHandleHeight: number;
  sheetMaxWidth: number;
  chipHeight: number;
  badgeHeight: number;
  switchWidth: number;
  switchHeight: number;
  dot: number;
}

export interface MotionTokens {
  fast: number;
  normal: number;
  slow: number;
  /** Reanimated spring config for sheets and swipes. */
  spring: { damping: number; stiffness: number; mass: number };
  /** Scale applied to pressed buttons and rows. */
  pressScale: number;
}

/** How strongly haptics fire in this look (Settings can still turn them off). */
export interface HapticTokens {
  /** Tick while scrubbing a chart. */
  scrubTicks: boolean;
  /** Impact strength on iOS for taps. */
  impact: 'light' | 'medium' | 'heavy';
}

export interface LayoutTokens {
  /** Cards: raised (shadow), flat (fill only) or outlined (border). */
  card: 'raised' | 'flat' | 'outlined';
  /** Show transactions as a spreadsheet table on wide screens. */
  denseTables: boolean;
  /** Dashboard puts the big chart first (Midnight) or the widget grid first. */
  chartFirst: boolean;
  /** Elevation used for raised cards. */
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffsetY: number;
  elevation: number;
}

// ---------------------------------------------------------------------------
// Fonts (Inter). Weights are separate font files so Android picks the right one.
// ---------------------------------------------------------------------------

export const FONT = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

function t(
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
): TextStyleToken {
  return { fontFamily, fontSize, lineHeight, letterSpacing };
}

// ---------------------------------------------------------------------------
// Category colour slots, tuned per scheme.
// ---------------------------------------------------------------------------

const CATEGORY_DARK: Record<ColorSlot, string> = {
  c1: '#7AA2FF',
  c2: '#F6C45B',
  c3: '#5FD4C4',
  c4: '#C59BFF',
  c5: '#6FD98C',
  c6: '#FF9671',
  c7: '#E5A46C',
  c8: '#F38BB6',
  c9: '#8EC5FF',
  c10: '#B8C46A',
  c11: '#FF8FA3',
  c12: '#9FA8FF',
};

const CATEGORY_LIGHT: Record<ColorSlot, string> = {
  c1: '#3D6FE0',
  c2: '#C98A12',
  c3: '#14958A',
  c4: '#8A55D6',
  c5: '#2E9E55',
  c6: '#DD5A31',
  c7: '#A86A2D',
  c8: '#C94683',
  c9: '#2F86D6',
  c10: '#7C8A1E',
  c11: '#D2405F',
  c12: '#5A63D8',
};

/**
 * Category colours for text on their own light tint (initials in a tinted
 * circle): CATEGORY_LIGHT darkened just enough for 4.5:1 on that tint.
 */
export const CATEGORY_TEXT_LIGHT: Record<ColorSlot, string> = {
  c1: '#315AB5',
  c2: '#81580C',
  c3: '#0E6A62',
  c4: '#7347B2',
  c5: '#206D3B',
  c6: '#9F4123',
  c7: '#855424',
  c8: '#9F3767',
  c9: '#22629C',
  c10: '#5B6516',
  c11: '#A6334B',
  c12: '#4C53B5',
};

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export interface LookTokens {
  colors: Record<Scheme, ColorTokens>;
  type: TypographyTokens;
  space: SpaceTokens;
  radius: RadiusTokens;
  size: SizeTokens;
  motion: MotionTokens;
  haptics: HapticTokens;
  layout: Record<Scheme, LayoutTokens>;
}

const baseSize: SizeTokens = {
  iconXs: 14,
  iconSm: 16,
  iconMd: 20,
  iconLg: 24,
  avatarSm: 28,
  avatarMd: 36,
  avatarLg: 48,
  touchTarget: 44,
  rowHeight: 60,
  tableRowHeight: 40,
  buttonSm: 32,
  buttonMd: 44,
  buttonLg: 52,
  inputHeight: 48,
  tabBarHeight: 64,
  sidebarWidth: 240,
  chartHeight: 200,
  chartHeightSmall: 72,
  progressHeight: 8,
  hairline: 1,
  borderWidth: 1,
  focusRing: 2,
  maxContentWidth: 1180,
  sheetHandleWidth: 40,
  sheetHandleHeight: 5,
  sheetMaxWidth: 560,
  chipHeight: 32,
  badgeHeight: 22,
  switchWidth: 48,
  switchHeight: 28,
  dot: 8,
};

const midnight: LookTokens = {
  colors: {
    dark: {
      canvas: '#000814',
      surface: '#08142A',
      surfaceRaised: '#0F1E3A',
      surfaceSunken: '#030B1A',
      border: 'rgba(255,255,255,0.08)',
      borderStrong: 'rgba(255,255,255,0.16)',
      overlay: 'rgba(0,4,12,0.72)',
      text: 'rgba(255,255,255,0.90)',
      textMuted: 'rgba(255,255,255,0.62)',
      textFaint: 'rgba(255,255,255,0.47)',
      textInverse: '#000814',
      accent: '#699FFF',
      accentMuted: 'rgba(105,159,255,0.18)',
      onAccent: '#000814',
      income: '#3DDC97',
      incomeMuted: 'rgba(61,220,151,0.16)',
      spending: '#FF6B6B',
      spendingMuted: 'rgba(255,107,107,0.16)',
      netWorth: '#5AA9FF',
      netWorthMuted: 'rgba(90,169,255,0.16)',
      pending: '#FFD23F',
      pendingMuted: 'rgba(255,210,63,0.16)',
      danger: '#FF5C5C',
      dangerMuted: 'rgba(255,92,92,0.16)',
      success: '#3DDC97',
      focus: '#8AB4FF',
      chartGrid: 'rgba(255,255,255,0.07)',
      chartComparison: 'rgba(255,255,255,0.28)',
      tabBar: '#030B1A',
      tabActive: 'rgba(255,255,255,0.95)',
      tabInactive: 'rgba(255,255,255,0.47)',
      skeleton: 'rgba(255,255,255,0.06)',
      shadow: 'rgba(0,0,0,0)',
      category: CATEGORY_DARK,
    },
    light: {
      canvas: '#F5F7FB',
      surface: '#FFFFFF',
      surfaceRaised: '#FFFFFF',
      surfaceSunken: '#EBEFF6',
      border: 'rgba(0,8,20,0.08)',
      borderStrong: 'rgba(0,8,20,0.16)',
      overlay: 'rgba(0,8,20,0.40)',
      text: 'rgba(0,8,20,0.92)',
      textMuted: 'rgba(0,8,20,0.60)',
      textFaint: 'rgba(0,8,20,0.57)',
      textInverse: '#FFFFFF',
      accent: '#1F5FE0',
      accentMuted: 'rgba(31,95,224,0.10)',
      onAccent: '#FFFFFF',
      income: '#0B7552',
      incomeMuted: 'rgba(11,117,82,0.10)',
      spending: '#BB3434',
      spendingMuted: 'rgba(187,52,52,0.10)',
      netWorth: '#1C63C8',
      netWorthMuted: 'rgba(28,99,200,0.10)',
      pending: '#826000',
      pendingMuted: 'rgba(130,96,0,0.12)',
      danger: '#C22828',
      dangerMuted: 'rgba(194,40,40,0.10)',
      success: '#0B7552',
      focus: '#1F5FE0',
      chartGrid: 'rgba(0,8,20,0.06)',
      chartComparison: 'rgba(0,8,20,0.25)',
      tabBar: '#FFFFFF',
      tabActive: 'rgba(0,8,20,0.92)',
      tabInactive: 'rgba(0,8,20,0.57)',
      skeleton: 'rgba(0,8,20,0.06)',
      shadow: 'rgba(0,8,20,0.07)',
      category: CATEGORY_LIGHT,
    },
  },
  type: {
    display: t(FONT.bold, 44, 50, -1.2),
    title: t(FONT.semibold, 28, 34, -0.6),
    headline: t(FONT.semibold, 17, 22, -0.2),
    body: t(FONT.regular, 15, 21),
    bodyStrong: t(FONT.medium, 15, 21),
    label: t(FONT.medium, 13, 17),
    caption: t(FONT.regular, 12, 16),
    micro: t(FONT.semibold, 11, 14, 0.4),
    amountHero: t(FONT.semibold, 46, 52, -1.4),
    amountLarge: t(FONT.semibold, 28, 34, -0.6),
    amount: t(FONT.medium, 15, 21),
    amountSmall: t(FONT.medium, 13, 17),
  },
  space: { none: 0, xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { none: 0, sm: 8, md: 14, lg: 20, xl: 28, pill: 999 },
  size: { ...baseSize, rowHeight: 64, chartHeight: 220 },
  motion: {
    fast: 140,
    normal: 240,
    slow: 420,
    spring: { damping: 22, stiffness: 220, mass: 1 },
    pressScale: 0.97,
  },
  haptics: { scrubTicks: true, impact: 'light' },
  layout: {
    dark: {
      card: 'flat',
      denseTables: false,
      chartFirst: true,
      shadowOpacity: 0,
      shadowRadius: 0,
      shadowOffsetY: 0,
      elevation: 0,
    },
    light: {
      card: 'raised',
      denseTables: false,
      chartFirst: true,
      shadowOpacity: 0.06,
      shadowRadius: 16,
      shadowOffsetY: 4,
      elevation: 2,
    },
  },
};

const warm: LookTokens = {
  colors: {
    light: {
      canvas: '#F7F3EE',
      surface: '#FFFFFF',
      surfaceRaised: '#FFFFFF',
      surfaceSunken: '#EFE8DF',
      border: '#E8DFD4',
      borderStrong: '#D8CBBB',
      overlay: 'rgba(43,33,24,0.40)',
      text: '#2A2119',
      textMuted: '#62564A',
      textFaint: '#6F665B',
      textInverse: '#FFFFFF',
      accent: '#A04820',
      accentMuted: 'rgba(160,72,32,0.12)',
      onAccent: '#FFFFFF',
      income: '#257044',
      incomeMuted: 'rgba(37,112,68,0.12)',
      spending: '#AF3C37',
      spendingMuted: 'rgba(175,60,55,0.10)',
      netWorth: '#3963A4',
      netWorthMuted: 'rgba(57,99,164,0.12)',
      pending: '#7E5A12',
      pendingMuted: 'rgba(126,90,18,0.14)',
      danger: '#B43630',
      dangerMuted: 'rgba(180,54,48,0.10)',
      success: '#257044',
      focus: '#A04820',
      chartGrid: '#EFE7DD',
      chartComparison: '#CDBEAD',
      tabBar: '#FFFFFF',
      tabActive: '#A04820',
      tabInactive: '#6F655B',
      skeleton: '#EFE8DF',
      shadow: 'rgba(91,60,30,0.09)',
      category: CATEGORY_LIGHT,
    },
    dark: {
      canvas: '#17130F',
      surface: '#221C17',
      surfaceRaised: '#2B241E',
      surfaceSunken: '#120F0C',
      border: '#362D25',
      borderStrong: '#4A3F34',
      overlay: 'rgba(10,7,4,0.66)',
      text: '#F3ECE3',
      textMuted: '#BFB2A3',
      textFaint: '#978B7F',
      textInverse: '#17130F',
      accent: '#F08A55',
      accentMuted: 'rgba(240,138,85,0.16)',
      onAccent: '#1B120C',
      income: '#5CC487',
      incomeMuted: 'rgba(92,196,135,0.16)',
      spending: '#F07C72',
      spendingMuted: 'rgba(240,124,114,0.14)',
      netWorth: '#7FA6E8',
      netWorthMuted: 'rgba(127,166,232,0.16)',
      pending: '#E8B94A',
      pendingMuted: 'rgba(232,185,74,0.16)',
      danger: '#F27E75',
      dangerMuted: 'rgba(242,126,117,0.14)',
      success: '#5CC487',
      focus: '#F08A55',
      chartGrid: '#2E271F',
      chartComparison: '#5C5045',
      tabBar: '#1C1713',
      tabActive: '#F08A55',
      tabInactive: '#978B7F',
      skeleton: '#2B241E',
      shadow: 'rgba(0,0,0,0.35)',
      category: CATEGORY_DARK,
    },
  },
  type: {
    display: t(FONT.bold, 36, 42, -0.8),
    title: t(FONT.semibold, 24, 30, -0.4),
    headline: t(FONT.semibold, 17, 22, -0.1),
    body: t(FONT.regular, 15, 21),
    bodyStrong: t(FONT.medium, 15, 21),
    label: t(FONT.medium, 13, 17),
    caption: t(FONT.regular, 12, 16),
    micro: t(FONT.semibold, 11, 14, 0.3),
    amountHero: t(FONT.bold, 38, 44, -0.9),
    amountLarge: t(FONT.semibold, 24, 30, -0.4),
    amount: t(FONT.medium, 15, 21),
    amountSmall: t(FONT.medium, 13, 17),
  },
  space: { none: 0, xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 },
  radius: { none: 0, sm: 6, md: 10, lg: 16, xl: 22, pill: 999 },
  size: { ...baseSize, rowHeight: 60 },
  motion: {
    fast: 120,
    normal: 220,
    slow: 360,
    spring: { damping: 24, stiffness: 240, mass: 1 },
    pressScale: 0.98,
  },
  haptics: { scrubTicks: true, impact: 'light' },
  layout: {
    light: {
      card: 'raised',
      denseTables: false,
      chartFirst: false,
      shadowOpacity: 0.07,
      shadowRadius: 12,
      shadowOffsetY: 3,
      elevation: 2,
    },
    dark: {
      card: 'raised',
      denseTables: false,
      chartFirst: false,
      shadowOpacity: 0.3,
      shadowRadius: 10,
      shadowOffsetY: 3,
      elevation: 3,
    },
  },
};

const compact: LookTokens = {
  colors: {
    light: {
      canvas: '#F3F4F6',
      surface: '#FFFFFF',
      surfaceRaised: '#FFFFFF',
      surfaceSunken: '#ECEEF2',
      border: '#E1E4EA',
      borderStrong: '#C9CED8',
      overlay: 'rgba(17,24,39,0.40)',
      text: '#1B1F27',
      textMuted: '#5D6573',
      textFaint: '#656B75',
      textInverse: '#FFFFFF',
      accent: '#5146D9',
      accentMuted: 'rgba(81,70,217,0.10)',
      onAccent: '#FFFFFF',
      income: '#137438',
      incomeMuted: 'rgba(19,116,56,0.10)',
      spending: '#BF2E2A',
      spendingMuted: 'rgba(191,46,42,0.08)',
      netWorth: '#1D63C9',
      netWorthMuted: 'rgba(29,99,201,0.10)',
      pending: '#8A5B00',
      pendingMuted: 'rgba(138,91,0,0.10)',
      danger: '#BF2E2A',
      dangerMuted: 'rgba(191,46,42,0.08)',
      success: '#137438',
      focus: '#5146D9',
      chartGrid: '#E8EAEE',
      chartComparison: '#B9C0CC',
      tabBar: '#FFFFFF',
      tabActive: '#5146D9',
      tabInactive: '#646B77',
      skeleton: '#ECEEF2',
      shadow: 'rgba(0,0,0,0)',
      category: CATEGORY_LIGHT,
    },
    dark: {
      canvas: '#0E1116',
      surface: '#161A21',
      surfaceRaised: '#1C212A',
      surfaceSunken: '#0A0D11',
      border: '#2A303B',
      borderStrong: '#3A4250',
      overlay: 'rgba(0,0,0,0.6)',
      text: '#E4E8EE',
      textMuted: '#9AA3B2',
      textFaint: '#838997',
      textInverse: '#0E1116',
      accent: '#9892FF',
      accentMuted: 'rgba(152,146,255,0.16)',
      onAccent: '#0E1116',
      income: '#4CC27A',
      incomeMuted: 'rgba(76,194,122,0.14)',
      spending: '#F2706A',
      spendingMuted: 'rgba(242,112,106,0.12)',
      netWorth: '#6EA8FF',
      netWorthMuted: 'rgba(110,168,255,0.14)',
      pending: '#E0B341',
      pendingMuted: 'rgba(224,179,65,0.14)',
      danger: '#F2706A',
      dangerMuted: 'rgba(242,112,106,0.12)',
      success: '#4CC27A',
      focus: '#8B83FF',
      chartGrid: '#232934',
      chartComparison: '#4A5262',
      tabBar: '#12161C',
      tabActive: '#8B83FF',
      tabInactive: '#838997',
      skeleton: '#1C212A',
      shadow: 'rgba(0,0,0,0)',
      category: CATEGORY_DARK,
    },
  },
  type: {
    display: t(FONT.semibold, 28, 34, -0.5),
    title: t(FONT.semibold, 20, 26, -0.3),
    headline: t(FONT.semibold, 15, 20),
    body: t(FONT.regular, 13, 18),
    bodyStrong: t(FONT.medium, 13, 18),
    label: t(FONT.medium, 12, 16),
    caption: t(FONT.regular, 11, 14),
    micro: t(FONT.semibold, 10, 13, 0.3),
    amountHero: t(FONT.semibold, 30, 36, -0.6),
    amountLarge: t(FONT.semibold, 20, 26, -0.3),
    amount: t(FONT.medium, 13, 18),
    amountSmall: t(FONT.medium, 12, 16),
  },
  space: { none: 0, xxs: 2, xs: 3, sm: 6, md: 8, lg: 12, xl: 16, xxl: 24, xxxl: 32 },
  radius: { none: 0, sm: 4, md: 6, lg: 8, xl: 12, pill: 999 },
  size: {
    ...baseSize,
    iconMd: 18,
    iconLg: 20,
    avatarSm: 22,
    avatarMd: 28,
    avatarLg: 40,
    rowHeight: 44,
    tableRowHeight: 32,
    buttonSm: 28,
    buttonMd: 36,
    buttonLg: 44,
    inputHeight: 38,
    tabBarHeight: 56,
    sidebarWidth: 208,
    chartHeight: 160,
    chartHeightSmall: 56,
    progressHeight: 6,
    chipHeight: 26,
    badgeHeight: 18,
    switchWidth: 40,
    switchHeight: 24,
    dot: 6,
  },
  motion: {
    fast: 90,
    normal: 160,
    slow: 240,
    spring: { damping: 28, stiffness: 320, mass: 1 },
    pressScale: 0.99,
  },
  haptics: { scrubTicks: false, impact: 'light' },
  layout: {
    light: {
      card: 'outlined',
      denseTables: true,
      chartFirst: false,
      shadowOpacity: 0,
      shadowRadius: 0,
      shadowOffsetY: 0,
      elevation: 0,
    },
    dark: {
      card: 'outlined',
      denseTables: true,
      chartFirst: false,
      shadowOpacity: 0,
      shadowRadius: 0,
      shadowOffsetY: 0,
      elevation: 0,
    },
  },
};

export const LOOK_TOKENS: Record<Look, LookTokens> = { midnight, warm, compact };

export const LOOK_LABELS: Record<Look, { name: string; description: string }> = {
  midnight: { name: 'Midnight', description: 'Deep navy, big numbers, charts first' },
  warm: { name: 'Warm', description: 'Soft cream tones and card widgets' },
  compact: { name: 'Compact', description: 'Dense rows and tables for big screens' },
};
