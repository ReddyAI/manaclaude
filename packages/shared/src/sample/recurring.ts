import type { LocalDate, MinorUnits } from '../model/common';
import type { RecurringFrequency, RecurringItem } from '../model/recurring';
import type { Transaction } from '../model/transaction';
import { addDays, addMonths } from '../dates/dates';

interface Seed {
  id: string;
  name: string;
  merchantId: string | null;
  categoryId: string;
  accountId: string;
  kind: RecurringItem['kind'];
  frequency: RecurringFrequency;
  expected: MinorUnits;
  isVariable?: boolean;
  decision?: RecurringItem['decision'];
}

const SEEDS: Seed[] = [
  {
    id: 'rec_paycheck',
    name: 'Acme Corp payroll',
    merchantId: 'mer_employer',
    categoryId: 'cat_paycheck',
    accountId: 'acc_checking',
    kind: 'income',
    frequency: 'biweekly',
    expected: 421_538,
  },
  {
    id: 'rec_rent',
    name: 'Rent',
    merchantId: 'mer_landlord',
    categoryId: 'cat_rent',
    accountId: 'acc_checking',
    kind: 'bill',
    frequency: 'monthly',
    expected: -235_000,
  },
  {
    id: 'rec_auto_loan',
    name: 'Auto loan',
    merchantId: null,
    categoryId: 'cat_loan_payment',
    accountId: 'acc_checking',
    kind: 'bill',
    frequency: 'monthly',
    expected: -45_218,
  },
  {
    id: 'rec_internet',
    name: 'Xfinity internet',
    merchantId: 'mer_xfinity',
    categoryId: 'cat_internet',
    accountId: 'acc_checking',
    kind: 'bill',
    frequency: 'monthly',
    expected: -7_999,
  },
  {
    id: 'rec_phone',
    name: 'Verizon',
    merchantId: 'mer_verizon',
    categoryId: 'cat_internet',
    accountId: 'acc_checking',
    kind: 'bill',
    frequency: 'monthly',
    expected: -8_500,
  },
  {
    id: 'rec_power',
    name: 'City Power & Light',
    merchantId: 'mer_power',
    categoryId: 'cat_utilities',
    accountId: 'acc_checking',
    kind: 'bill',
    frequency: 'monthly',
    expected: -11_500,
    isVariable: true,
  },
  {
    id: 'rec_car_insurance',
    name: 'Safe Road Insurance',
    merchantId: 'mer_insurance',
    categoryId: 'cat_car',
    accountId: 'acc_card_cashback',
    kind: 'bill',
    frequency: 'semiannual',
    expected: -64_200,
  },
  {
    id: 'rec_netflix',
    name: 'Netflix',
    merchantId: 'mer_netflix',
    categoryId: 'cat_subscriptions',
    accountId: 'acc_card_cashback',
    kind: 'subscription',
    frequency: 'monthly',
    expected: -1_799,
    decision: 'review',
  },
  {
    id: 'rec_spotify',
    name: 'Spotify',
    merchantId: 'mer_spotify',
    categoryId: 'cat_subscriptions',
    accountId: 'acc_card_cashback',
    kind: 'subscription',
    frequency: 'monthly',
    expected: -1_199,
    decision: 'keep',
  },
  {
    id: 'rec_icloud',
    name: 'iCloud+',
    merchantId: 'mer_icloud',
    categoryId: 'cat_subscriptions',
    accountId: 'acc_card_cashback',
    kind: 'subscription',
    frequency: 'monthly',
    expected: -299,
    decision: 'keep',
  },
  {
    id: 'rec_gym',
    name: 'Iron Works Gym',
    merchantId: 'mer_gym',
    categoryId: 'cat_fitness',
    accountId: 'acc_card_cashback',
    kind: 'subscription',
    frequency: 'monthly',
    expected: -4_900,
    decision: 'cancel',
  },
];

function step(date: LocalDate, f: RecurringFrequency): LocalDate {
  switch (f) {
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
    case 'semiannual':
      return addMonths(date, 6);
    case 'annual':
      return addMonths(date, 12);
  }
}

/** Recurring items whose history comes from the sample transactions. */
export function sampleRecurring(
  transactions: readonly Transaction[],
  today: LocalDate,
): RecurringItem[] {
  return SEEDS.map((s) => {
    const charges = transactions
      .filter((t) => t.recurringId === s.id && t.splitParentId === null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const last = charges[charges.length - 1];
    let next = last ? step(last.date, s.frequency) : null;
    while (next !== null && next < today) next = step(next, s.frequency);
    return {
      id: s.id,
      name: s.name,
      merchantId: s.merchantId,
      categoryId: s.categoryId,
      accountId: s.accountId,
      kind: s.kind,
      frequency: s.frequency,
      expectedAmount: last?.amount ?? s.expected,
      currency: 'USD',
      isVariable: s.isVariable ?? false,
      lastDate: last?.date ?? null,
      nextDueDate: next,
      status: 'active',
      decision: s.kind === 'subscription' ? (s.decision ?? 'review') : null,
      priceHistory: charges.map((c) => ({ date: c.date, amount: c.amount })),
      detectedBy: s.kind === 'subscription' ? 'ai' : 'rule',
      aiConfidence: s.kind === 'subscription' ? 0.9 : null,
    };
  });
}
