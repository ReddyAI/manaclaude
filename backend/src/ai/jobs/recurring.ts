import {
  addDays,
  daysBetween,
  type AiJobResponse,
  type RecurringFrequency,
  type RecurringItem,
  type Transaction,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { batchInChunks, insertStatement, selectAll } from '../../db/table';
import { recurringTable, transactionsTable } from '../../db/tables';
import { newId, nowIso } from '../../util/ids';
import { cleanMerchantName, merchantKey } from '../merchant';

const FREQUENCIES: { frequency: RecurringFrequency; days: number; tolerance: number }[] = [
  { frequency: 'weekly', days: 7, tolerance: 1 },
  { frequency: 'biweekly', days: 14, tolerance: 2 },
  { frequency: 'monthly', days: 30.4, tolerance: 4 },
  { frequency: 'quarterly', days: 91, tolerance: 7 },
  { frequency: 'semiannual', days: 182, tolerance: 10 },
  { frequency: 'annual', days: 365, tolerance: 12 },
];

/** Price changes of at least this much raise an alert. */
export const PRICE_CHANGE_THRESHOLD = 0.01;

export interface RecurringCandidate {
  key: string;
  name: string;
  frequency: RecurringFrequency;
  history: Transaction[];
  isVariable: boolean;
  confidence: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Finds series of charges (or paychecks) from the same merchant at a steady
 * interval: at least three occurrences, intervals within tolerance of a known
 * frequency, amounts within 25% of the median. Pure, so it is easy to test.
 */
export function detectRecurringSeries(txns: readonly Transaction[]): RecurringCandidate[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of txns) {
    if (t.isSplitParent || t.transferLinkId || t.pending || t.amount === 0) continue;
    const key = `${t.accountId}|${merchantKey(t.rawName)}|${Math.sign(t.amount)}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: RecurringCandidate[] = [];
  for (const [key, list] of groups) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = sorted.slice(1).map((t, i) => daysBetween(sorted[i]!.date, t.date));
    const gap = median(gaps);
    const freq = FREQUENCIES.find((f) => Math.abs(gap - f.days) <= f.tolerance);
    if (!freq) continue;
    const steady = gaps.filter((g) => Math.abs(g - freq.days) <= freq.tolerance * 2).length / gaps.length;
    if (steady < 0.75) continue;
    const amounts = sorted.map((t) => Math.abs(t.amount));
    const mid = median(amounts);
    if (!amounts.every((a) => Math.abs(a - mid) / mid <= 0.25)) continue;
    const isVariable = amounts.some((a) => Math.abs(a - mid) / mid > 0.05);
    out.push({
      key,
      name: cleanMerchantName(sorted[sorted.length - 1]!.rawName),
      frequency: freq.frequency,
      history: sorted,
      isVariable,
      confidence: Math.min(0.99, 0.5 + sorted.length * 0.08 + steady * 0.2 - (isVariable ? 0.1 : 0)),
    });
  }
  return out;
}

function nextDue(last: string, f: RecurringFrequency): string {
  const days = FREQUENCIES.find((x) => x.frequency === f)!.days;
  return addDays(last, Math.round(days));
}

/**
 * Recurring detection with price-change alerts. New series are saved with
 * detectedBy "rule" (heuristics, no AI needed); existing series get their
 * price history updated, and a non-variable series whose newest charge is at
 * least 1% above the previous one raises a price_increase alert.
 */
export async function runRecurringDetection(env: Env): Promise<AiJobResponse> {
  const db = env.DB;
  const since = addDays(new Date().toISOString().slice(0, 10), -800);
  const [txns, existing] = await Promise.all([
    selectAll(db, transactionsTable, 'date >= ?', [since]),
    selectAll(db, recurringTable),
  ]);
  const series = detectRecurringSeries(txns);
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  let changed = 0;
  for (const s of series) {
    const last = s.history[s.history.length - 1]!;
    const prev = s.history[s.history.length - 2]!;
    const current = existing.find(
      (r) => r.accountId === last.accountId && merchantKey(r.name) === merchantKey(s.name) && Math.sign(r.expectedAmount) === Math.sign(last.amount),
    );
    const item: RecurringItem = {
      id: current?.id ?? newId('rec'),
      name: current?.name ?? s.name,
      merchantId: last.merchantId,
      categoryId: current?.categoryId ?? last.categoryId,
      accountId: last.accountId,
      kind: current?.kind ?? (last.amount > 0 ? 'income' : /subscri|netflix|spotify|prime|icloud|youtube|hulu|disney/i.test(s.name) ? 'subscription' : 'bill'),
      frequency: s.frequency,
      expectedAmount: last.amount,
      currency: last.currency,
      isVariable: s.isVariable,
      lastDate: last.date,
      nextDueDate: nextDue(last.date, s.frequency),
      status: current?.status ?? 'active',
      decision: current?.decision ?? null,
      priceHistory: s.history.map((t) => ({ date: t.date, amount: t.amount })),
      detectedBy: current?.detectedBy ?? 'rule',
      aiConfidence: Math.round(s.confidence * 100) / 100,
    };
    if (!current || JSON.stringify(current) !== JSON.stringify(item)) {
      statements.push(insertStatement(db, recurringTable, item, 'upsert'));
      changed += 1;
    }
    statements.push(
      ...s.history.map((t) =>
        db.prepare('UPDATE transactions SET recurring_id = ? WHERE id = ? AND recurring_id IS NULL').bind(item.id, t.id),
      ),
    );
    const increase = (Math.abs(last.amount) - Math.abs(prev.amount)) / Math.abs(prev.amount);
    if (!s.isVariable || increase >= 0.05) {
      if (last.amount < 0 && increase >= PRICE_CHANGE_THRESHOLD) {
        const message = `${item.name} went up from ${(Math.abs(prev.amount) / 100).toFixed(2)} to ${(Math.abs(last.amount) / 100).toFixed(2)} ${last.currency}.`;
        statements.push(
          db
            .prepare(
              'INSERT OR IGNORE INTO alerts (id, type, transaction_id, recurring_id, message, amount, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(newId('alr'), 'price_increase', last.id, item.id, message, Math.abs(last.amount) - Math.abs(prev.amount), last.currency, now),
        );
      }
    }
  }
  await batchInChunks(db, statements);
  return { job: 'recurring', changed, usedAi: false, note: null };
}
