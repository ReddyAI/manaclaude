import type { Account, SyncResult, Transaction } from '@manaclaude/shared';
import type { TransactionSyncOutput } from '@manaclaude/connectors';
import { bankOwns, effectivePolicy, monefyCandidates, type HistoryPolicy } from './model';
import { bankSignature, queueBankReview, type BankReview } from './reviews';

export function filterBankResult(
  policy: HistoryPolicy,
  accounts: Account[],
  ids: ReadonlyMap<string, string>,
  result: SyncResult,
) {
  const rejected = new Set<string>();
  const transactions = result.transactions.filter((t) => {
    const id = ids.get(t.accountExternalId);
    const account = accounts.find((a) => a.id === id);
    const allowed = !account || bankOwns(policy, account, t.date) !== false;
    if (!allowed) rejected.add(`${id}:${t.externalId}`);
    return allowed;
  });
  return {
    result: { ...result, transactions },
    rejected,
    excluded: result.transactions.length - transactions.length,
  };
}
export async function reviewBankPlan(
  policy: HistoryPolicy,
  accounts: Account[],
  plan: TransactionSyncOutput,
  existing: Transaction[],
  reviews: BankReview[],
  removedIds: string[],
  rejected: Set<string>,
  now: string,
) {
  const queued: BankReview[] = [];
  const retainedInserts: Transaction[] = [];
  const retainedUpdates: TransactionSyncOutput['updates'] = [];
  let skipped = 0;
  const check = async (t: Transaction, previous?: Transaction) => {
    const account = accounts.find((a) => a.id === t.accountId);
    if (!account || !effectivePolicy(policy, account)) return true;
    const prior = reviews.find((r) => r.accountId === t.accountId && r.externalId === t.externalId);
    const signature = await bankSignature(t);
    if (prior?.signature === signature && prior.status === 'skipped') {
      skipped++;
      return false;
    }
    if (prior?.signature === signature && prior.status === 'kept') return true;
    const candidates = monefyCandidates(t, existing);
    if (!candidates.length) return true;
    if (
      prior?.status === 'pending' &&
      prior.signature === signature &&
      prior.previous === (previous ? JSON.stringify(previous) : null) &&
      JSON.stringify(prior.candidateIds) === JSON.stringify(candidates.map((c) => c.id).sort())
    )
      return false;
    queued.push(await queueBankReview(t, candidates, now, previous));
    return false;
  };
  for (const t of plan.inserts) if (await check(t)) retainedInserts.push(t);
  for (const update of plan.updates) {
    const previous = existing.find((t) => t.id === update.id)!;
    if (await check({ ...previous, ...update.changes }, previous)) retainedUpdates.push(update);
  }
  const obsolete = reviews
    .filter(
      (r) =>
        r.status === 'pending' &&
        (removedIds.includes(r.externalId) ||
          rejected.has(`${r.accountId}:${r.externalId}`) ||
          retainedInserts.some(
            (t) => t.accountId === r.accountId && t.externalId === r.externalId,
          ) ||
          retainedUpdates.some((u) =>
            existing.some(
              (t) => t.id === u.id && t.accountId === r.accountId && t.externalId === r.externalId,
            ),
          )),
    )
    .map((r) => ({ ...r, status: 'obsolete' as const, updatedAt: now }));
  return {
    plan: { ...plan, inserts: retainedInserts, updates: retainedUpdates },
    queued,
    obsolete,
    skipped,
  };
}
