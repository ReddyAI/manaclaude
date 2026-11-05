import type { Id, IsoDateTime } from '../model/common';
import type { SplitLineInput, Transaction } from '../model/transaction';

export type SplitValidation = { ok: true } | { ok: false; error: string };

/**
 * Checks a split before anything is written (research/sure/rea.md SURE-002):
 * at least two lines, integer amounts with the parent's sign, and a total equal
 * to the parent amount exactly. Transfers, pending rows, existing parents and
 * children, and excluded rows can't be split.
 */
export function validateSplit(
  parent: Transaction,
  lines: readonly SplitLineInput[],
): SplitValidation {
  if (parent.isSplitParent) return { ok: false, error: 'This transaction is already split.' };
  if (parent.splitParentId) return { ok: false, error: 'A split line cannot be split again.' };
  if (parent.pending) return { ok: false, error: 'Wait until the transaction posts to split it.' };
  if (parent.excluded) return { ok: false, error: 'Excluded transactions cannot be split.' };
  if (parent.transferLinkId) return { ok: false, error: 'Linked transfers cannot be split.' };
  if (lines.length < 2) return { ok: false, error: 'A split needs at least two lines.' };
  let total = 0;
  for (const [i, line] of lines.entries()) {
    if (!Number.isSafeInteger(line.amount)) {
      return { ok: false, error: `Line ${i + 1} is not a whole number of minor units.` };
    }
    if (line.amount === 0) return { ok: false, error: `Line ${i + 1} is zero.` };
    if (Math.sign(line.amount) !== Math.sign(parent.amount)) {
      return { ok: false, error: `Line ${i + 1} has the wrong sign.` };
    }
    total += line.amount;
  }
  if (total !== parent.amount) {
    return {
      ok: false,
      error: `Lines add up to ${Math.abs(total)} but the transaction is ${Math.abs(parent.amount)} (minor units).`,
    };
  }
  return { ok: true };
}

/**
 * Builds the child transactions for a valid split. Pure: the caller writes the
 * parent update and the children in one database transaction.
 */
export function buildSplitChildren(
  parent: Transaction,
  lines: readonly SplitLineInput[],
  makeId: (index: number) => Id,
  now: IsoDateTime,
): { parent: Transaction; children: Transaction[] } {
  const check = validateSplit(parent, lines);
  if (!check.ok) throw new Error(check.error);
  const children = lines.map((line, i): Transaction => ({
    ...parent,
    id: makeId(i),
    amount: line.amount,
    originalAmount:
      parent.originalCurrency === parent.currency
        ? line.amount
        : Math.round((parent.originalAmount * line.amount) / parent.amount),
    name: line.name ?? parent.name,
    categoryId: line.categoryId,
    categorySource: 'user',
    aiCategoryConfidence: null,
    kind: line.kind ?? parent.kind,
    notes: line.notes ?? null,
    tagIds: line.tagIds ?? parent.tagIds,
    splitParentId: parent.id,
    isSplitParent: false,
    externalId: null,
    pendingExternalId: null,
    importFingerprint: null,
    receiptId: null,
    transferLinkId: null,
    createdAt: now,
    updatedAt: now,
  }));
  return { parent: { ...parent, isSplitParent: true, updatedAt: now }, children };
}
