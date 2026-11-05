import type { CurrencyCode, Id, IsoDateTime, LocalDate, MinorUnits } from './common';

/**
 * A weekly recap or a Month in Review. Session B's recap job writes these
 * (with `source: 'ai'` and AI-written `headline` and `highlights`); until it
 * exists the app builds them locally from the transactions (`source: 'local'`).
 * All amounts are in `currency`, converted with the rate on each transaction's date.
 */
export interface RecapCategoryLine {
  categoryId: Id;
  /** Spending in the period (positive; can be negative after refunds). */
  amount: MinorUnits;
  /** Same category in the period before. */
  previous: MinorUnits;
}

export interface RecapTransactionRef {
  transactionId: Id;
  /** Spending amount, positive. */
  amount: MinorUnits;
}

export interface Recap {
  id: Id;
  kind: 'weekly' | 'monthly';
  /** First and last day of the period, inclusive. */
  periodStart: LocalDate;
  periodEnd: LocalDate;
  currency: CurrencyCode;
  spending: MinorUnits;
  income: MinorUnits;
  /** Spending in the period before, for the comparison line. */
  previousSpending: MinorUnits;
  topCategories: RecapCategoryLine[];
  biggestTransactions: RecapTransactionRef[];
  /** Net worth at the end of the period minus the start, latest rates. */
  netWorthChange: MinorUnits | null;
  /** One line summary. */
  headline: string;
  /** A few short sentences. */
  highlights: string[];
  source: 'local' | 'ai';
  createdAt: IsoDateTime;
}
