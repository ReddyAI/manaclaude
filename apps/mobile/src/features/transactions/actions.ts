import {
  todayLocal,
  type Account,
  type CashResponse,
  type CashTransactionDeleteResponse,
  type Receipt,
  type ReceiptAttachRequest,
  type ReceiptAttachResponse,
  type ReceiptLineItem,
  type ReceiptResponse,
  type SplitLineInput,
  type SplitResponse,
  type TransactionPatchRequest,
  type TransactionResponse,
} from '@manaclaude/shared';
import { api, BackendError, errorText, isSuperseded } from '../../data/backend/client';
import {
  canSaveToBackend,
  mergeTransactions,
  persist,
  refreshDataset,
  rememberReceiptUri,
  scheduleRefresh,
} from '../../data/backend/sync';
import { fileForm, imageTypeOf } from '../../data/backend/upload';
import { getFinance, updateFinance } from '../../data/store';
import { applyAddCash, type CashEntry } from './cash';
import { applyCashDelete, cashDeleteErrorText, reversedText } from './cashDelete';
import {
  applyAttachReceipt,
  applyRemoveReceipt,
  applySaveUnmatchedReceipt,
  applySetReceiptItems,
  applySplit,
  applyUndoSplit,
} from './receiptSplit';
import { applyEdit } from './edit';
import {
  applyConfirmTransfer,
  applyLinkTransfer,
  applyRejectSuggestion,
  applyUnlinkTransfer,
} from './transfers';

/**
 * Transaction edits (session A owns this file). Each one changes the local
 * store at once, then (session E2) sends the change to the matching /v1
 * endpoint when the backend is set up in Settings; a failed save is undone and
 * shown in the banner (data/backend/sync.ts, persist).
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

type TxnResponse = TransactionResponse;
const savedTxn = (r: TxnResponse) => mergeTransactions([r.transaction]);

export function setReviewed(transactionId: string, reviewed: boolean): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => ({
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === transactionId
        ? { ...t, reviewed, reviewedAt: reviewed ? now : null, updatedAt: now }
        : t,
    ),
  }));
  void persist(
    'review',
    before,
    () => api<TxnResponse>('POST', `/v1/transactions/${transactionId}/review`, { reviewed }),
    { onSaved: savedTxn },
  );
}

/**
 * The person picked a category: it counts as a correction. The AI score no
 * longer applies, the field is marked as theirs so sync and AI leave it
 * alone, and the transaction counts as reviewed.
 */
export function setCategory(transactionId: string, categoryId: string): void {
  const now = nowIso();
  const before = getFinance();
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
  void persist(
    'category',
    before,
    () => api<TxnResponse>('POST', `/v1/transactions/${transactionId}/category`, { categoryId }),
    { onSaved: savedTxn },
  );
}

/**
 * Saves an edit of name, date, amount, notes, kind, tags or "left out"
 * (PATCH /v1/transactions/:id). Send only the fields that changed: the Worker
 * marks each one as edited by hand, so syncs, imports, rules and the AI never
 * change it again. The screen changes at once; a refused save is undone and
 * the banner says why.
 */
export function editTransaction(transactionId: string, patch: TransactionPatchRequest): void {
  if (Object.keys(patch).length === 0) return;
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => ({
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === transactionId ? applyEdit(t, patch, now) : t,
    ),
  }));
  void persist(
    'edit',
    before,
    () => api<TxnResponse>('PATCH', `/v1/transactions/${transactionId}`, patch),
    { onSaved: savedTxn },
  );
}

// Transfers -----------------------------------------------------------------

export function linkTransfer(aTransactionId: string, bTransactionId: string): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applyLinkTransfer(d, aTransactionId, bTransactionId, now));
  void persist(
    'link',
    before,
    () =>
      api('POST', `/v1/transactions/${aTransactionId}/link`, {
        otherTransactionId: bTransactionId,
      }),
    { refreshAfter: true },
  );
}

export function unlinkTransfer(linkId: string): void {
  const now = nowIso();
  const before = getFinance();
  const link = before.transferLinks.find((l) => l.id === linkId);
  updateFinance((d) => applyUnlinkTransfer(d, linkId, now));
  if (!link) return;
  void persist(
    'unlink',
    before,
    () => api('POST', `/v1/transactions/${link.outTransactionId}/unlink`),
    { refreshAfter: true },
  );
}

export function confirmTransfer(linkId: string): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applyConfirmTransfer(d, linkId, now));
  void persist(
    'confirm transfer',
    before,
    () => api('POST', `/v1/transfer-links/${linkId}/confirm`),
    {
      refreshAfter: true,
    },
  );
}

/**
 * Turns down one suggested pair (POST /v1/transfer-links/:id/reject). The
 * Worker keeps it as rejected so the matcher never proposes it again.
 */
export function rejectSuggestion(linkId: string): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applyRejectSuggestion(d, linkId, now));
  void persist('not a transfer', before, () => api('POST', `/v1/transfer-links/${linkId}/reject`), {
    refreshAfter: true,
  });
}

/** Uploads a receipt photo from the phone and swaps the local record for the backend's. */
function uploadReceipt(localId: string, localUri: string, transactionId?: string): void {
  const before = getFinance();
  void persist(
    'receipt',
    before,
    async () =>
      api<ReceiptResponse>(
        'POST',
        '/v1/receipts',
        await fileForm(localUri, 'receipt.jpg', imageTypeOf(localUri), { transactionId }),
        { timeoutMs: 90_000 },
      ),
    {
      onSaved: ({ receipt }) => {
        rememberReceiptUri(receipt.id, localUri);
        updateFinance((d) => ({
          ...d,
          receipts: d.receipts.map((r) => (r.id === localId ? { ...receipt, localUri } : r)),
          transactions: d.transactions.map((t) =>
            t.receiptId === localId ? { ...t, receiptId: receipt.id } : t,
          ),
        }));
      },
      refreshAfter: true,
    },
  );
}

// Receipts ------------------------------------------------------------------

/** Attach a photo already saved on this device. Returns the new receipt's id. */
export function attachReceipt(transactionId: string, localUri: string): string {
  const id = newId('rcp');
  const now = nowIso();
  updateFinance((d) => applyAttachReceipt(d, transactionId, id, localUri, now));
  uploadReceipt(id, localUri, transactionId);
  return id;
}

/** Keep a shared photo without a transaction; the backend matches it later. */
export function saveUnmatchedReceipt(localUri: string): string {
  const id = newId('rcp');
  const now = nowIso();
  updateFinance((d) => applySaveUnmatchedReceipt(d, id, localUri, now));
  uploadReceipt(id, localUri);
  return id;
}

export function setReceiptItems(receiptId: string, items: readonly ReceiptLineItem[]): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applySetReceiptItems(d, receiptId, items, now));
  void persist('receipt items', before, () =>
    api('PATCH', `/v1/receipts/${receiptId}`, { lineItems: items }),
  );
}

export function removeReceipt(receiptId: string): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applyRemoveReceipt(d, receiptId, now));
  void persist('remove receipt', before, () => api('DELETE', `/v1/receipts/${receiptId}`));
}

// Splits --------------------------------------------------------------------

/** Split a transaction. Returns an error message, or null when it worked. */
export function splitTransaction(
  transactionId: string,
  lines: readonly SplitLineInput[],
  idempotencyKey: string = newId('split'),
): string | null {
  const now = nowIso();
  const before = getFinance();
  const result = applySplit(before, transactionId, lines, idempotencyKey, now);
  if (result.error) return result.error;
  updateFinance(() => result.data);
  void persist(
    'split',
    before,
    () =>
      api<SplitResponse>('POST', `/v1/transactions/${transactionId}/split`, {
        lines,
        idempotencyKey,
      }),
    {
      onSaved: ({ parent, children }) => {
        // The backend's children replace the ones made on the phone (their ids differ).
        const local = getFinance()
          .transactions.filter((t) => t.splitParentId === transactionId)
          .map((t) => t.id);
        mergeTransactions(
          [parent, ...children],
          Object.fromEntries(
            local.filter((id) => !children.some((c) => c.id === id)).map((id) => [id, '']),
          ),
        );
      },
    },
  );
  return null;
}

export function undoSplit(transactionId: string): void {
  const now = nowIso();
  const before = getFinance();
  updateFinance((d) => applyUndoSplit(d, transactionId, now));
  void persist(
    'undo split',
    before,
    () => api('DELETE', `/v1/transactions/${transactionId}/split`),
    {
      refreshAfter: true,
    },
  );
}

// Cash ----------------------------------------------------------------------

/** Add a cash transaction. Returns the new transaction's id. */
export function addCashTransaction(
  entry: Omit<CashEntry, 'id' | 'now' | 'date'> & { date?: string },
): string {
  const id = newId('txn_cash');
  const now = nowIso();
  const before = getFinance();
  const date = entry.date ?? todayLocal();
  updateFinance((d) => applyAddCash(d, { ...entry, id, now, date }));
  const account = before.accounts.find((a) => a.id === entry.accountId);
  if (account) {
    void persist(
      'cash',
      before,
      () =>
        api<CashResponse>('POST', '/v1/cash', {
          amount: entry.direction === 'expense' ? -entry.amount : entry.amount,
          currency: account.currency,
          categoryId: entry.categoryId,
          name: entry.note?.trim() || undefined,
          date,
          accountId: account.id,
        }),
      {
        onSaved: ({ transaction }) => mergeTransactions([transaction], { [id]: transaction.id }),
        refreshAfter: true,
      },
    );
  }
  return id;
}

// Deleting a hand-entered cash entry -------------------------------------------

export type CashDeleteOutcome =
  | { kind: 'deleted'; text: string; receipts: number }
  /** Nothing was deleted; `text` says why. */
  | { kind: 'refused'; text: string }
  /** The answer was lost and the check after it failed: check again before anything else. */
  | { kind: 'unsure'; text: string };

const txnPath = (id: string) => `/v1/transactions/${encodeURIComponent(id)}`;

/** Receipts that pointed at the entry; the Worker keeps them, waiting for a transaction. */
const receiptsOf = (id: string) =>
  getFinance().receipts.filter((r) => r.matchedTransactionId === id).length;

function dropCashEntry(id: string, account: Account | null): void {
  if (canSaveToBackend()) updateFinance((d) => applyCashDelete(d, id, account, nowIso()));
  scheduleRefresh();
}

/**
 * DELETE /v1/transactions/:id. Waits for the Worker; nothing changes on screen
 * before it answers. After a lost answer the entry is read again
 * (checkCashDeleted); the delete is never sent again by itself. Null when the
 * backend changed meanwhile.
 */
export async function deleteCashEntry(id: string): Promise<CashDeleteOutcome | null> {
  const receipts = receiptsOf(id);
  try {
    const res = await api<CashTransactionDeleteResponse>('DELETE', txnPath(id));
    dropCashEntry(id, res.account);
    return {
      kind: 'deleted',
      text: `Deleted. ${reversedText(res.reversedBalanceAmount, res.account)}`,
      receipts,
    };
  } catch (e) {
    if (isSuperseded(e)) return null;
    if (e instanceof BackendError && e.status === 404) {
      dropCashEntry(id, null);
      return { kind: 'deleted', text: 'This entry is no longer on your Worker.', receipts };
    }
    if (e instanceof BackendError && (e.offline || e.status >= 500))
      return checkCashDeleted(id, receipts);
    if (e instanceof BackendError && e.status === 409) {
      if (e.code === 'account_changed') scheduleRefresh();
      return { kind: 'refused', text: cashDeleteErrorText(e.code) ?? errorText(e) };
    }
    return { kind: 'refused', text: errorText(e) };
  }
}

/** After a lost answer: GET the entry. 404 means it is gone; otherwise it was not deleted. */
export async function checkCashDeleted(
  id: string,
  receipts = receiptsOf(id),
): Promise<CashDeleteOutcome | null> {
  try {
    await api<TransactionResponse>('GET', txnPath(id));
    return {
      kind: 'refused',
      text: "Your Worker's answer was lost, and the entry is still there, so it was not deleted. Try again if you still want to delete it.",
    };
  } catch (e) {
    if (isSuperseded(e)) return null;
    if (e instanceof BackendError && e.status === 404) {
      dropCashEntry(id, null);
      return {
        kind: 'deleted',
        text: "Deleted. Your Worker's answer was lost, so how far the cash balance moved is not known here. Pull down on Accounts to see the balance.",
        receipts,
      };
    }
    return {
      kind: 'unsure',
      text: `Your Worker did not answer, so it is not known whether the entry was deleted. Check again before doing anything else. ${errorText(e)}`,
    };
  }
}

// Attaching a receipt that is already on the Worker --------------------------

export type AttachOutcome =
  | { kind: 'attached'; receipt: Receipt }
  | { kind: 'refused'; text: string }
  | { kind: 'unsure'; text: string };

/** The Worker's receipt replaces the app's copy; the transaction points at it. */
function putAttached(receipt: Receipt): void {
  if (!canSaveToBackend()) return;
  const now = nowIso();
  updateFinance((d) => ({
    ...d,
    receipts: d.receipts.map((r) =>
      r.id === receipt.id ? { ...receipt, localUri: r.localUri ?? receipt.localUri } : r,
    ),
    transactions: d.transactions.map((t) =>
      t.id === receipt.matchedTransactionId
        ? { ...t, receiptId: receipt.id, updatedAt: now }
        : t.receiptId === receipt.id
          ? { ...t, receiptId: null, updatedAt: now }
          : t,
    ),
  }));
  scheduleRefresh();
}

/**
 * POST /v1/receipts/:id/attach. Waits for the Worker. On 409 account_changed
 * (the transaction went away meanwhile) or 404 the data is loaded again and
 * nothing is attached. After a lost answer the data is loaded again first and
 * the receipt is checked; the request is never sent again by itself. Null
 * when the backend changed meanwhile.
 */
export async function attachReceiptOnWorker(
  receiptId: string,
  transactionId: string,
): Promise<AttachOutcome | null> {
  try {
    const body: ReceiptAttachRequest = { transactionId };
    const { receipt } = await api<ReceiptAttachResponse>(
      'POST',
      `/v1/receipts/${encodeURIComponent(receiptId)}/attach`,
      body,
    );
    putAttached(receipt);
    return { kind: 'attached', receipt };
  } catch (e) {
    if (isSuperseded(e)) return null;
    if (e instanceof BackendError && e.status === 409 && e.code === 'account_changed') {
      void refreshDataset();
      return {
        kind: 'refused',
        text: 'That transaction was deleted while the receipt was being attached, so nothing was attached. The list is being loaded again; pick another transaction.',
      };
    }
    if (e instanceof BackendError && e.status === 404) {
      void refreshDataset();
      return {
        kind: 'refused',
        text: 'Your Worker no longer has this receipt or that transaction, so nothing was attached. The list is being loaded again.',
      };
    }
    if (e instanceof BackendError && (e.offline || e.status >= 500))
      return checkAttached(receiptId, transactionId);
    return { kind: 'refused', text: errorText(e) };
  }
}

/** After a lost answer: load the data again and see where the receipt is now. */
export async function checkAttached(
  receiptId: string,
  transactionId: string,
): Promise<AttachOutcome | null> {
  const loaded = await refreshDataset();
  if (!loaded)
    return {
      kind: 'unsure',
      text: 'Your Worker did not answer, so it is not known whether the receipt was attached. Check again before doing anything else.',
    };
  const receipt = getFinance().receipts.find((r) => r.id === receiptId);
  if (receipt?.matchedTransactionId === transactionId && receipt.status === 'matched')
    return { kind: 'attached', receipt };
  return {
    kind: 'refused',
    text: "Your Worker's answer was lost and the receipt was not attached. Pick the transaction again if you still want it.",
  };
}

// Uploading a receipt photo with no transaction, then its likely purchases ---

export type ReceiptUploadOutcome =
  /** The Worker stored it; `response` carries its match and candidates. */
  | { kind: 'uploaded'; response: ReceiptResponse }
  /** Nothing was stored; `text` says why. */
  | { kind: 'refused'; text: string }
  /**
   * The answer was lost. `found` is a receipt that appeared on the Worker
   * while this was sent (most likely this one), or null.
   */
  | { kind: 'unsure'; text: string; found: Receipt | null };

/** The Worker's receipt goes into the app's data; a purchase it matched points at it. */
function putUploaded(receipt: Receipt, localUri: string): void {
  const now = nowIso();
  updateFinance((d) => ({
    ...d,
    receipts: [...d.receipts.filter((r) => r.id !== receipt.id), { ...receipt, localUri }],
    transactions: d.transactions.map((t) =>
      t.id === receipt.matchedTransactionId
        ? { ...t, receiptId: receipt.id, updatedAt: now }
        : t.receiptId === receipt.id
          ? { ...t, receiptId: null, updatedAt: now }
          : t,
    ),
  }));
}

/**
 * POST /v1/receipts without a transaction, waiting for the Worker's answer so
 * its match and likely purchases can be shown. Sent once: after a lost answer
 * the data is loaded again to see whether a new receipt arrived, and nothing
 * is sent again by itself. Null when the backend changed meanwhile.
 */
export async function uploadReceiptForMatches(
  localUri: string,
): Promise<ReceiptUploadOutcome | null> {
  const before = new Set(getFinance().receipts.map((r) => r.id));
  let form: FormData;
  try {
    form = await fileForm(localUri, 'receipt.jpg', imageTypeOf(localUri));
  } catch {
    return {
      kind: 'refused',
      text: 'The photo could not be read on this device, so nothing was sent.',
    };
  }
  try {
    const response = await api<ReceiptResponse>('POST', '/v1/receipts', form, {
      timeoutMs: 90_000,
    });
    if (canSaveToBackend()) {
      rememberReceiptUri(response.receipt.id, localUri);
      putUploaded(response.receipt, localUri);
    }
    scheduleRefresh();
    return { kind: 'uploaded', response };
  } catch (e) {
    if (isSuperseded(e)) return null;
    if (e instanceof BackendError && (e.offline || e.status >= 500)) {
      const loaded = await refreshDataset();
      if (!loaded)
        return {
          kind: 'unsure',
          found: null,
          text: "Your Worker's answer was lost and your data could not be loaded again, so it is not known whether the receipt was stored. Nothing was sent again. Look in Receipts to attach before sharing it again.",
        };
      const fresh = getFinance().receipts.filter((r) => !before.has(r.id));
      if (fresh.length === 1)
        return {
          kind: 'unsure',
          found: fresh[0]!,
          text: 'Your Worker stored the receipt, but its answer with the likely purchases was lost. Nothing was sent again.',
        };
      return {
        kind: 'unsure',
        found: null,
        text: "Your Worker's answer was lost and the receipt is not in your data yet. Nothing was sent again. Your Worker may still be reading it: if it is not in Receipts to attach in a minute, share it again.",
      };
    }
    return { kind: 'refused', text: `The receipt was not stored. ${errorText(e)}` };
  }
}
