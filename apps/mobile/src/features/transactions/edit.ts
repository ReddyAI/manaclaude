import {
  minorDigits,
  parseMoneyInput,
  type Tag,
  type Transaction,
  type TransactionKind,
  type TransactionPatchRequest,
} from '@manaclaude/shared';

/**
 * The edit form for one transaction and how it becomes a PATCH
 * /v1/transactions/:id body. Only fields that changed are sent, because the
 * Worker marks every field it receives as edited by hand: syncs, imports,
 * rules and the AI never change that field again.
 *
 * Category and reviewed have their own controls on the detail sheet and are
 * not part of this form. The Worker refuses a new amount on a split or a
 * linked transfer; the form does not offer it there.
 */

export const NAME_MAX = 200;
export const NOTES_MAX = 2000;

export const KIND_OPTIONS: { kind: TransactionKind; label: string }[] = [
  { kind: 'regular', label: 'Regular' },
  { kind: 'transfer', label: 'Transfer between my accounts' },
  { kind: 'card_payment', label: 'Card payment' },
  { kind: 'loan_payment', label: 'Loan payment' },
  { kind: 'investment_contribution', label: 'Investment contribution' },
];

export function kindLabel(kind: TransactionKind): string {
  return KIND_OPTIONS.find((k) => k.kind === kind)?.label ?? kind;
}

export interface EditDraft {
  name: string;
  /** "YYYY-MM-DD" as typed. */
  date: string;
  /** The size of the amount as typed, without a sign. */
  amount: string;
  direction: 'out' | 'in';
  notes: string;
  kind: TransactionKind;
  tagIds: string[];
  excluded: boolean;
}

/** What may be changed on this transaction, and why not when it may not. */
export interface EditLocks {
  /** Only name and notes (a split's whole, whose parts carry the rest). */
  splitWhole: boolean;
  amount: string | null;
  kind: string | null;
}

export function editLocks(txn: Transaction): EditLocks {
  if (txn.isSplitParent)
    return {
      splitWhole: true,
      amount: 'This transaction is split. Change its parts, or undo the split first.',
      kind: 'This transaction is split. Change its parts instead.',
    };
  if (txn.splitParentId)
    return {
      splitWhole: false,
      amount: 'This is part of a split. Undo the split to change amounts.',
      kind: null,
    };
  if (txn.transferLinkId)
    return {
      splitWhole: false,
      amount: 'This is a linked transfer. Unlink it to change the amount.',
      kind: 'This is a linked transfer, so it already counts as one. Unlink it to change its kind.',
    };
  return { splitWhole: false, amount: null, kind: null };
}

/** Minor units as plain text in the currency's own decimals: 123456 USD is "1234.56". */
export function amountText(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const size = Math.abs(minor);
  if (digits === 0) return String(size);
  const whole = Math.floor(size / 10 ** digits);
  const frac = String(size % 10 ** digits).padStart(digits, '0');
  return `${whole}.${frac}`;
}

export function draftFrom(txn: Transaction): EditDraft {
  return {
    name: txn.name,
    date: txn.date,
    amount: amountText(txn.amount, txn.currency),
    direction: txn.amount < 0 ? 'out' : 'in',
    notes: txn.notes ?? '',
    kind: txn.kind,
    tagIds: [...txn.tagIds],
    excluded: txn.excluded,
  };
}

/** True for a real calendar day written as YYYY-MM-DD. */
export function isRealDate(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export interface EditCheck {
  /** Only the changed fields; empty when nothing changed. Null while a field has a problem. */
  patch: TransactionPatchRequest | null;
  problems: Partial<Record<'name' | 'date' | 'amount' | 'notes', string>>;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

export function checkEdit(
  txn: Transaction,
  draft: EditDraft,
  today: string,
  tags: readonly Tag[],
): EditCheck {
  const locks = editLocks(txn);
  const problems: EditCheck['problems'] = {};
  const patch: TransactionPatchRequest = {};

  const name = draft.name.trim();
  if (!name) problems.name = 'Type a name.';
  else if (name.length > NAME_MAX)
    problems.name = `Use at most ${NAME_MAX} characters (${name.length} now).`;
  else if (name !== txn.name) patch.name = name;

  const notes = draft.notes.trim();
  if (notes.length > NOTES_MAX)
    problems.notes = `Use at most ${NOTES_MAX} characters (${notes.length} now).`;
  else if ((notes || null) !== (txn.notes || null)) patch.notes = notes || null;

  if (!locks.splitWhole) {
    const date = draft.date.trim();
    if (!isRealDate(date)) problems.date = 'Use a real date written as YYYY-MM-DD.';
    else if (date > today) problems.date = 'The date is after today.';
    else if (date !== txn.date) patch.date = date;

    if (!locks.amount) {
      const size = draft.amount.trim() ? parseMoneyInput(draft.amount, txn.currency) : null;
      if (size === null)
        problems.amount = `Type the amount as a number with at most ${minorDigits(txn.currency)} decimals.`;
      else if (size < 0)
        problems.amount = 'Type the amount without a sign and pick money out or in.';
      else if (size === 0) problems.amount = 'The amount cannot be zero.';
      else {
        const signed = draft.direction === 'out' ? -size : size;
        if (signed !== txn.amount) patch.amount = signed;
      }
    }

    if (!locks.kind && draft.kind !== txn.kind) patch.kind = draft.kind;
    if (draft.excluded !== txn.excluded) patch.excluded = draft.excluded;
    if (!sameSet(draft.tagIds, txn.tagIds)) {
      // Tags in the order the app lists them; any the device does not know stay as they were.
      const known = tags.map((t) => t.id).filter((id) => draft.tagIds.includes(id));
      const unknown = txn.tagIds.filter((id) => !tags.some((t) => t.id === id));
      patch.tagIds = [...known, ...unknown];
    }
  }

  return { patch: Object.keys(problems).length > 0 ? null : patch, problems };
}

/** The transaction as it will look once the Worker has the patch: the fields, and each marked as edited. */
export function applyEdit(
  txn: Transaction,
  patch: TransactionPatchRequest,
  now: string,
): Transaction {
  const fields = Object.keys(patch).filter(
    (k) => k !== 'reviewed',
  ) as (keyof TransactionPatchRequest)[];
  if (fields.length === 0) return txn;
  const edited = [...txn.userEditedFields];
  for (const f of fields)
    if (!edited.includes(f as never)) edited.push(f as Transaction['userEditedFields'][number]);
  return {
    ...txn,
    ...patch,
    ...('amount' in patch && txn.originalCurrency === txn.currency
      ? { originalAmount: patch.amount! }
      : {}),
    userEditedFields: edited,
    updatedAt: now,
  } as Transaction;
}
