import {
  ACTIVE_TRANSFER_LINK_STATUSES,
  formatDayHeader,
  type Transaction,
  type TransferLink,
} from '@manaclaude/shared';
import type { Lookups } from '../../data/selectors';

/**
 * How transactions appear in lists (session A owns this file).
 * A linked transfer is one row: the "out" side, labelled "From to To".
 */

export interface TransactionListRow {
  key: string;
  txn: Transaction;
  title: string;
  subtitle: string;
  transfer: TransferLink | null;
}

export type TransactionListItem =
  { type: 'header'; key: string; title: string } | ({ type: 'row' } & TransactionListRow);

const LINK_KIND_LABEL: Record<TransferLink['kind'], string> = {
  transfer: 'Transfer',
  card_payment: 'Card payment',
  loan_payment: 'Loan payment',
  investment_contribution: 'Investment contribution',
  atm_withdrawal: 'Cash withdrawal',
};

export function activeLink(txn: Transaction, lookups: Lookups): TransferLink | null {
  if (!txn.transferLinkId) return null;
  const link = lookups.linksById.get(txn.transferLinkId);
  return link && ACTIVE_TRANSFER_LINK_STATUSES.includes(link.status) ? link : null;
}

/** Lists hide split children and the "in" side of a linked transfer. */
export function isListed(txn: Transaction, lookups: Lookups): boolean {
  if (txn.splitParentId) return false;
  const link = activeLink(txn, lookups);
  return !(link && link.inTransactionId === txn.id);
}

/** "Everyday Checking to High-Yield Savings" */
export function transferTitle(link: TransferLink, lookups: Lookups): string {
  const from = lookups.transactionsById.get(link.outTransactionId);
  const to = lookups.transactionsById.get(link.inTransactionId);
  const fromName = from ? lookups.accountsById.get(from.accountId)?.name : undefined;
  const toName = to ? lookups.accountsById.get(to.accountId)?.name : undefined;
  return `${fromName ?? 'Account'} to ${toName ?? 'account'}`;
}

export function describeTransaction(txn: Transaction, lookups: Lookups): TransactionListRow {
  const link = activeLink(txn, lookups);
  if (link) {
    return {
      key: txn.id,
      txn,
      title: transferTitle(link, lookups),
      subtitle: LINK_KIND_LABEL[link.kind],
      transfer: link,
    };
  }
  const account = lookups.accountsById.get(txn.accountId);
  const category = txn.categoryId ? lookups.categoriesById.get(txn.categoryId) : undefined;
  const parts = [category?.name ?? 'Uncategorized', account?.name].filter((p): p is string =>
    Boolean(p),
  );
  if (txn.pending) parts.unshift('Pending');
  if (txn.isSplitParent) parts.unshift('Split');
  return { key: txn.id, txn, title: txn.name, subtitle: parts.join(' · '), transfer: null };
}

/** Day-grouped items for FlashList. `transactions` must be sorted newest first. */
export function groupByDay(
  transactions: readonly Transaction[],
  lookups: Lookups,
  today: string,
): TransactionListItem[] {
  const items: TransactionListItem[] = [];
  let currentDay = '';
  for (const t of transactions) {
    if (!isListed(t, lookups)) continue;
    if (t.date !== currentDay) {
      currentDay = t.date;
      items.push({ type: 'header', key: `h_${t.date}`, title: formatDayHeader(t.date, today) });
    }
    items.push({ type: 'row', ...describeTransaction(t, lookups) });
  }
  return items;
}
