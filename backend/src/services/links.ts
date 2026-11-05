import { impliedRateOf, type Id, type TransferLink } from '@manaclaude/shared';
import { selectAll, selectOne } from '../db/table';
import { accountsTable, transferLinksTable } from '../db/tables';
import { badRequest, conflict, notFound } from '../util/errors';
import { nowIso } from '../util/ids';
import { linkFromCandidate } from './matcher';
import { getTransaction } from './transactions';

export function getLink(db: D1Database, id: Id): Promise<TransferLink | null> {
  return selectOne(db, transferLinksTable, 'id = ?', [id]);
}

export function listLinks(db: D1Database, status?: TransferLink['status']): Promise<TransferLink[]> {
  return status
    ? selectAll(db, transferLinksTable, 'status = ?', [status], 'created_at DESC')
    : selectAll(db, transferLinksTable, '', [], 'created_at DESC');
}

/** Activates a link: both transactions point at it and other suggestions for them go away. */
async function activate(db: D1Database, link: TransferLink, status: 'confirmed'): Promise<TransferLink> {
  const now = nowIso();
  try {
    const res = await db.batch([
      db
        .prepare('UPDATE transfer_links SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, now, link.id),
      db
        .prepare('UPDATE transactions SET transfer_link_id = ?, updated_at = ? WHERE id IN (?, ?) AND transfer_link_id IS NULL')
        .bind(link.id, now, link.outTransactionId, link.inTransactionId),
      db
        .prepare(
          "DELETE FROM transfer_links WHERE status = 'suggested' AND id != ? AND (out_transaction_id IN (?, ?) OR in_transaction_id IN (?, ?))",
        )
        .bind(link.id, link.outTransactionId, link.inTransactionId, link.outTransactionId, link.inTransactionId),
    ]);
    if ((res[1]?.meta.changes ?? 0) !== 2) {
      throw conflict('One side of this transfer is already linked to something else.');
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'ApiError') throw e;
    throw conflict('One side of this transfer is already linked to something else.');
  }
  return { ...link, status, updatedAt: now };
}

/** Confirms a suggested (or auto) link. */
export async function confirmLink(db: D1Database, id: Id): Promise<TransferLink> {
  const link = await getLink(db, id);
  if (!link) throw notFound('No such transfer link.');
  if (link.status === 'confirmed') return link;
  if (link.status === 'auto') {
    const now = nowIso();
    await db.prepare('UPDATE transfer_links SET status = ?, updated_at = ? WHERE id = ?').bind('confirmed', now, id).run();
    return { ...link, status: 'confirmed', updatedAt: now };
  }
  if (link.status === 'rejected') throw conflict('This pair was unlinked; link it again by hand.');
  return activate(db, link, 'confirmed');
}

/**
 * Unlinks (or turns down a suggestion). The pair stays stored as rejected so
 * the matcher never proposes it again.
 */
export async function rejectLink(db: D1Database, id: Id): Promise<TransferLink> {
  const link = await getLink(db, id);
  if (!link) throw notFound('No such transfer link.');
  const now = nowIso();
  await db.batch([
    db.prepare('UPDATE transfer_links SET status = ?, updated_at = ? WHERE id = ?').bind('rejected', now, id),
    db
      .prepare('UPDATE transactions SET transfer_link_id = NULL, updated_at = ? WHERE transfer_link_id = ?')
      .bind(now, id),
  ]);
  return { ...link, status: 'rejected', updatedAt: now };
}

/** Links two transactions by hand (A's "Link" action, MCP link_transfer). */
export async function linkManually(db: D1Database, aId: Id, bId: Id): Promise<TransferLink> {
  const [a, b] = await Promise.all([getTransaction(db, aId), getTransaction(db, bId)]);
  if (!a || !b) throw notFound('Transaction not found.');
  if (a.accountId === b.accountId) throw badRequest('Both sides are in the same account.');
  if (Math.sign(a.amount) === Math.sign(b.amount) || a.amount === 0 || b.amount === 0) {
    throw badRequest('A transfer needs money out of one account and into another.');
  }
  if (a.transferLinkId || b.transferLinkId) throw conflict('One side is already linked.');
  const out = a.amount < 0 ? a : b;
  const into = a.amount < 0 ? b : a;
  const accounts = await selectAll(db, accountsTable, 'id IN (?, ?)', [out.accountId, into.accountId]);
  const inAcc = accounts.find((x) => x.id === into.accountId);
  const kind =
    inAcc?.type === 'credit_card'
      ? 'card_payment'
      : inAcc?.type === 'loan' || inAcc?.type === 'mortgage'
        ? 'loan_payment'
        : inAcc?.type === 'brokerage' || inAcc?.type === 'retirement'
          ? 'investment_contribution'
          : inAcc?.type === 'cash'
            ? 'atm_withdrawal'
            : 'transfer';
  const existing = await selectOne(db, transferLinksTable, 'out_transaction_id = ? AND in_transaction_id = ?', [out.id, into.id]);
  const link =
    existing ??
    linkFromCandidate(
      {
        out,
        in: into,
        kind,
        score: null,
        impliedRate: impliedRateOf(out.amount, out.currency, into.amount, into.currency),
      },
      'suggested',
      'user',
      nowIso(),
    );
  if (!existing) {
    await db
      .prepare(
        'INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id, out_amount, out_currency, in_amount, in_currency, implied_rate, status, kind, match_score, matched_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        link.id,
        link.outTransactionId,
        link.inTransactionId,
        link.outAmount,
        link.outCurrency,
        link.inAmount,
        link.inCurrency,
        link.impliedRate,
        'suggested',
        link.kind,
        null,
        'user',
        link.createdAt,
        link.updatedAt,
      )
      .run();
  } else {
    await db.prepare("UPDATE transfer_links SET matched_by = 'user' WHERE id = ?").bind(link.id).run();
  }
  return activate(db, { ...link, matchedBy: 'user' }, 'confirmed');
}
