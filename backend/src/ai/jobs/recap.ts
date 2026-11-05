import {
  addDays,
  addMonthsToMonth,
  buildTreatmentContext,
  classifyAccountType,
  convertAmount,
  firstDayOfMonth,
  formatMoney,
  lastDayOfMonth,
  monthOf,
  reportTreatment,
  summarizeSpending,
  type Account,
  type BalanceSnapshot,
  type FxRate,
  type LocalDate,
  type Recap,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { selectAll } from '../../db/table';
import {
  accountsTable,
  balanceSnapshotsTable,
  categoriesTable,
  recurringTable,
  transactionsTable,
  transferLinksTable,
} from '../../db/tables';
import { loadRates } from '../../fx/service';
import { newId, nowIso } from '../../util/ids';
import { getSettings } from '../../services/settings';
import { completeJson, tryGetAi, type AiDeps, type JsonSchema } from '../provider';

export function periodRange(
  period: Recap['kind'],
  anchor: LocalDate,
  weekStartsOn: 0 | 1,
): { start: LocalDate; end: LocalDate } {
  if (period === 'monthly') {
    const m = monthOf(anchor);
    return { start: firstDayOfMonth(m), end: lastDayOfMonth(m) };
  }
  const dow = new Date(`${anchor}T00:00:00Z`).getUTCDay();
  const back = (dow - weekStartsOn + 7) % 7;
  const start = addDays(anchor, -back);
  return { start, end: addDays(start, 6) };
}

/** The last complete week or month before `today`. */
export function lastCompletePeriod(period: Recap['kind'], today: LocalDate, weekStartsOn: 0 | 1) {
  if (period === 'monthly')
    return periodRange(
      'monthly',
      firstDayOfMonth(addMonthsToMonth(monthOf(today), -1)),
      weekStartsOn,
    );
  const thisWeek = periodRange('weekly', today, weekStartsOn);
  return periodRange('weekly', addDays(thisWeek.start, -7), weekStartsOn);
}

interface RecapFacts {
  currency: string;
  spending: number;
  income: number;
  previousSpending: number;
  top: { name: string; amount: number }[];
  biggest: { name: string; amount: number } | null;
  newRecurring: number;
}

function templateSentences(kind: Recap['kind'], d: RecapFacts): string[] {
  const fmt = (v: number) => formatMoney(v, d.currency);
  const word = kind === 'weekly' ? 'week' : 'month';
  const change =
    d.previousSpending === 0
      ? null
      : Math.round(((d.spending - d.previousSpending) / Math.abs(d.previousSpending)) * 100);
  const out = [
    `You spent ${fmt(d.spending)} this ${word}${change === null ? '' : `, ${change >= 0 ? `${change}% more` : `${-change}% less`} than the ${word} before`}.`,
  ];
  if (d.income > 0) out.push(`Income was ${fmt(d.income)}.`);
  if (d.top[0]) {
    out.push(
      `Most went to ${d.top
        .slice(0, 3)
        .map((c) => `${c.name} (${fmt(c.amount)})`)
        .join(', ')}.`,
    );
  }
  if (d.biggest) out.push(`The largest charge was ${d.biggest.name} at ${fmt(d.biggest.amount)}.`);
  if (d.newRecurring > 0)
    out.push(`${d.newRecurring} new recurring charge${d.newRecurring === 1 ? '' : 's'} showed up.`);
  return out;
}

function netWorthOn(
  accounts: readonly Account[],
  snaps: readonly BalanceSnapshot[],
  rates: readonly FxRate[],
  currency: string,
  date: LocalDate,
): number | null {
  const latest = new Map<string, BalanceSnapshot>();
  for (const s of snaps) {
    if (s.date > date) continue;
    const prev = latest.get(s.accountId);
    if (!prev || prev.date < s.date) latest.set(s.accountId, s);
  }
  if (latest.size === 0) return null;
  let total = 0;
  for (const a of accounts) {
    const s = latest.get(a.id);
    if (!s || !a.includeInNetWorth) continue;
    const v = convertAmount(s.balance, s.currency, currency, rates, { mode: 'latest' });
    if (v === null) continue;
    total += classifyAccountType(a.type) === 'liability' ? -v : v;
  }
  return total;
}

/**
 * Weekly recap or Month in Review, in the shared Recap shape (session C's
 * screens read it). The numbers come from summarizeSpending, the same policy
 * code as every report; the AI only writes the headline and highlights from
 * those numbers. With AI off a plain template writes them (source "local").
 */
export async function generateRecap(
  env: Env,
  kind: Recap['kind'],
  range: { start: LocalDate; end: LocalDate },
  deps: AiDeps = {},
): Promise<Recap> {
  const db = env.DB;
  const settings = await getSettings(db);
  const currency = settings.primaryCurrency;
  const days = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
  const prevStart =
    kind === 'monthly'
      ? firstDayOfMonth(addMonthsToMonth(monthOf(range.start), -1))
      : addDays(range.start, -days);
  const prevEnd =
    kind === 'monthly' ? lastDayOfMonth(monthOf(prevStart)) : addDays(range.start, -1);
  const [txns, categories, links, rates, recurring, accounts, snaps] = await Promise.all([
    selectAll(db, transactionsTable, 'date >= ? AND date <= ?', [prevStart, range.end]),
    selectAll(db, categoriesTable),
    selectAll(db, transferLinksTable),
    loadRates(db),
    selectAll(db, recurringTable),
    selectAll(db, accountsTable),
    selectAll(db, balanceSnapshotsTable),
  ]);
  const ctx = buildTreatmentContext(settings.moneyPolicies, categories, links);
  const now = summarizeSpending(txns, ctx, { from: range.start, to: range.end, currency, rates });
  const prev = summarizeSpending(txns, ctx, { from: prevStart, to: prevEnd, currency, rates });
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const biggest = txns
    .filter(
      (t) =>
        t.date >= range.start &&
        t.date <= range.end &&
        t.amount < 0 &&
        reportTreatment(t, ctx).kind === 'spending',
    )
    .map((t) => ({
      t,
      amount: -(
        convertAmount(t.amount, t.currency, currency, rates, { mode: 'on', date: t.date }) ?? 0
      ),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const topCategories = Object.entries(now.byCategory)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([categoryId, amount]) => ({
      categoryId,
      amount,
      previous: prev.byCategory[categoryId] ?? 0,
    }));
  const facts: RecapFacts = {
    currency,
    spending: now.spending,
    income: now.income,
    previousSpending: prev.spending,
    top: topCategories.map((c) => ({
      name: names.get(c.categoryId) ?? 'Uncategorized',
      amount: c.amount,
    })),
    biggest: biggest[0]
      ? { name: biggest[0].t.name || biggest[0].t.rawName, amount: biggest[0].amount }
      : null,
    newRecurring: recurring.filter((r) => {
      const first = r.priceHistory[0]?.date ?? '';
      return first >= range.start && first <= range.end;
    }).length,
  };
  const startWorth = netWorthOn(accounts, snaps, rates, currency, addDays(range.start, -1));
  const endWorth = netWorthOn(accounts, snaps, rates, currency, range.end);
  const sentences = templateSentences(kind, facts);
  let headline = sentences[0]!;
  let highlights = sentences.slice(1);
  let source: Recap['source'] = 'local';
  const ai = tryGetAi(env, settings, deps);
  if (ai) {
    try {
      const reply = await completeJson<{ headline: string; highlights: string[] }>(ai, {
        system:
          'You write a short, friendly money recap for one person. Use only the facts given; amounts are already formatted. No advice unless something stands out. Return JSON only.',
        prompt: `Period: ${kind} ${range.start} to ${range.end}\nFacts:\n${sentences.map((x) => `- ${x}`).join('\n')}\n\nWrite a one-line headline and two to four short highlight sentences.`,
        schema: RECAP_SCHEMA,
        maxTokens: 600,
      });
      if (reply.headline?.trim()) {
        headline = reply.headline.trim();
        highlights = (reply.highlights ?? [])
          .map((h) => String(h).trim())
          .filter(Boolean)
          .slice(0, 5);
        source = 'ai';
      }
    } catch {
      // Keep the template text.
    }
  }
  const existing = await db
    .prepare('SELECT id FROM recaps WHERE kind = ? AND period_start = ?')
    .bind(kind, range.start)
    .first<{ id: string }>();
  const recap: Recap = {
    id: existing?.id ?? newId('rcp'),
    kind,
    periodStart: range.start,
    periodEnd: range.end,
    currency,
    spending: now.spending,
    income: now.income,
    previousSpending: prev.spending,
    topCategories,
    biggestTransactions: biggest.map((b) => ({ transactionId: b.t.id, amount: b.amount })),
    netWorthChange: startWorth === null || endWorth === null ? null : endWorth - startWorth,
    headline,
    highlights,
    source,
    createdAt: nowIso(),
  };
  await db
    .prepare(
      'INSERT INTO recaps (id, kind, period_start, period_end, data, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, period_start) DO UPDATE SET data = excluded.data, period_end = excluded.period_end, created_at = excluded.created_at',
    )
    .bind(recap.id, kind, range.start, range.end, JSON.stringify(recap), recap.createdAt)
    .run();
  return recap;
}

const RECAP_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'highlights'],
};

export async function listRecaps(db: D1Database, kind?: Recap['kind']): Promise<Recap[]> {
  const res = await db
    .prepare(
      `SELECT data FROM recaps ${kind ? 'WHERE kind = ?' : ''} ORDER BY period_start DESC LIMIT 60`,
    )
    .bind(...(kind ? [kind] : []))
    .all<{ data: string }>();
  return res.results.map((r) => JSON.parse(r.data) as Recap);
}
