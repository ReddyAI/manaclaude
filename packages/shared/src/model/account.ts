import type { CurrencyCode, Id, IsoDateTime, LocalDate, MinorUnits, Timestamps } from './common';

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'cash',
  'brokerage',
  'retirement',
  'crypto',
  'loan',
  'mortgage',
  'property',
  'vehicle',
  'other_asset',
  'other_liability',
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountClassification = 'asset' | 'liability';

const LIABILITY_TYPES: ReadonlySet<AccountType> = new Set([
  'credit_card',
  'loan',
  'mortgage',
  'other_liability',
]);

export function classifyAccountType(type: AccountType): AccountClassification {
  return LIABILITY_TYPES.has(type) ? 'liability' : 'asset';
}

/**
 * Optional finer type. Known values are listed; any other string is allowed so
 * connectors can pass through what the provider says.
 */
export type AccountSubtype =
  | 'nre'
  | 'nro'
  | 'fcnr'
  | 'fixed_deposit'
  | 'ppf'
  | 'epf'
  | 'nps'
  | 'demat'
  | 'taxable'
  | '401k'
  | 'roth_401k'
  | 'ira'
  | 'roth_ira'
  | 'hsa'
  | '529'
  | 'hysa'
  | 'money_market'
  | 'cd'
  | 'auto_loan'
  | 'student_loan'
  | 'personal_loan'
  | 'heloc'
  | (string & {});

export interface Account extends Timestamps {
  id: Id;
  /** Name shown in the app ("Everyday Checking"). */
  name: string;
  institutionName: string | null;
  type: AccountType;
  subtype: AccountSubtype | null;
  /** Every account has one currency (ISO code). Its transactions use it too. */
  currency: CurrencyCode;
  /**
   * Current balance in the account's currency.
   * Assets: what you have. Liabilities: what you owe, as a positive number.
   * Net worth = sum of asset balances - sum of liability balances.
   */
  balance: MinorUnits;
  balanceAsOf: IsoDateTime;
  availableBalance: MinorUnits | null;
  /** Credit cards and lines of credit. */
  creditLimit: MinorUnits | null;
  /** Last 4 digits for display. Never store a full account number. */
  mask: string | null;
  /** null for manual accounts (cash, vehicles, statement-only accounts). */
  connectionId: Id | null;
  /** The provider's id for this account. */
  externalId: string | null;
  includeInNetWorth: boolean;
  hidden: boolean;
  /** Cash accounts only: the default target of cash quick-add for this currency. */
  isDefaultCash: boolean;
  /** Loans: annual interest rate in percent ("6.49"), when known. */
  interestRate: string | null;
  /** Date the account was opened or first tracked. */
  openedOn: LocalDate | null;
}

/** One balance reading for an account, used for net worth history. */
export interface BalanceSnapshot {
  accountId: Id;
  date: LocalDate;
  /** Same sign rule as Account.balance. */
  balance: MinorUnits;
  currency: CurrencyCode;
}
