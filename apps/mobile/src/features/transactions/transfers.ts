import {
  ACTIVE_TRANSFER_LINK_STATUSES,
  convertAmount,
  daysBetween,
  impliedRateOf,
  type Account,
  type FinanceDataset,
  type Transaction,
  type TransactionKind,
  type TransferLink,
  type TransferLinkKind,
} from '@manaclaude/shared';

/**
 * Manual link and unlink of transfers (session A). The automatic matcher is
 * session B's; this is what the person does by hand when it missed a pair or
 * got one wrong. A link is stored with status "confirmed"; an unlink keeps
 * the record with status "rejected" so the matcher never proposes the pair again.
 */

const KIND_OF_LINK: Record<TransferLinkKind, TransactionKind> = {
  transfer: 'transfer',
  card_payment: 'card_payment',
  loan_payment: 'loan_payment',
  investment_contribution: 'investment_contribution',
  atm_withdrawal: 'transfer',
};

/** What kind of transfer money from `from` into `into` is. */
export function inferLinkKind(
  from: Account | undefined,
  into: Account | undefined,
): TransferLinkKind {
  if (!from || !into) return 'transfer';
  if (into.type === 'credit_card') return 'card_payment';
  if (into.type === 'loan' || into.type === 'mortgage') return 'loan_payment';
  if (into.type === 'brokerage' || into.type === 'retirement') return 'investment_contribution';
  if (into.type === 'cash' && from.type !== 'cash') return 'atm_withdrawal';
  return 'transfer';
}

function isLinked(txn: Transaction, data: FinanceDataset): boolean {
  if (!txn.transferLinkId) return false;
  const link = data.transferLinks.find((l) => l.id === txn.transferLinkId);
  return !!link && ACTIVE_TRANSFER_LINK_STATUSES.includes(link.status);
}

export type LinkCheck =
  { ok: true; out: Transaction; into: Transaction } | { ok: false; error: string };

/** Can these two transactions be linked as one transfer? */
export function checkLink(data: FinanceDataset, aId: string, bId: string): LinkCheck {
  const a = data.transactions.find((t) => t.id === aId);
  const b = data.transactions.find((t) => t.id === bId);
  if (!a || !b || a.id === b.id) return { ok: false, error: 'Pick two different transactions.' };
  if (a.accountId === b.accountId) {
    return { ok: false, error: 'Both sides are in the same account.' };
  }
  if (a.isSplitParent || b.isSplitParent || a.splitParentId || b.splitParentId) {
    return { ok: false, error: 'Split transactions cannot be linked. Undo the split first.' };
  }
  if (Math.sign(a.amount) === Math.sign(b.amount) || a.amount === 0 || b.amount === 0) {
    return { ok: false, error: 'One side must be money out and the other money in.' };
  }
  if (isLinked(a, data) || isLinked(b, data)) {
    return { ok: false, error: 'One of them is already part of a transfer. Unlink it first.' };
  }
  return a.amount < 0 ? { ok: true, out: a, into: b } : { ok: true, out: b, into: a };
}

export interface TransferCandidate {
  txn: Transaction;
  /** 0 to 1, higher is more likely to be the other side. */
  score: number;
}

/** Days either side of the date a counterpart is offered. */
export const CANDIDATE_WINDOW_DAYS = 7;

/**
 * Likely other sides for a transaction: opposite sign, another account, not
 * already linked, close in date, and close in amount after converting
 * currencies. Best match first.
 */
export function transferCandidates(
  data: FinanceDataset,
  txn: Transaction,
  limit = 12,
): TransferCandidate[] {
  const out: TransferCandidate[] = [];
  for (const other of data.transactions) {
    if (other.id === txn.id || other.accountId === txn.accountId) continue;
    if (Math.sign(other.amount) === Math.sign(txn.amount) || other.amount === 0) continue;
    if (other.pending || other.excluded || other.isSplitParent || other.splitParentId) continue;
    if (isLinked(other, data)) continue;
    const days = Math.abs(daysBetween(txn.date, other.date));
    if (days > CANDIDATE_WINDOW_DAYS) continue;
    const converted = convertAmount(
      Math.abs(txn.amount),
      txn.currency,
      other.currency,
      data.fxRates,
      { mode: 'on', date: txn.date },
    );
    const closeness =
      converted === null || converted === 0
        ? 0
        : Math.max(0, 1 - Math.abs(converted - Math.abs(other.amount)) / converted);
    // Amount matters most; each day apart costs a little.
    const score = closeness * 0.8 + (1 - days / (CANDIDATE_WINDOW_DAYS + 1)) * 0.2;
    out.push({ txn: other, score });
  }
  return out
    .sort((a, b) => b.score - a.score || b.txn.date.localeCompare(a.txn.date))
    .slice(0, limit);
}

/** Link two transactions by hand. Returns the data unchanged when they cannot be linked. */
export function applyLinkTransfer(
  data: FinanceDataset,
  aId: string,
  bId: string,
  now: string,
  linkId = `tl_manual_${aId}_${bId}`,
): FinanceDataset {
  const check = checkLink(data, aId, bId);
  if (!check.ok) return data;
  const { out, into } = check;
  const accountsById = new Map(data.accounts.map((a) => [a.id, a]));
  const kind = inferLinkKind(accountsById.get(out.accountId), accountsById.get(into.accountId));
  const link: TransferLink = {
    id: data.transferLinks.some((l) => l.id === linkId) ? `${linkId}_${now}` : linkId,
    outTransactionId: out.id,
    inTransactionId: into.id,
    outAmount: Math.abs(out.amount),
    outCurrency: out.currency,
    inAmount: Math.abs(into.amount),
    inCurrency: into.currency,
    impliedRate:
      Math.round(impliedRateOf(out.amount, out.currency, into.amount, into.currency) * 10_000) /
      10_000,
    status: 'confirmed',
    kind,
    matchScore: null,
    matchedBy: 'user',
    createdAt: now,
    updatedAt: now,
  };
  const mark = (t: Transaction): Transaction => ({
    ...t,
    transferLinkId: link.id,
    kind: KIND_OF_LINK[kind],
    reviewed: true,
    reviewedAt: now,
    userEditedFields: t.userEditedFields.includes('kind')
      ? t.userEditedFields
      : [...t.userEditedFields, 'kind'],
    updatedAt: now,
  });
  return {
    ...data,
    transferLinks: [...data.transferLinks, link],
    transactions: data.transactions.map((t) => (t.id === out.id || t.id === into.id ? mark(t) : t)),
  };
}

/**
 * Unlink a transfer. The link stays stored as "rejected" so the matcher does
 * not propose it again. Both sides become ordinary transactions waiting for a
 * category in the review queue.
 */
export function applyUnlinkTransfer(
  data: FinanceDataset,
  linkId: string,
  now: string,
): FinanceDataset {
  const link = data.transferLinks.find((l) => l.id === linkId);
  if (!link || link.status === 'rejected') return data;
  const categoriesById = new Map(data.categories.map((c) => [c.id, c]));
  const release = (t: Transaction): Transaction => {
    const wasTransferCategory = t.categoryId
      ? categoriesById.get(t.categoryId)?.kind === 'transfer'
      : false;
    return {
      ...t,
      transferLinkId: null,
      kind: 'regular',
      ...(wasTransferCategory
        ? { categoryId: null, categorySource: null, aiCategoryConfidence: null }
        : {}),
      reviewed: false,
      reviewedAt: null,
      userEditedFields: t.userEditedFields.includes('kind')
        ? t.userEditedFields
        : [...t.userEditedFields, 'kind'],
      updatedAt: now,
    };
  };
  return {
    ...data,
    transferLinks: data.transferLinks.map((l) =>
      l.id === linkId ? { ...l, status: 'rejected', updatedAt: now } : l,
    ),
    transactions: data.transactions.map((t) =>
      t.transferLinkId === linkId &&
      (t.id === link.outTransactionId || t.id === link.inTransactionId)
        ? release(t)
        : t,
    ),
  };
}

/** Confirm a link the matcher only suggested. */
export function applyConfirmTransfer(
  data: FinanceDataset,
  linkId: string,
  now: string,
): FinanceDataset {
  const link = data.transferLinks.find((l) => l.id === linkId);
  if (!link || link.status !== 'suggested') return data;
  const kind = KIND_OF_LINK[link.kind];
  return {
    ...data,
    transferLinks: data.transferLinks.map((l) =>
      l.id === linkId ? { ...l, status: 'confirmed', matchedBy: 'user', updatedAt: now } : l,
    ),
    transactions: data.transactions.map((t) =>
      t.id === link.outTransactionId || t.id === link.inTransactionId
        ? { ...t, kind, reviewed: true, reviewedAt: now, updatedAt: now }
        : t,
    ),
  };
}
