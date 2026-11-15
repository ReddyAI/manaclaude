import type { Account, Transaction } from '@manaclaude/shared';
import { z } from 'zod';
import { bulkInsertSpecs, bulkUpdateSpecs, type StatementSpec } from '../db/bulk';
import { defineTable, selectAll } from '../db/table';
import { accountsTable, transactionsTable } from '../db/tables';
import { conflict, notFound } from '../util/errors';
import { bankOwns, monefyCandidates } from './model';
import { historyGuards, historySnapshot, readPolicy, tokenFor, writeHistory } from './store';

export interface BankReview {
  id: string;
  accountId: string;
  externalId: string;
  payload: Transaction;
  previous: string | null;
  signature: string;
  candidateIds: string[];
  decisionToken: string | null;
  status: 'pending' | 'kept' | 'skipped' | 'obsolete';
  updatedAt: string;
}
export const bankReviewsTable = defineTable<BankReview>({
  name: 'history_bank_reviews',
  key: ['id'],
  columns: {
    id: 'text',
    accountId: 'text',
    externalId: 'text',
    payload: 'json',
    previous: 'text',
    signature: 'text',
    candidateIds: 'json',
    decisionToken: 'text',
    status: 'text',
    updatedAt: 'text',
  },
});
export const bankReviewSchema = z
  .object({ previewToken: z.string().regex(/^[a-f0-9]{64}$/), decision: z.enum(['keep', 'skip']) })
  .strict();
// Provider identity + financial content; no generated ID/time or display/category fields.
export const bankSignature = (t: Transaction) =>
  tokenFor([
    t.accountId,
    t.externalId,
    t.date,
    t.amount,
    t.currency,
    t.pending,
    t.pendingExternalId,
    t.rawName,
  ]);
export async function queueBankReview(
  t: Transaction,
  candidates: Transaction[],
  now: string,
  previous?: Transaction,
): Promise<BankReview> {
  return {
    id: `hbr_${await tokenFor([t.accountId, t.externalId])}`,
    accountId: t.accountId,
    externalId: t.externalId!,
    payload: t,
    previous: previous ? JSON.stringify(previous) : null,
    signature: await bankSignature(t),
    candidateIds: candidates.map((c) => c.id).sort(),
    status: 'pending',
    decisionToken: null,
    updatedAt: now,
  };
}
export async function bankReviewList(db: D1Database, id?: string) {
  const snapshot = await historySnapshot(db);
  const reviews = await selectAll(
    db,
    bankReviewsTable,
    id ? 'id = ?' : "status = 'pending'",
    id ? [id] : [],
    'id',
  );
  if (id && !reviews.length) throw notFound('Bank review not found.');
  const existing = await selectAll(db, transactionsTable);
  const accounts = await selectAll(db, accountsTable);
  const state = await readPolicy(db);
  return {
    reviews: await Promise.all(
      reviews.map(async (review) => ({
        id: review.id,
        status: review.status,
        transaction: review.payload,
        existingTransaction: review.previous ? (JSON.parse(review.previous) as Transaction) : null,
        candidates: monefyCandidates(review.payload, existing),
        eligible: eligible(state.policy, accounts, review.payload),
        previewToken: await tokenFor([snapshot, review]),
      })),
    ),
  };
}
function eligible(
  policy: Awaited<ReturnType<typeof readPolicy>>['policy'],
  accounts: Account[],
  t: Transaction,
) {
  const a = accounts.find((a) => a.id === t.accountId);
  return !!a && a.connectionId === t.connectionId && bankOwns(policy, a, t.date) !== false;
}
export async function resolveBankReview(
  db: D1Database,
  id: string,
  input: z.infer<typeof bankReviewSchema>,
  now: string,
) {
  const snapshot = await historySnapshot(db);
  const state = await readPolicy(db);
  const review = (await selectAll(db, bankReviewsTable, 'id = ?', [id]))[0];
  if (!review) throw notFound('Bank review not found.');
  const outcome = {
    id,
    decision: input.decision,
    transactionId: input.decision === 'keep' ? review.payload.id : null,
  };
  if (
    review.decisionToken === input.previewToken &&
    review.status === (input.decision === 'keep' ? 'kept' : 'skipped')
  )
    return { ...outcome, replayed: true };
  if (review.status !== 'pending')
    throw conflict(
      'This review is already resolved or superseded. Reload reviews and transactions.',
      'history_review_resolved',
    );
  if (input.previewToken !== (await tokenFor([snapshot, review])))
    throw conflict(
      'The candidate or history changed. Reload the review before deciding.',
      'history_policy_changed',
    );
  const [guard, release] = historyGuards(state.version, snapshot);
  const specs: StatementSpec[] = [guard];
  if (input.decision === 'keep') {
    if (!eligible(state.policy, await selectAll(db, accountsTable), review.payload))
      throw conflict(
        'The current policy no longer permits this transaction. Skip it or review the policy.',
        'history_transaction_excluded',
      );
    const existing = await selectAll(
      db,
      transactionsTable,
      'account_id = ? AND (external_id = ? OR id = ?)',
      [review.accountId, review.externalId, review.payload.id],
    );
    // Updates are held without overwriting the saved version. If it changed meanwhile,
    // demand a provider replay to build a fresh proposal rather than restoring stale edits.
    if (
      (review.previous === null && existing.length) ||
      (review.previous !== null &&
        (existing.length !== 1 || JSON.stringify(existing[0]) !== review.previous))
    )
      throw conflict(
        'A saved bank transaction now has this identity. Sync again to refresh its review; existing history is preserved.',
        'history_review_changed',
      );
    if (review.previous) {
      const before = JSON.parse(review.previous) as Transaction;
      const changes = Object.fromEntries(
        Object.entries(review.payload).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(before[key as keyof Transaction]),
        ),
      ) as Partial<Transaction>;
      specs.push(
        ...bulkUpdateSpecs(transactionsTable, [
          { key: { id: before.id }, changes: { ...changes, updatedAt: now } },
        ]),
      );
    } else
      specs.push(...bulkInsertSpecs(transactionsTable, [{ ...review.payload, updatedAt: now }]));
  }
  const candidates = monefyCandidates(
    review.payload,
    await selectAll(db, transactionsTable, 'account_id = ?', [review.accountId]),
  );
  specs.push(
    {
      sql: 'UPDATE history_bank_reviews SET status = ?, updated_at = ?, decision_token = ?, candidate_ids = ? WHERE id = ?',
      params: [
        input.decision === 'keep' ? 'kept' : 'skipped',
        now,
        input.previewToken,
        JSON.stringify(candidates.map((t) => t.id).sort()),
        id,
      ],
      rows: 1,
    },
    release,
  );
  await writeHistory(db, specs);
  return { ...outcome, replayed: false };
}
