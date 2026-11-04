import type { CurrencyCode, Id, LocalDate, MinorUnits } from './common';

export type RecurringFrequency =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

/** Rocket Money-style decision on a subscription. */
export type SubscriptionDecision = 'keep' | 'cancel' | 'review';

export interface RecurringPricePoint {
  date: LocalDate;
  /** Signed like the transactions (negative for bills). */
  amount: MinorUnits;
}

export interface RecurringItem {
  id: Id;
  name: string;
  merchantId: Id | null;
  categoryId: Id | null;
  accountId: Id | null;
  kind: 'bill' | 'subscription' | 'income' | 'transfer';
  frequency: RecurringFrequency;
  /** Expected amount of the next charge, signed (negative = money out). */
  expectedAmount: MinorUnits;
  currency: CurrencyCode;
  /** Bills that vary (electricity) set this; the UI shows "about". */
  isVariable: boolean;
  lastDate: LocalDate | null;
  nextDueDate: LocalDate | null;
  status: 'active' | 'paused' | 'cancelled';
  decision: SubscriptionDecision | null;
  /** Past charges, oldest first. Used for price-increase alerts. */
  priceHistory: RecurringPricePoint[];
  detectedBy: 'ai' | 'rule' | 'user';
  aiConfidence: number | null;
}
