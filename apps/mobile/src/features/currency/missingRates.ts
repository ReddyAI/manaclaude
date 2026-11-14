import {
  formatMoney,
  formatShortDate,
  type CurrencyCode,
  type Transaction,
} from '@manaclaude/shared';

/**
 * Plain words for what a spending, income, budget or bill total leaves out
 * because no exchange rate converts it. Rates come from the Worker; a
 * currency it has no rate for at all can't be converted on any day.
 */

const REFRESH = 'Refresh rates in Settings, Exchange rates.';

function nameList(names: readonly string[], shown = 3): string {
  const quoted = names.slice(0, shown).map((n) => `"${n}"`);
  const more = names.length - quoted.length;
  return more > 0 ? `${quoted.join(', ')} and ${more} more` : quoted.join(', ');
}

function currencies(list: readonly { currency: CurrencyCode }[]): string {
  return [...new Set(list.map((x) => x.currency))].join(', ');
}

/** Transactions a total leaves out. */
export function skippedTransactionsText(
  txns: readonly Transaction[],
  to: CurrencyCode,
): string | null {
  const first = txns[0];
  if (!first) return null;
  if (txns.length === 1)
    return `Leaves out "${first.name}" (${formatMoney(Math.abs(first.amount), first.currency)}, ${formatShortDate(first.date)}): there is no ${first.currency} to ${to} exchange rate yet. ${REFRESH}`;
  return `Leaves out ${txns.length} transactions in ${currencies(txns)} with no exchange rate to ${to}: ${nameList(txns.map((t) => t.name))}. ${REFRESH}`;
}

/**
 * Bills, subscriptions, income items, holdings, sales or dividends a total
 * leaves out. `noun` names several of them ("items", "holdings").
 */
export function skippedItemsText(
  items: readonly { name: string; currency: CurrencyCode }[],
  to: CurrencyCode,
  noun = 'items',
): string | null {
  const first = items[0];
  if (!first) return null;
  if (items.length === 1)
    return `Leaves out "${first.name}" (${first.currency}): there is no ${first.currency} to ${to} exchange rate yet. ${REFRESH}`;
  return `Leaves out ${items.length} ${noun} in ${currencies(items)} with no exchange rate to ${to}: ${nameList(items.map((i) => i.name))}. ${REFRESH}`;
}

/** The Spending plan's savings, set in a currency with no rate: it counts as 0. */
export function savingsNoRateText(from: CurrencyCode, to: CurrencyCode): string {
  return `Savings is set in ${from}, and there is no ${from} to ${to} exchange rate yet, so it counts as 0 here. ${REFRESH}`;
}

/** Under one bill in a list: why its amount is not in the total above. */
export function billNoRateText(from: CurrencyCode, to: CurrencyCode): string {
  return `No ${from} to ${to} rate yet, so it is not in the plan`;
}

/** Budgets set in a currency with no rate: the budget math counts them as 0. */
export function budgetsNoRateText(
  budgets: readonly { name: string; currency: CurrencyCode }[],
  to: CurrencyCode,
): string | null {
  const first = budgets[0];
  if (!first) return null;
  if (budgets.length === 1)
    return `The "${first.name}" budget is in ${first.currency}, and there is no ${first.currency} to ${to} exchange rate yet, so it counts as 0 here. ${REFRESH}`;
  return `${budgets.length} budgets (${nameList(budgets.map((b) => b.name))}) are in ${currencies(budgets)} with no exchange rate to ${to}, so they count as 0 here. ${REFRESH}`;
}

/** Under a selected total: how many selected rows it leaves out. */
export function selectedNoRateText(count: number, to: CurrencyCode): string | null {
  if (count === 0) return null;
  return count === 1
    ? `1 is not in the total: no exchange rate to ${to}.`
    : `${count} are not in the total: no exchange rate to ${to}.`;
}
