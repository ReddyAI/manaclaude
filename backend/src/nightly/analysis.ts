import { addDays, type Transaction } from '@manaclaude/shared';
import { findAlerts } from '../ai/jobs/alerts';
import { cleanMerchantName } from '../ai/merchant';
import { runRecurringDetection } from '../ai/jobs/recurring';
import { recurringTable, transactionsTable } from '../db/tables';
import { newId } from '../util/ids';
import type { Env } from '../env';
import { alertKey, duplicateKey, recurringKey, recurringNameKey } from './transactions';
import { byIds, named, nameWrites, page, SCAN_PAGE, unchanged } from './store';

export async function indexPage(env: Env, after: string, today: string) {
  const transactions = await page(env.DB, transactionsTable, after, SCAN_PAGE);
  const usable = transactions.filter((t) => t.date >= addDays(today, -800) && t.date <= today);
  const alertUsable = (t: Transaction) =>
    !t.isSplitParent && !t.transferLinkId && t.amount < 0 && !t.excluded;
  const rows = usable.map((t) => [
    t.id,
    recurringKey(t),
    alertKey(t),
    duplicateKey(t),
    t.date,
    Math.abs(t.amount),
    JSON.stringify(t),
    Number(alertUsable(t) && t.date >= addDays(today, -400) && t.date < addDays(today, -30)),
    Number(alertUsable(t) && t.date >= addDays(today, -30)),
    Number(!t.isSplitParent && !t.transferLinkId && !t.pending && t.amount !== 0),
  ]);
  const writes: D1PreparedStatement[] = [];
  if (rows.length)
    writes.push(
      env.DB.prepare(
        `INSERT INTO nightly_rows
    (id, recurring_key, alert_key, duplicate_key, date, amount, data, history, recent, recurring_usable)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
      json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'),
      json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]')
    FROM json_each(?)`,
      ).bind(JSON.stringify(rows)),
    );
  const counts = new Map<string, number>();
  for (const t of usable) {
    if (
      t.isSplitParent ||
      t.transferLinkId ||
      t.amount >= 0 ||
      t.excluded ||
      t.date < addDays(today, -400)
    )
      continue;
    const key = alertKey(t);
    counts.set(key, (counts.get(key) ?? 0) + Number(t.date < addDays(today, -30)));
  }
  if (counts.size)
    writes.push(
      env.DB.prepare(
        `INSERT INTO nightly_groups (key, history_count)
    SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true
    ON CONFLICT(key) DO UPDATE SET history_count = history_count + excluded.history_count`,
      ).bind(JSON.stringify([...counts])),
    );
  return { transactions, writes };
}

export async function recurringStep(env: Env, after: string, today: string) {
  const key = await env.DB.prepare(
    'SELECT recurring_key FROM nightly_rows WHERE recurring_key > ? ORDER BY recurring_key LIMIT 1',
  )
    .bind(after)
    .first<string>('recurring_key');
  const writes: D1PreparedStatement[] = [];
  if (!key) return { key, writes, transactions: [] };
  // In an 800-day window a qualifying series has at most 214 gaps: >=75%
  // must be >=5 days (weekly's widest tolerance). 216 usable rows therefore
  // proves the group cannot pass detectRecurringSeries. Never accept a prefix.
  const rows = await env.DB.prepare(
    `SELECT data FROM nightly_rows WHERE recurring_key = ?
    AND recurring_usable = 1
    ORDER BY date, id LIMIT 216`,
  )
    .bind(key)
    .all<{ data: string }>();
  if (rows.results.length === 216) return { key, writes, transactions: [] };
  const snapshot = rows.results.map((r) => JSON.parse(r.data) as Transaction);
  const transactions = await byIds(
    env.DB,
    transactionsTable,
    snapshot.map((t) => t.id),
  );
  // Changed/deleted records are picked up by the next sweep, not used as stale evidence.
  const snapshots = new Map(snapshot.map((t) => [t.id, JSON.stringify(t)]));
  if (
    transactions.length !== snapshot.length ||
    transactions.some((t) => JSON.stringify(t) !== snapshots.get(t.id) || t.date > today)
  ) {
    return { key, writes, transactions: [] };
  }
  const t = transactions[0];
  const existing = t
    ? await named(env.DB, recurringTable, 'recurring', [
        recurringNameKey(t.accountId, cleanMerchantName(t.rawName), t.amount),
      ])
    : [];
  if (existing.length) writes.push(unchanged(env.DB, recurringTable, existing));
  await runRecurringDetection(env, {
    transactions,
    existing,
    touched: (r) =>
      writes.push(
        ...nameWrites(env.DB, 'recurring', [
          { id: r.id, key: recurringNameKey(r.accountId ?? '', r.name, r.expectedAmount) },
        ]),
      ),
    save: async (statements) => {
      writes.push(...statements);
    },
  });
  return { key, writes, transactions };
}

export interface AlertCursor {
  key: string;
  count: number;
  seen: number;
  amount: number;
  id: string;
  typical?: number;
  recentAfter?: string;
}

export async function alertStep(
  env: Env,
  after: string,
  cursor: AlertCursor | null,
  today: string,
) {
  const writes: D1PreparedStatement[] = [];
  if (!cursor) {
    const next = await env.DB.prepare(
      'SELECT key, history_count FROM nightly_groups WHERE key > ? ORDER BY key LIMIT 1',
    )
      .bind(after)
      .first<{ key: string; history_count: number }>();
    if (!next) return { after, cursor: null, done: true, writes };
    cursor = { key: next.key, count: next.history_count, seen: 0, amount: -1, id: '' };
    if (cursor.count < 3) cursor.typical = 0;
  }
  if (cursor.typical === undefined) {
    const history = await env.DB.prepare(
      `SELECT amount, id FROM nightly_rows
      WHERE alert_key = ? AND history = 1 AND (amount, id) > (?, ?)
      ORDER BY amount, id LIMIT ?`,
    )
      .bind(cursor.key, cursor.amount, cursor.id, SCAN_PAGE)
      .all<{ amount: number; id: string }>();
    const middle = Math.floor(cursor.count / 2) - cursor.seen;
    const median = history.results[middle];
    if (median) cursor.typical = median.amount;
    cursor.seen += history.results.length;
    const last = history.results.at(-1);
    if (last) {
      cursor.amount = last.amount;
      cursor.id = last.id;
    }
    if (!last && cursor.typical === undefined)
      throw new Error('Nightly alert history is incomplete');
    return { after, cursor, done: false, writes };
  }
  const recent = await env.DB.prepare(
    `SELECT data FROM nightly_rows WHERE alert_key = ? AND recent = 1 AND id > ?
    ORDER BY id LIMIT 4`,
  )
    .bind(cursor.key, cursor.recentAfter ?? '')
    .all<{ data: string }>();
  for (const row of recent.results) {
    const t = JSON.parse(row.data) as Transaction;
    if (t.isSplitParent || t.transferLinkId || t.amount >= 0 || t.excluded) continue;
    // Separate indexed seeks avoid scanning thousands of distinct provider IDs
    // when the bank says those charges are separate. At most three predecessors.
    const identified = t.source === 'connector' && Boolean(t.externalId);
    const conditions: { sql: string; params: string[] }[] = identified
      ? [
          {
            sql: "AND (json_extract(data, '$.source') = 'connector' AND COALESCE(json_extract(data, '$.externalId'), '') != '') = 0",
            params: [],
          },
          { sql: "AND json_extract(data, '$.pendingExternalId') = ?", params: [t.externalId!] },
          ...(t.pendingExternalId
            ? [{ sql: "AND json_extract(data, '$.externalId') = ?", params: [t.pendingExternalId] }]
            : []),
        ]
      : [{ sql: '', params: [] }];
    let neighbor: { data: string } | null = null;
    for (const condition of conditions) {
      neighbor = await env.DB.prepare(
        `SELECT data FROM nightly_rows WHERE duplicate_key = ? AND recent = 1
        ${condition.sql} AND date >= ?
        AND (date, json_extract(data, '$.createdAt'), id) < (?, ?, ?)
        ORDER BY date, json_extract(data, '$.createdAt'), id LIMIT 1`,
      )
        .bind(duplicateKey(t), ...condition.params, addDays(t.date, -1), t.date, t.createdAt, t.id)
        .first<{ data: string }>();
      if (neighbor) break;
    }
    // Reuse the same thresholds/message wording with a bounded synthetic median sample.
    const typical = cursor.typical;
    const history = typical ? Array.from({ length: 3 }, () => ({ ...t, amount: -typical })) : [];
    const proposals = findAlerts([t], history);
    if (neighbor) {
      const a = JSON.parse(neighbor.data) as Transaction;
      proposals.push(
        ...findAlerts([a, t], []).filter(
          (p) => p.type === 'duplicate' && p.transaction.id === t.id,
        ),
      );
    }
    for (const p of proposals)
      writes.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO alerts
      (id, type, transaction_id, recurring_id, message, amount, currency, created_at)
      SELECT ?, ?, ?, NULL, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM transactions WHERE id = ? AND updated_at = ?)`,
        ).bind(
          newId('alr'),
          p.type,
          t.id,
          p.message,
          Math.abs(t.amount),
          t.currency,
          `${today}T06:30:00.000Z`,
          t.id,
          t.updatedAt,
        ),
      );
  }
  const last = recent.results.at(-1);
  if (last) cursor.recentAfter = (JSON.parse(last.data) as Transaction).id;
  else {
    after = cursor.key;
    cursor = null;
  }
  return { after, cursor, done: false, writes };
}
