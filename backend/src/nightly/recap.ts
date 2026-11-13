import {
  addDays,
  addMonthsToMonth,
  buildTreatmentContext,
  classifyAccountType,
  convertAmount,
  firstDayOfMonth,
  monthOf,
  reportTreatment,
  summarizeSpending,
  type Recap,
  type Settings,
} from '@manaclaude/shared';
import { finishRecap, lastCompletePeriod } from '../ai/jobs/recap';
import type { AiDeps } from '../ai/provider';
import {
  accountsTable,
  balanceSnapshotsTable,
  categoriesTable,
  recurringTable,
  transactionsTable,
  transferLinksTable,
} from '../db/tables';
import { fromRow } from '../db/table';
import type { Env } from '../env';
import { byIds, page, SCAN_PAGE } from './store';
import { ratesFor } from './rates';

export interface RecapCursor {
  kind: Recap['kind'];
  range: { start: string; end: string };
  prevStart: string;
  phase: 'transactions' | 'categories' | 'accounts' | 'recurring' | 'finish' | 'clear';
  after: string;
  income: number;
  spending: number;
  previous: number;
  biggest: { transactionId: string; amount: number; name: string }[];
  top: Recap['topCategories'];
  worthStart: number;
  worthEnd: number;
  hasStart: boolean;
  hasEnd: boolean;
  newRecurring: number;
  settings: Settings;
}
export function startRecap(kind: Recap['kind'], today: string, settings: Settings): RecapCursor {
  const range = lastCompletePeriod(kind, today, settings.weekStartsOn);
  const prevStart =
    kind === 'monthly'
      ? firstDayOfMonth(addMonthsToMonth(monthOf(range.start), -1))
      : addDays(range.start, -7);
  return {
    kind,
    range,
    prevStart,
    phase: 'transactions',
    after: '',
    income: 0,
    spending: 0,
    previous: 0,
    biggest: [],
    top: [],
    worthStart: 0,
    worthEnd: 0,
    hasStart: false,
    hasEnd: false,
    newRecurring: 0,
    settings,
  };
}

export async function recapStep(env: Env, c: RecapCursor, deps: AiDeps) {
  const db = env.DB;
  const writes: D1PreparedStatement[] = [];
  const currency = c.settings.primaryCurrency;
  const next = (phase: RecapCursor['phase']) => {
    c.phase = phase;
    c.after = '';
  };
  if (c.phase === 'transactions') {
    // IDs are immutable: a date edit between pages cannot count one row twice.
    const scanned = await page(db, transactionsTable, c.after);
    const txns = scanned.filter((t) => t.date >= c.prevStart && t.date <= c.range.end);
    const categories = await byIds(
      db,
      categoriesTable,
      txns.map((t) => t.categoryId),
    );
    const links = await byIds(
      db,
      transferLinksTable,
      txns.map((t) => t.transferLinkId),
    );
    const rates = await ratesFor(
      db,
      txns.map((t) => ({ from: t.currency, to: currency, date: t.date })),
    );
    // Floors apply after all pages have been summed per category.
    const context = buildTreatmentContext(
      { ...c.settings.moneyPolicies, categoryFloor: 'none' },
      categories,
      links,
    );
    const now = summarizeSpending(txns, context, {
      from: c.range.start,
      to: c.range.end,
      currency,
      rates,
    });
    const prev = summarizeSpending(txns, context, {
      from: c.prevStart,
      to: addDays(c.range.start, -1),
      currency,
      rates,
    });
    c.income += now.income;
    const ids = new Set([...Object.keys(now.byCategory), ...Object.keys(prev.byCategory)]);
    if (ids.size)
      writes.push(
        db
          .prepare(
            `INSERT INTO nightly_categories (id, current, previous)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE true
      ON CONFLICT(id) DO UPDATE SET current = current + excluded.current, previous = previous + excluded.previous`,
          )
          .bind(
            JSON.stringify(
              [...ids].map((id) => [id, now.byCategory[id] ?? 0, prev.byCategory[id] ?? 0]),
            ),
          ),
      );
    for (const t of txns)
      if (
        t.date >= c.range.start &&
        t.amount < 0 &&
        reportTreatment(t, context).kind === 'spending'
      ) {
        c.biggest.push({
          transactionId: t.id,
          name: t.name || t.rawName,
          amount: -(
            convertAmount(t.amount, t.currency, currency, rates, { mode: 'on', date: t.date }) ?? 0
          ),
        });
      }
    c.biggest.sort((a, b) => b.amount - a.amount || a.transactionId.localeCompare(b.transactionId));
    c.biggest = c.biggest.slice(0, 3);
    const last = scanned.at(-1);
    if (last) {
      c.after = last.id;
    } else next('categories');
  } else if (c.phase === 'categories') {
    const rows = await db
      .prepare('SELECT * FROM nightly_categories WHERE id > ? ORDER BY id LIMIT ?')
      .bind(c.after, SCAN_PAGE)
      .all<{ id: string; current: number; previous: number }>();
    for (const r of rows.results) {
      const amount =
        c.settings.moneyPolicies.categoryFloor === 'zero' ? Math.max(0, r.current) : r.current;
      const previous =
        c.settings.moneyPolicies.categoryFloor === 'zero' ? Math.max(0, r.previous) : r.previous;
      c.spending += amount;
      c.previous += previous;
      if (amount > 0) c.top.push({ categoryId: r.id, amount, previous });
    }
    c.top.sort((a, b) => b.amount - a.amount || a.categoryId.localeCompare(b.categoryId));
    c.top = c.top.slice(0, 5);
    const last = rows.results.at(-1);
    if (last) c.after = last.id;
    else next('accounts');
  } else if (c.phase === 'accounts') {
    const accounts = await page(db, accountsTable, c.after);
    const dates = [addDays(c.range.start, -1), c.range.end];
    const input = accounts.flatMap((a) => dates.map((date) => [a.id, date]));
    const rows = await db
      .prepare(
        `SELECT j.value AS request, s.* FROM json_each(?) j JOIN balance_snapshots s ON s.rowid = (
      SELECT rowid FROM balance_snapshots WHERE account_id = json_extract(j.value, '$[0]') AND date <= json_extract(j.value, '$[1]')
      ORDER BY date DESC LIMIT 1)`,
      )
      .bind(JSON.stringify(input))
      .all<Record<string, unknown>>();
    const rates = await ratesFor(
      db,
      rows.results.map((r) => ({ from: String(r.currency), to: currency, date: '9999-12-31' })),
    );
    for (const row of rows.results) {
      const s = fromRow(balanceSnapshotsTable, row);
      const date = (JSON.parse(String(row.request)) as string[])[1];
      const start = date === dates[0];
      if (start) c.hasStart = true;
      else c.hasEnd = true;
      const a = accounts.find((a) => a.id === s.accountId)!;
      if (!a.includeInNetWorth) continue;
      const amount = convertAmount(s.balance, s.currency, currency, rates, { mode: 'latest' }) ?? 0;
      const value = classifyAccountType(a.type) === 'liability' ? -amount : amount;
      if (start) c.worthStart += value;
      else c.worthEnd += value;
    }
    const last = accounts.at(-1);
    if (last) c.after = last.id;
    else next('recurring');
  } else if (c.phase === 'recurring') {
    const items = await page(db, recurringTable, c.after, SCAN_PAGE);
    c.newRecurring += items.filter((r) => {
      const date = r.priceHistory[0]?.date ?? '';
      return date >= c.range.start && date <= c.range.end;
    }).length;
    const last = items.at(-1);
    if (last) c.after = last.id;
    else next('finish');
  } else if (c.phase === 'finish') {
    const categories = await byIds(
      db,
      categoriesTable,
      c.top.map((t) => t.categoryId),
    );
    await finishRecap(
      env,
      {
        kind: c.kind,
        range: c.range,
        facts: {
          currency,
          spending: c.spending,
          income: c.income,
          previousSpending: c.previous,
          top: c.top.map((t) => ({
            name: categories.find((cat) => cat.id === t.categoryId)?.name ?? 'Uncategorized',
            amount: t.amount,
          })),
          biggest: c.biggest[0] ?? null,
          newRecurring: c.newRecurring,
        },
        topCategories: c.top,
        biggestTransactions: c.biggest.map(({ transactionId, amount }) => ({
          transactionId,
          amount,
        })),
        netWorthChange: c.hasStart && c.hasEnd ? c.worthEnd - c.worthStart : null,
      },
      deps,
      (statement) => writes.push(statement),
    );
    next('clear');
  } else {
    const rows = await db
      .prepare('SELECT id FROM nightly_categories ORDER BY id LIMIT ?')
      .bind(SCAN_PAGE)
      .all<{ id: string }>();
    if (!rows.results.length) return { done: true, writes };
    writes.push(
      db
        .prepare('DELETE FROM nightly_categories WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(rows.results.map((r) => r.id))),
    );
  }
  return { done: false, writes };
}
