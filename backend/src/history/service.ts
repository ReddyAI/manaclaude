import { z } from 'zod';
import { selectAll } from '../db/table';
import { accountsTable, connectionsTable, transactionsTable } from '../db/tables';
import { bankReviewsTable, bankSignature } from './reviews';
import { conflict } from '../util/errors';
import {
  bankOwns,
  isMonefy,
  monefyCandidates,
  effectivePolicy,
  historyPolicySchema,
  normalizePolicy,
  sourcePeriods,
  type HistoryPolicy,
} from './model';
import { historyGuards, historySnapshot, readPolicy, tokenFor, writeHistory } from './store';

export const policyPreviewSchema = z.object({ policy: historyPolicySchema }).strict();
export const policySaveSchema = z
  .object({
    policy: historyPolicySchema,
    expectedVersion: z.number().int().nonnegative(),
    previewToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export async function getHistoryPolicy(db: D1Database) {
  const state = await readPolicy(db);
  return {
    version: state.version,
    policy: state.policy,
    accounts: await describeAccounts(db, state.policy),
  };
}
async function describeAccounts(db: D1Database, policy: HistoryPolicy) {
  const [accounts, connections] = await Promise.all([
    selectAll(db, accountsTable),
    selectAll(db, connectionsTable),
  ]);
  return accounts.map((account) => {
    const connection = connections.find((c) => c.id === account.connectionId);
    return {
      accountId: account.id,
      effective: effectivePolicy(policy, account),
      periods: sourcePeriods(policy, account),
      coverage: {
        status:
          connection && !['disconnected', 'needs_repair'].includes(connection.status)
            ? ('unknown' as const)
            : ('unavailable' as const),
        complete: false as const,
        message:
          'Provider history completeness is not established. Neither the oldest transaction nor a successful sync proves a replacement month is complete.',
      },
    };
  });
}
export async function previewHistoryPolicy(db: D1Database, input: HistoryPolicy) {
  const snapshot = await historySnapshot(db);
  const current = await readPolicy(db);
  const accounts = await selectAll(db, accountsTable);
  const policy = normalizePolicy(input, accounts);
  const transactions = await selectAll(db, transactionsTable);
  const conflicts: {
    accountId: string;
    transactionId: string;
    importId: string | null;
    reason: 'monefy_in_bank_period' | 'bank_in_monefy_period';
  }[] = [];
  for (const t of transactions) {
    const account = accounts.find((a) => a.id === t.accountId);
    if (!account) continue;
    const bank = bankOwns(policy, account, t.date);
    if ((bank === true && isMonefy(t)) || (bank === false && t.source === 'connector')) {
      conflicts.push({
        accountId: t.accountId,
        transactionId: t.id,
        importId: t.importId,
        reason: bank ? 'monefy_in_bank_period' : 'bank_in_monefy_period',
      });
    }
  }
  // Existing cross-source boundary candidates must also be resolved deliberately.
  const resolvedReviews = await selectAll(db, bankReviewsTable, "status = 'kept'");
  const importReviews = await db
    .prepare(
      `SELECT json_extract(j.value, '$.monefyTransactionId') AS monefyId,
    json_extract(j.value, '$.bankTransactionIds') AS bankIds FROM imports i, json_each(i.preview, '$.reviewedBoundaryPairs') j
    WHERE i.status = 'committed'`,
    )
    .all<{ monefyId: string; bankIds: string }>();
  const reviewedPairs = new Set<string>();
  for (const r of importReviews.results)
    for (const id of JSON.parse(r.bankIds) as string[]) reviewedPairs.add(`${id}:${r.monefyId}`);
  for (const r of resolvedReviews) {
    const saved = transactions.find(
      (t) => t.accountId === r.accountId && t.externalId === r.externalId,
    );
    if (saved && (await bankSignature(saved)) === r.signature)
      for (const id of r.candidateIds) reviewedPairs.add(`${saved.id}:${id}`);
  }
  const boundaryCandidates = transactions
    .filter(
      (t) =>
        t.source === 'connector' &&
        accounts.some((a) => a.id === t.accountId && effectivePolicy(policy, a)),
    )
    .flatMap((t) => {
      const ids = monefyCandidates(t, transactions)
        .map((x) => x.id)
        .filter((id) => !reviewedPairs.has(`${t.id}:${id}`));
      return ids.length ? [{ bankTransactionId: t.id, monefyTransactionIds: ids }] : [];
    });
  const pending = await db
    .prepare("SELECT count(*) AS n FROM history_bank_reviews WHERE status = 'pending'")
    .first<{ n: number }>();
  return {
    expectedVersion: current.version,
    policy,
    previewToken: await tokenFor([snapshot, policy]),
    allowed: conflicts.length === 0 && boundaryCandidates.length === 0 && pending!.n === 0,
    conflicts,
    boundaryCandidates,
    pendingBankReviews: pending!.n,
    accounts: await describeAccounts(db, policy),
    warnings: [
      'Each selected replacement month replaces the entire account/month, including scattered Monefy entries. Missing months are never inferred.',
      'Existing history is never deleted or hidden by a policy save. Undo the identified Monefy import and preview the original again, or choose periods compatible with saved bank history. Resolve pending bank reviews first.',
      'Purchase and posting dates can differ. Equal account/currency/signed amount within three days requires review; other duplicates may remain undetected.',
    ],
    // Kept private by the route; the raw snapshot never leaves the service.
    snapshot,
  };
}
export async function saveHistoryPolicy(
  db: D1Database,
  input: z.infer<typeof policySaveSchema>,
  now: string,
) {
  const current = await readPolicy(db);
  const normalized = normalizePolicy(input.policy, await selectAll(db, accountsTable));
  if (
    current.version === input.expectedVersion + 1 &&
    current.reviewToken === input.previewToken &&
    JSON.stringify(current.policy) === JSON.stringify(normalized)
  )
    return { ...(await getHistoryPolicy(db)), replayed: true };
  if (current.version !== input.expectedVersion)
    throw conflict(
      'The policy changed. Reload it and request a new preview.',
      'history_policy_changed',
    );
  const review = await previewHistoryPolicy(db, normalized);
  if (!review.allowed)
    throw conflict(
      'Existing history conflicts with this policy. Read a new policy preview for transaction/import IDs and resolution steps; no history was changed.',
      'history_transition_conflict',
    );
  if (review.previewToken !== input.previewToken)
    throw conflict(
      'The reviewed history changed. Request and review a new preview.',
      'history_policy_changed',
    );
  const [guard, release] = historyGuards(input.expectedVersion, review.snapshot);
  await writeHistory(db, [
    guard,
    {
      sql: 'INSERT INTO history_policy (id, version, config, review_token, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, config = excluded.config, review_token = excluded.review_token, updated_at = excluded.updated_at',
      params: [current.version + 1, JSON.stringify(normalized), input.previewToken, now],
      rows: 1,
    },
    release,
  ]);
  return { ...(await getHistoryPolicy(db)), replayed: false };
}
