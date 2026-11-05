import {
  addDays,
  daysBetween,
  normalizeDescription,
  type AiJobResponse,
  type Transaction,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { batchInChunks, selectAll } from '../../db/table';
import { transactionsTable } from '../../db/tables';
import { newId, nowIso } from '../../util/ids';
import { merchantKey } from '../merchant';

export interface AlertProposal {
  type: 'duplicate' | 'unusual';
  transaction: Transaction;
  message: string;
}

/**
 * Possible duplicates (same account, amount and description within a day,
 * neither with a provider id that tells them apart) and unusual charges (more
 * than 3x the merchant's usual amount with at least three earlier charges).
 * Duplicates are never merged automatically: two identical coffees can be real.
 */
export function findAlerts(
  recent: readonly Transaction[],
  history: readonly Transaction[],
): AlertProposal[] {
  const out: AlertProposal[] = [];
  const usable = (t: Transaction) =>
    !t.isSplitParent && !t.transferLinkId && t.amount < 0 && !t.excluded;
  const sorted = recent
    .filter(usable)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (daysBetween(a.date, b.date) > 1) break;
      if (a.accountId !== b.accountId || a.amount !== b.amount) continue;
      if (normalizeDescription(a.rawName) !== normalizeDescription(b.rawName)) continue;
      if (
        a.externalId &&
        b.externalId &&
        a.source === 'connector' &&
        b.source === 'connector' &&
        a.pendingExternalId !== b.externalId &&
        b.pendingExternalId !== a.externalId
      ) {
        // Two posted rows with different provider ids: the bank says they are separate.
        continue;
      }
      out.push({
        type: 'duplicate',
        transaction: b,
        message: `${b.name || b.rawName} was charged twice (${(Math.abs(b.amount) / 100).toFixed(2)} ${b.currency}). Check whether both are real.`,
      });
    }
  }
  const byMerchant = new Map<string, number[]>();
  for (const t of history.filter(usable)) {
    const key = `${t.currency}|${merchantKey(t.rawName)}`;
    byMerchant.set(key, [...(byMerchant.get(key) ?? []), Math.abs(t.amount)]);
  }
  for (const t of sorted) {
    const others = byMerchant.get(`${t.currency}|${merchantKey(t.rawName)}`) ?? [];
    if (others.length < 3) continue;
    const typical = [...others].sort((x, y) => x - y)[Math.floor(others.length / 2)]!;
    if (Math.abs(t.amount) > typical * 3 && Math.abs(t.amount) - typical >= 2_000) {
      out.push({
        type: 'unusual',
        transaction: t,
        message: `${t.name || t.rawName} is ${(Math.abs(t.amount) / 100).toFixed(2)} ${t.currency}, about ${Math.round(Math.abs(t.amount) / typical)}x the usual ${(typical / 100).toFixed(2)}.`,
      });
    }
  }
  return out;
}

export async function runAlerts(
  env: Env,
  today = new Date().toISOString().slice(0, 10),
): Promise<AiJobResponse> {
  const db = env.DB;
  const recent = await selectAll(db, transactionsTable, 'date >= ?', [addDays(today, -30)]);
  const history = await selectAll(db, transactionsTable, 'date >= ? AND date < ?', [
    addDays(today, -400),
    addDays(today, -30),
  ]);
  const proposals = findAlerts(recent, history);
  const now = nowIso();
  await batchInChunks(
    db,
    proposals.map((p) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO alerts (id, type, transaction_id, recurring_id, message, amount, currency, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
        )
        .bind(
          newId('alr'),
          p.type,
          p.transaction.id,
          p.message,
          Math.abs(p.transaction.amount),
          p.transaction.currency,
          now,
        ),
    ),
  );
  return { job: 'alerts', changed: proposals.length, usedAi: false, note: null };
}
