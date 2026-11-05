import type { LocalDate, MinorUnits } from '../model/common';
import type { RecurringFrequency, RecurringItem } from '../model/recurring';
import { addDays } from '../dates/dates';

/** How many times each frequency happens in a month (monthly = 1). */
export const PER_MONTH: Record<RecurringFrequency, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
};

export const PER_YEAR: Record<RecurringFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  semiannual: 2,
  annual: 1,
};

/** Amount per month for a recurring item (keeps the sign), rounded to a whole minor unit. */
export function monthlyEquivalent(item: Pick<RecurringItem, 'expectedAmount' | 'frequency'>) {
  return Math.round(item.expectedAmount * PER_MONTH[item.frequency]);
}

export interface PriceIncrease {
  /** Previous charge and latest charge, both positive. */
  from: MinorUnits;
  to: MinorUnits;
  /** (to - from) / from */
  pct: number;
  /** Extra cost per year at the new price. */
  yearlyImpact: MinorUnits;
  since: LocalDate;
}

/**
 * The latest charge against the one before it, when it went up. Variable bills
 * (electricity) move every month, so they never raise an alert.
 */
export function priceIncrease(item: RecurringItem): PriceIncrease | null {
  if (item.isVariable || item.expectedAmount >= 0) return null;
  const h = item.priceHistory;
  if (h.length < 2) return null;
  const last = h[h.length - 1]!;
  let prev: (typeof h)[number] | undefined;
  for (let i = h.length - 2; i >= 0; i -= 1) {
    if (h[i]!.amount !== last.amount) {
      prev = h[i];
      break;
    }
  }
  if (!prev || Math.abs(last.amount) <= Math.abs(prev.amount)) return null;
  // Only the first charge at the new price counts as "since"; walk back over repeats.
  let since = last.date;
  for (let i = h.length - 1; i >= 0 && h[i]!.amount === last.amount; i -= 1) since = h[i]!.date;
  const from = Math.abs(prev.amount);
  const to = Math.abs(last.amount);
  return {
    from,
    to,
    pct: (to - from) / from,
    yearlyImpact: Math.round((to - from) * PER_YEAR[item.frequency]),
    since,
  };
}

/** Active charges due in the next `days` days (today included), soonest first, repeats expanded. */
export function upcomingCharges(
  items: readonly RecurringItem[],
  today: LocalDate,
  days: number,
): { item: RecurringItem; date: LocalDate }[] {
  const until = addDays(today, days);
  const out: { item: RecurringItem; date: LocalDate }[] = [];
  for (const item of items) {
    if (item.status !== 'active' || item.nextDueDate === null) continue;
    let date = item.nextDueDate;
    // Weekly and biweekly items can fall due more than once in the window.
    const stepDays = item.frequency === 'weekly' ? 7 : item.frequency === 'biweekly' ? 14 : null;
    while (date <= until) {
      if (date >= today) out.push({ item, date });
      if (stepDays === null) break;
      date = addDays(date, stepDays);
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.item.name.localeCompare(b.item.name));
}
