import {
  addDays,
  buildTreatmentContext,
  firstDayOfMonth,
  formatMoney,
  lastDayOfMonth,
  monthOf,
  addMonthsToMonth,
  reportTreatment,
  summarizeSpending,
  type LocalDate,
  type Recap,
  type RecapData,
  type RecapPeriod,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { selectAll } from '../../db/table';
import {
  categoriesTable,
  recurringTable,
  transactionsTable,
  transferLinksTable,
} from '../../db/tables';
import { loadRates } from '../../fx/service';
import { newId, nowIso } from '../../util/ids';
import { getSettings } from '../../services/settings';
import { tryGetAi, type AiDeps } from '../provider';

export function periodRange(
  period: RecapPeriod,
  anchor: LocalDate,
  weekStartsOn: 0 | 1,
): { start: LocalDate; end: LocalDate } {
  if (period === 'month') {
    const m = monthOf(anchor);
    return { start: firstDayOfMonth(m), end: lastDayOfMonth(m) };
  }
  const dow = new Date(`${anchor}T00:00:00Z`).getUTCDay();
  const back = (dow - weekStartsOn + 7) % 7;
  const start = addDays(anchor, -back);
  return { start, end: addDays(start, 6) };
}

/** The last complete week or month before `today`. */
export function lastCompletePeriod(period: RecapPeriod, today: LocalDate, weekStartsOn: 0 | 1) {
  if (period === 'month')
    return periodRange(
      'month',
      firstDayOfMonth(addMonthsToMonth(monthOf(today), -1)),
      weekStartsOn,
    );
  const thisWeek = periodRange('week', today, weekStartsOn);
  return periodRange('week', addDays(thisWeek.start, -7), weekStartsOn);
}

function templateText(period: RecapPeriod, d: RecapData): string {
  const fmt = (v: number) => formatMoney(v, d.currency);
  const change =
    d.previousSpending === 0
      ? null
      : Math.round(((d.spending - d.previousSpending) / Math.abs(d.previousSpending)) * 100);
  const parts = [
    `You spent ${fmt(d.spending)} this ${period}${change === null ? '' : `, ${change >= 0 ? `${change}% more` : `${-change}% less`} than the ${period} before`}.`,
  ];
  if (d.income > 0) parts.push(`Income was ${fmt(d.income)}.`);
  if (d.topCategories[0]) {
    parts.push(
      `Most went to ${d.topCategories
        .slice(0, 3)
        .map((c) => `${c.name} (${fmt(c.amount)})`)
        .join(', ')}.`,
    );
  }
  if (d.largestTransactions[0])
    parts.push(
      `The largest charge was ${d.largestTransactions[0].name} at ${fmt(d.largestTransactions[0].amount)}.`,
    );
  return parts.join(' ');
}

/**
 * Weekly or monthly recap. The numbers come from summarizeSpending (the same
 * policy code as every report); the AI only writes the sentences. With AI off
 * a plain template writes them.
 */
export async function generateRecap(
  env: Env,
  period: RecapPeriod,
  range: { start: LocalDate; end: LocalDate },
  deps: AiDeps = {},
): Promise<Recap> {
  const db = env.DB;
  const settings = await getSettings(db);
  const currency = settings.primaryCurrency;
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  const prevStart =
    period === 'month'
      ? firstDayOfMonth(addMonthsToMonth(monthOf(range.start), -1))
      : addDays(range.start, -days);
  const prevEnd = addDays(range.start, -1);
  const [txns, categories, links, rates, recurring] = await Promise.all([
    selectAll(db, transactionsTable, 'date >= ? AND date <= ?', [prevStart, range.end]),
    selectAll(db, categoriesTable),
    selectAll(db, transferLinksTable),
    loadRates(db),
    selectAll(db, recurringTable),
  ]);
  const ctx = buildTreatmentContext(settings.moneyPolicies, categories, links);
  const now = summarizeSpending(txns, ctx, { from: range.start, to: range.end, currency, rates });
  const prev = summarizeSpending(txns, ctx, { from: prevStart, to: prevEnd, currency, rates });
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const largest = txns
    .filter(
      (t) =>
        t.date >= range.start &&
        t.date <= range.end &&
        reportTreatment(t, ctx).kind === 'spending' &&
        t.amount < 0 &&
        t.currency === currency,
    )
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 3);
  const data: RecapData = {
    currency,
    spending: now.spending,
    income: now.income,
    previousSpending: prev.spending,
    topCategories: Object.entries(now.byCategory)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([categoryId, amount]) => ({
        categoryId,
        name: names.get(categoryId) ?? 'Uncategorized',
        amount,
      })),
    largestTransactions: largest.map((t) => ({
      transactionId: t.id,
      name: t.name || t.rawName,
      amount: -t.amount,
    })),
    newRecurring: recurring.filter((r) => (r.priceHistory[0]?.date ?? '') >= range.start).length,
    transactionsCounted: now.counted,
  };
  let text = templateText(period, data);
  let provider: Recap['provider'] = 'template';
  const ai = tryGetAi(env, settings, deps);
  if (ai) {
    try {
      const reply = await ai.complete({
        system:
          'You write a short, friendly money recap for one person: 2 to 4 plain sentences, no headings, no lists, no advice unless something stands out. Use only the numbers given; amounts are already formatted.',
        prompt: `Period: ${period} ${range.start} to ${range.end}\nFacts: ${templateText(period, data)}${
          data.newRecurring ? ` ${data.newRecurring} new recurring charge(s) appeared.` : ''
        }`,
        maxTokens: 400,
      });
      if (reply.trim()) {
        text = reply.trim();
        provider = ai.provider;
      }
    } catch {
      // Keep the template text.
    }
  }
  const recap: Recap = {
    id: newId('rcp'),
    period,
    periodStart: range.start,
    periodEnd: range.end,
    text,
    data,
    provider,
    createdAt: nowIso(),
  };
  await db
    .prepare(
      'INSERT INTO recaps (id, period, period_start, period_end, text, data, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (period, period_start) DO UPDATE SET text = excluded.text, data = excluded.data, provider = excluded.provider, period_end = excluded.period_end, created_at = excluded.created_at',
    )
    .bind(
      recap.id,
      period,
      range.start,
      range.end,
      text,
      JSON.stringify(data),
      provider,
      recap.createdAt,
    )
    .run();
  const stored = await db
    .prepare('SELECT id FROM recaps WHERE period = ? AND period_start = ?')
    .bind(period, range.start)
    .first<{ id: string }>();
  return { ...recap, id: stored?.id ?? recap.id };
}

export async function listRecaps(db: D1Database, period?: RecapPeriod): Promise<Recap[]> {
  const res = await db
    .prepare(
      `SELECT * FROM recaps ${period ? 'WHERE period = ?' : ''} ORDER BY period_start DESC LIMIT 60`,
    )
    .bind(...(period ? [period] : []))
    .all<Record<string, string>>();
  return res.results.map((r) => ({
    id: r.id!,
    period: r.period as RecapPeriod,
    periodStart: r.period_start!,
    periodEnd: r.period_end!,
    text: r.text!,
    data: JSON.parse(r.data!) as RecapData,
    provider: r.provider as Recap['provider'],
    createdAt: r.created_at!,
  }));
}
