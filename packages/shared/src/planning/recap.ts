import type { CurrencyCode, Id, LocalDate, MinorUnits } from '../model/common';
import type { Recap, RecapCategoryLine } from '../model/recap';
import type { FinanceDataset } from '../model/dataset';
import { classifyAccountType } from '../model/account';
import {
  addDays,
  addMonthsToMonth,
  daysBetween,
  firstDayOfMonth,
  formatMonth,
  lastDayOfMonth,
} from '../dates/dates';
import { convertAmount } from '../fx/convert';
import { formatMoney } from '../money/format';
import { reportTreatment, type TreatmentContext } from '../policy/treatment';
import { summarizeSpending } from '../policy/summary';

/**
 * Recaps built from the transactions on the device. Session B's recap job
 * produces the same `Recap` shape with AI-written text; until then (and when AI
 * is off) the app uses these.
 */

export interface RecapPeriod {
  kind: Recap['kind'];
  start: LocalDate;
  end: LocalDate;
}

/** The last 7 days, ending today. */
export function weeklyPeriod(today: LocalDate): RecapPeriod {
  return { kind: 'weekly', start: addDays(today, -6), end: today };
}

/** A calendar month. For the current month the period stops at `today`. */
export function monthlyPeriod(month: string, today: LocalDate): RecapPeriod {
  const end = lastDayOfMonth(month);
  return { kind: 'monthly', start: firstDayOfMonth(month), end: end > today ? today : end };
}

/** The period right before this one, same length (previous calendar month for monthly). */
function previousPeriod(period: RecapPeriod): { start: LocalDate; end: LocalDate } {
  if (period.kind === 'weekly') {
    return { start: addDays(period.start, -7), end: addDays(period.start, -1) };
  }
  const prev = addMonthsToMonth(period.start.slice(0, 7), -1);
  return { start: firstDayOfMonth(prev), end: lastDayOfMonth(prev) };
}

function netWorthOn(data: FinanceDataset, currency: CurrencyCode, date: LocalDate): number | null {
  const accounts = new Map(data.accounts.filter((a) => a.includeInNetWorth).map((a) => [a.id, a]));
  const latest = new Map<Id, { date: LocalDate; balance: number; currency: CurrencyCode }>();
  for (const s of data.balanceHistory) {
    if (s.date > date || !accounts.has(s.accountId)) continue;
    const cur = latest.get(s.accountId);
    if (!cur || s.date > cur.date) latest.set(s.accountId, s);
  }
  if (latest.size === 0) return null;
  let total = 0;
  for (const [id, snap] of latest) {
    const acc = accounts.get(id)!;
    const v = convertAmount(snap.balance, snap.currency, currency, data.fxRates) ?? 0;
    total += classifyAccountType(acc.type) === 'liability' ? -v : v;
  }
  return total;
}

export interface BuildRecapOptions {
  period: RecapPeriod;
  currency: CurrencyCode;
  ctx: TreatmentContext;
  now?: Date;
}

export function buildRecap(data: FinanceDataset, options: BuildRecapOptions): Recap {
  const { period, currency, ctx } = options;
  const prev = previousPeriod(period);
  const rates = data.fxRates;
  const current = summarizeSpending(data.transactions, ctx, {
    from: period.start,
    to: period.end,
    currency,
    rates,
  });
  const before = summarizeSpending(data.transactions, ctx, {
    from: prev.start,
    to: prev.end,
    currency,
    rates,
  });

  const topCategories: RecapCategoryLine[] = Object.entries(current.byCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, amount]) => ({
      categoryId,
      amount,
      previous: before.byCategory[categoryId] ?? 0,
    }));

  const biggest: { transactionId: Id; amount: MinorUnits }[] = [];
  for (const t of data.transactions) {
    if (t.date < period.start || t.date > period.end) continue;
    if (reportTreatment(t, ctx).kind !== 'spending') continue;
    const converted = convertAmount(t.amount, t.currency, currency, rates, {
      mode: 'on',
      date: t.date,
    });
    if (converted !== null && converted < 0) {
      biggest.push({ transactionId: t.id, amount: -converted });
    }
  }
  biggest.sort((a, b) => b.amount - a.amount);

  const startNw = netWorthOn(data, currency, addDays(period.start, -1));
  const endNw = netWorthOn(data, currency, period.end);
  const netWorthChange = startNw !== null && endNw !== null ? endNw - startNw : null;

  const label = period.kind === 'weekly' ? 'this week' : formatMonth(period.start.slice(0, 7));
  const vsLabel = period.kind === 'weekly' ? 'the week before' : 'the month before';
  const diff = current.spending - before.spending;
  const pct = before.spending > 0 ? Math.round((Math.abs(diff) / before.spending) * 100) : null;
  const money = (v: number) => formatMoney(v, currency, { cents: 'never' });
  const headline =
    pct === null || diff === 0
      ? `You spent ${money(current.spending)} ${label}.`
      : `You spent ${money(current.spending)} ${label}, ${pct}% ${diff > 0 ? 'more' : 'less'} than ${vsLabel}.`;

  const highlights: string[] = [];
  const top = topCategories[0];
  if (top) {
    const name = data.categories.find((c) => c.id === top.categoryId)?.name ?? 'Uncategorized';
    const share = current.spending > 0 ? Math.round((top.amount / current.spending) * 100) : 0;
    highlights.push(
      `${name} was the biggest category at ${money(top.amount)} (${share}% of spending).`,
    );
  }
  const rise = topCategories
    .map((c) => ({ c, delta: c.amount - c.previous }))
    .filter((x) => x.c.previous > 0 && x.delta > 0)
    .sort((a, b) => b.delta - a.delta)[0];
  if (rise) {
    const name = data.categories.find((c) => c.id === rise.c.categoryId)?.name ?? 'A category';
    highlights.push(`${name} is up ${money(rise.delta)} from ${vsLabel}.`);
  }
  const big = biggest[0];
  if (big) {
    const t = data.transactions.find((x) => x.id === big.transactionId);
    const merchant = t?.merchantId
      ? data.merchants.find((m) => m.id === t.merchantId)?.name
      : undefined;
    highlights.push(
      `Biggest purchase: ${money(big.amount)}${merchant ? ` at ${merchant}` : t?.name ? ` (${t.name})` : ''}.`,
    );
  }
  if (current.income > 0) highlights.push(`Income was ${money(current.income)}.`);
  if (netWorthChange !== null) {
    highlights.push(
      `Net worth ${netWorthChange >= 0 ? 'rose' : 'fell'} by ${money(Math.abs(netWorthChange))}.`,
    );
  }
  const days = daysBetween(period.start, period.end) + 1;
  if (current.spending > 0 && days > 0) {
    highlights.push(`That is about ${money(Math.round(current.spending / days))} a day.`);
  }

  const created = (options.now ?? new Date()).toISOString();
  return {
    id: `recap_${period.kind}_${period.start}`,
    kind: period.kind,
    periodStart: period.start,
    periodEnd: period.end,
    currency,
    spending: current.spending,
    income: current.income,
    previousSpending: before.spending,
    topCategories,
    biggestTransactions: biggest.slice(0, 3),
    netWorthChange,
    headline,
    highlights,
    source: 'local',
    createdAt: created,
  };
}
