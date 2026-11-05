import {
  allocate,
  buildSplitChildren,
  validateSplit,
  type FinanceDataset,
  type Receipt,
  type ReceiptLineItem,
  type SplitLineInput,
  type Transaction,
} from '@manaclaude/shared';
import { compareNewestFirst } from './display';

/**
 * "Split by items" (session A): turns receipt line items into split lines and
 * writes them with validateSplit / buildSplitChildren from @manaclaude/shared.
 *
 * The card charge is the truth, not the receipt. Tax and tip are not separate
 * lines: the whole charge is spread over the items in proportion to their
 * prices (largest remainder, so the lines add up to the charge exactly).
 * Items in the same category become one split line.
 */

/** Category chosen for each item id; missing or null falls back to the item's suggestion, then the parent's. */
export type ItemCategories = Readonly<Record<string, string | null | undefined>>;

export function itemCategory(
  item: ReceiptLineItem,
  parent: Transaction,
  chosen: ItemCategories,
): string | null {
  return chosen[item.id] ?? item.categoryId ?? parent.categoryId;
}

export function itemsTotal(items: readonly ReceiptLineItem[]): number {
  return items.reduce((sum, i) => sum + i.amount, 0);
}

export type ItemSplitResult = { ok: true; lines: SplitLineInput[] } | { ok: false; error: string };

/** Split lines for a transaction from receipt items. Pure; nothing is written. */
export function buildItemSplitLines(
  parent: Transaction,
  items: readonly ReceiptLineItem[],
  chosen: ItemCategories = {},
): ItemSplitResult {
  const priced = items.filter((i) => i.amount > 0);
  if (priced.length === 0) return { ok: false, error: 'Add at least one item with a price.' };
  const shares = allocate(
    Math.abs(parent.amount),
    priced.map((i) => i.amount),
  );
  const sign = Math.sign(parent.amount);
  const groups = new Map<string, { categoryId: string | null; amount: number; names: string[] }>();
  priced.forEach((item, i) => {
    const categoryId = itemCategory(item, parent, chosen);
    const key = categoryId ?? '';
    const group = groups.get(key) ?? { categoryId, amount: 0, names: [] };
    group.amount += shares[i] ?? 0;
    group.names.push(item.description);
    groups.set(key, group);
  });
  const lines: SplitLineInput[] = [...groups.values()]
    .filter((g) => g.amount > 0)
    .map((g) => ({
      amount: g.amount * sign,
      categoryId: g.categoryId,
      notes: g.names.join(', '),
    }));
  const check = validateSplit(parent, lines);
  return check.ok ? { ok: true, lines } : { ok: false, error: check.error };
}

/**
 * Apply a split to the dataset in one step: the parent and its children change
 * together or not at all. A double tap cannot add a second set of children:
 * the parent is a split parent after the first, and validateSplit refuses it.
 * The idempotency key becomes part of the child ids, so the same request
 * always produces the same ids.
 */
export function applySplit(
  data: FinanceDataset,
  parentId: string,
  lines: readonly SplitLineInput[],
  idempotencyKey: string,
  now: string,
): { data: FinanceDataset; error: string | null } {
  const parent = data.transactions.find((t) => t.id === parentId);
  if (!parent) return { data, error: 'Transaction not found.' };
  const check = validateSplit(parent, lines);
  if (!check.ok) return { data, error: check.error };
  const built = buildSplitChildren(
    parent,
    lines,
    (index) => `${parent.id}_split_${idempotencyKey}_${index + 1}`,
    now,
  );
  const children = built.children.map((c) => ({ ...c, reviewed: true, reviewedAt: now }));
  return {
    data: {
      ...data,
      transactions: [
        ...data.transactions.map((t) =>
          t.id === parent.id ? { ...built.parent, reviewed: true, reviewedAt: now } : t,
        ),
        ...children,
      ].sort(compareNewestFirst),
    },
    error: null,
  };
}

/** Undo a split: the children go away and the parent counts again. */
export function applyUndoSplit(
  data: FinanceDataset,
  parentId: string,
  now: string,
): FinanceDataset {
  const parent = data.transactions.find((t) => t.id === parentId);
  if (!parent?.isSplitParent) return data;
  return {
    ...data,
    transactions: data.transactions
      .filter((t) => t.splitParentId !== parentId)
      .map((t) => (t.id === parentId ? { ...t, isSplitParent: false, updatedAt: now } : t)),
  };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** A receipt for a photo that is on this device. Session B uploads it and fills in the rest. */
export function newLocalReceipt(id: string, localUri: string, now: string): Receipt {
  return {
    id,
    r2Key: `pending-upload/${id}.jpg`,
    localUri,
    merchant: null,
    date: null,
    total: null,
    subtotal: null,
    tax: null,
    tip: null,
    currency: null,
    lineItems: [],
    matchedTransactionId: null,
    status: 'uploaded',
    aiConfidence: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Attach a photo to a transaction as a new receipt. */
export function applyAttachReceipt(
  data: FinanceDataset,
  transactionId: string,
  receiptId: string,
  localUri: string,
  now: string,
): FinanceDataset {
  const txn = data.transactions.find((t) => t.id === transactionId);
  if (!txn) return data;
  const receipt: Receipt = {
    ...newLocalReceipt(receiptId, localUri, now),
    merchant: txn.name,
    date: txn.date,
    currency: txn.currency,
    matchedTransactionId: txn.id,
    status: 'matched',
  };
  return {
    ...data,
    receipts: [...data.receipts.filter((r) => r.id !== receiptId), receipt],
    transactions: data.transactions.map((t) =>
      t.id === transactionId ? { ...t, receiptId, updatedAt: now } : t,
    ),
  };
}

/** Save a photo that is not matched to any transaction yet (shared into the app). */
export function applySaveUnmatchedReceipt(
  data: FinanceDataset,
  receiptId: string,
  localUri: string,
  now: string,
): FinanceDataset {
  return {
    ...data,
    receipts: [
      ...data.receipts.filter((r) => r.id !== receiptId),
      newLocalReceipt(receiptId, localUri, now),
    ],
  };
}

/** Replace the line items of a receipt (the person typed them in, or the AI read them). */
export function applySetReceiptItems(
  data: FinanceDataset,
  receiptId: string,
  items: readonly ReceiptLineItem[],
  now: string,
): FinanceDataset {
  return {
    ...data,
    receipts: data.receipts.map((r) =>
      r.id === receiptId ? { ...r, lineItems: [...items], updatedAt: now } : r,
    ),
  };
}

/** Remove a receipt and detach it from its transaction. */
export function applyRemoveReceipt(
  data: FinanceDataset,
  receiptId: string,
  now: string,
): FinanceDataset {
  return {
    ...data,
    receipts: data.receipts.filter((r) => r.id !== receiptId),
    transactions: data.transactions.map((t) =>
      t.receiptId === receiptId ? { ...t, receiptId: null, updatedAt: now } : t,
    ),
  };
}
