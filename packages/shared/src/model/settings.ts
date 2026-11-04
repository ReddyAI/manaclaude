import type { CurrencyCode } from './common';

/** Header currency chip: USD only, INR only, both, or each account's own currency. */
export type DisplayCurrencyMode = 'USD' | 'INR' | 'BOTH' | 'NATIVE';

export const DISPLAY_CURRENCY_MODES: readonly DisplayCurrencyMode[] = ['USD', 'INR', 'BOTH', 'NATIVE'];

/** Never a free tier whose terms allow training on or human review of inputs. */
export type AiProvider = 'workers_ai' | 'anthropic' | 'openai' | 'openai_compatible' | 'gemini_paid';

export type Look = 'midnight' | 'warm' | 'compact';

export const LOOKS: readonly Look[] = ['midnight', 'warm', 'compact'];

export type ColorSchemePreference = 'system' | 'light' | 'dark';

export type DashboardLayout = 'widgets' | 'safe_to_spend';

/**
 * How each kind of transaction counts in spending and income. Defaults come
 * from the project brief; Sankar can change them in Settings later.
 */
export interface MoneyPolicies {
  /** Transfers between your own accounts. */
  transfers: 'exclude' | 'count';
  /** Credit card payments (the card purchases already count). */
  cardPayments: 'exclude' | 'count';
  /** Money moved into brokerage and retirement accounts. */
  investmentContributions: 'exclude' | 'count';
  /** Loan principal. Interest is a separate split line and always counts as spending. */
  loanPrincipal: 'exclude' | 'count';
  /**
   * Refunds (money coming back into an expense category).
   * reduce_category: subtract from that category's spending in the month the refund posts.
   * count_as_income: report as income instead.
   */
  refunds: 'reduce_category' | 'count_as_income';
  /** 'none' lets a category show a net credit; 'zero' floors category spending at 0. */
  categoryFloor: 'none' | 'zero';
  /** Pending transactions count in spending until they post. */
  pendingTransactions: 'include' | 'exclude';
}

export const DEFAULT_MONEY_POLICIES: MoneyPolicies = {
  transfers: 'exclude',
  cardPayments: 'exclude',
  investmentContributions: 'exclude',
  loanPrincipal: 'exclude',
  refunds: 'reduce_category',
  categoryFloor: 'none',
  pendingTransactions: 'include',
};

export interface Settings {
  displayCurrencyMode: DisplayCurrencyMode;
  /** The large currency in BOTH mode. */
  primaryCurrency: CurrencyCode;
  /** The small currency underneath in BOTH mode. */
  secondaryCurrency: CurrencyCode;
  /** One switch that stops every AI call. */
  aiEnabled: boolean;
  aiProvider: AiProvider;
  look: Look;
  colorScheme: ColorSchemePreference;
  hapticsEnabled: boolean;
  dashboardLayout: DashboardLayout;
  moneyPolicies: MoneyPolicies;
  /** MCP write tools stay off until turned on here. */
  mcpWriteToolsEnabled: boolean;
  /** 0 = Sunday, 1 = Monday. */
  weekStartsOn: 0 | 1;
}

export const DEFAULT_SETTINGS: Settings = {
  displayCurrencyMode: 'USD',
  primaryCurrency: 'USD',
  secondaryCurrency: 'INR',
  aiEnabled: true,
  aiProvider: 'workers_ai',
  look: 'midnight',
  colorScheme: 'system',
  hapticsEnabled: true,
  dashboardLayout: 'widgets',
  moneyPolicies: DEFAULT_MONEY_POLICIES,
  mcpWriteToolsEnabled: false,
  weekStartsOn: 0,
};
