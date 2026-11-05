import { todayLocal, type ReceiptLineItem, type SplitLineInput } from '@manaclaude/shared';
import { getFinance, updateFinance } from '../../data/store';
import { applyAddCash, type CashEntry } from './cash';
import {
  applyAttachReceipt,
  applyRemoveReceipt,
  applySaveUnmatchedReceipt,
  applySetReceiptItems,
  applySplit,
  applyUndoSplit,
} from './receiptSplit';
import { applyConfirmTransfer, applyLinkTransfer, applyUnlinkTransfer } from './transfers';

/**
 * Transaction edits (session A owns this file). They change the local store
 * now; once the backend exists they also call its API.
 *
 * The logic lives in pure functions (transfers.ts, receiptSplit.ts, cash.ts)
 * that take a dataset and return a new one; these wrappers apply them to the
 * store.
 */

let counter = 0;

/** A fresh id for something created on this device. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}

const nowIso = () => new Date().toISOString();

export function setReviewed(transactionId: string, reviewed: boolean): void {
  const now = nowIso();
  updateFinance((d) => ({
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === transactionId
        ? { ...t, reviewed, reviewedAt: reviewed ? now : null, updatedAt: now }
        : t,
    ),
  }));
}

/**
 * The person picked a category: it counts as a correction. The AI score no
 * longer applies, the field is marked as theirs so sync and AI leave it
 * alone, and the transaction counts as reviewed.
 */
export function setCategory(transactionId: string, categoryId: string): void {
  const now = nowIso();
  updateFinance((d) => ({
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === transactionId
        ? {
            ...t,
            categoryId,
            categorySource: 'user',
            aiCategoryConfidence: null,
            reviewed: true,
            reviewedAt: now,
            userEditedFields: t.userEditedFields.includes('categoryId')
              ? t.userEditedFields
              : [...t.userEditedFields, 'categoryId'],
            updatedAt: now,
          }
        : t,
    ),
  }));
}

// Transfers -----------------------------------------------------------------

export function linkTransfer(aTransactionId: string, bTransactionId: string): void {
  const now = nowIso();
  updateFinance((d) => applyLinkTransfer(d, aTransactionId, bTransactionId, now));
}

export function unlinkTransfer(linkId: string): void {
  const now = nowIso();
  updateFinance((d) => applyUnlinkTransfer(d, linkId, now));
}

export function confirmTransfer(linkId: string): void {
  const now = nowIso();
  updateFinance((d) => applyConfirmTransfer(d, linkId, now));
}

// Receipts ------------------------------------------------------------------

/** Attach a photo already saved on this device. Returns the new receipt's id. */
export function attachReceipt(transactionId: string, localUri: string): string {
  const id = newId('rcp');
  const now = nowIso();
  updateFinance((d) => applyAttachReceipt(d, transactionId, id, localUri, now));
  return id;
}

/** Keep a shared photo without a transaction; the backend matches it later. */
export function saveUnmatchedReceipt(localUri: string): string {
  const id = newId('rcp');
  const now = nowIso();
  updateFinance((d) => applySaveUnmatchedReceipt(d, id, localUri, now));
  return id;
}

export function setReceiptItems(receiptId: string, items: readonly ReceiptLineItem[]): void {
  const now = nowIso();
  updateFinance((d) => applySetReceiptItems(d, receiptId, items, now));
}

export function removeReceipt(receiptId: string): void {
  const now = nowIso();
  updateFinance((d) => applyRemoveReceipt(d, receiptId, now));
}

// Splits --------------------------------------------------------------------

/** Split a transaction. Returns an error message, or null when it worked. */
export function splitTransaction(
  transactionId: string,
  lines: readonly SplitLineInput[],
  idempotencyKey: string = newId('split'),
): string | null {
  const now = nowIso();
  const result = applySplit(getFinance(), transactionId, lines, idempotencyKey, now);
  if (result.error) return result.error;
  updateFinance(() => result.data);
  return null;
}

export function undoSplit(transactionId: string): void {
  const now = nowIso();
  updateFinance((d) => applyUndoSplit(d, transactionId, now));
}

// Cash ----------------------------------------------------------------------

/** Add a cash transaction. Returns the new transaction's id. */
export function addCashTransaction(
  entry: Omit<CashEntry, 'id' | 'now' | 'date'> & { date?: string },
): string {
  const id = newId('txn_cash');
  const now = nowIso();
  updateFinance((d) => applyAddCash(d, { ...entry, id, now, date: entry.date ?? todayLocal() }));
  return id;
}
