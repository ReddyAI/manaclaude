import {
  decToNumber,
  priceOnOrBefore,
  quantityAt,
  type CurrencyCode,
  type Id,
  type InvestmentActivity,
  type LocalDate,
  type PricePoint,
} from '@manaclaude/shared';

/**
 * What `benchmarkComparison` leaves out for want of an exchange rate, with
 * the same rules: a holding whose activities are in a currency `fx` can't
 * convert adds nothing to the portfolio line on any date it is held, and a
 * buy or sale in such a currency adds nothing to the money moved into the
 * index. Returns each security once with that currency, in first-seen order.
 */
export function benchmarkLeftOut(input: {
  activities: readonly InvestmentActivity[];
  prices: readonly PricePoint[];
  dates: readonly LocalDate[];
  fx: (currency: CurrencyCode) => number | null;
}): { securityId: Id; currency: CurrencyCode }[] {
  const { activities, prices, dates, fx } = input;
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined || dates.length < 2) return [];

  const out = new Map<string, { securityId: Id; currency: CurrencyCode }>();
  const add = (securityId: Id, currency: CurrencyCode) => {
    const key = `${securityId}|${currency}`;
    if (!out.has(key)) out.set(key, { securityId, currency });
  };

  // Holdings: grouped by account and security, priced in the group's first
  // activity's currency, as the comparison does.
  const groups = new Map<string, InvestmentActivity[]>();
  for (const a of activities) {
    if (a.securityId === null) continue;
    const key = `${a.accountId}|${a.securityId}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const acts of groups.values()) {
    const head = acts[0];
    if (!head || head.securityId === null || fx(head.currency) !== null) continue;
    const securityId = head.securityId;
    const held = dates.some(
      (d) =>
        priceOnOrBefore(prices, securityId, d) !== null && decToNumber(quantityAt(acts, d)) !== 0,
    );
    if (held) add(securityId, head.currency);
  }

  // Buys and sales inside the range move money into the index line.
  for (const a of activities) {
    if (a.type !== 'buy' && a.type !== 'sell') continue;
    if (a.securityId === null || a.date <= first || a.date > last) continue;
    if (fx(a.currency) === null) add(a.securityId, a.currency);
  }

  return [...out.values()];
}
