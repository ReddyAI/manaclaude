import {
  daysBetween,
  parseDateWithFormat,
  type Account,
  type ImportPreview,
  type ImportPreviewRow,
  type LocalDate,
  type Transaction,
} from '@manaclaude/shared';
import { selectAll } from '../db/table';
import { transactionsTable } from '../db/tables';
import { badRequest } from '../util/errors';

export interface DuplicateCandidate {
  line: number;
  transactionIds: string[];
}

/** Additive backend contract; mobile/shared adoption belongs to the next UI task. */
export interface SafeImportPreview extends ImportPreview {
  sourceFormat?: 'monefy';
  duplicateCandidates?: DuplicateCandidate[];
  dateRange?: { from: LocalDate | null; to: LocalDate | null; excluded: number };
  requiresDateConfirmation?: boolean;
}

export function validateDateRange(from?: string, to?: string): void {
  for (const value of [from, to]) {
    if (
      value !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !parseDateWithFormat(value, 'YYYY-MM-DD'))
    ) {
      throw badRequest('Import dates must be valid calendar dates in YYYY-MM-DD format.');
    }
  }
  if (from && to && from > to) throw badRequest('The import start date is after its end date.');
}

export function requireCurrency(row: ImportPreviewRow, account: Account): void {
  if (row.currency && row.currency !== account.currency) {
    throw badRequest(
      `Line ${row.line} uses ${row.currency}, but its destination uses ${account.currency}. Choose an account in the original currency; importing does not convert money.`,
      'import_currency_mismatch',
    );
  }
}

/** One bounded query for all destinations, including split parents but not children. */
export async function existingForRows(
  db: D1Database,
  rows: readonly ImportPreviewRow[],
): Promise<Transaction[]> {
  const ids = [...new Set(rows.flatMap((r) => (r.accountId ? [r.accountId] : [])))];
  if (!ids.length || !rows.length) return [];
  const dates = rows.map((r) => r.date).sort();
  return selectAll(
    db,
    transactionsTable,
    "account_id IN (SELECT value FROM json_each(?)) AND split_parent_id IS NULL AND date >= date(?, '-3 days') AND date <= date(?, '+3 days')",
    [JSON.stringify(ids), dates[0]!, dates[dates.length - 1]!],
  );
}

export function sameImportIdentity(row: ImportPreviewRow, txn: Transaction): boolean {
  if (row.accountId !== txn.accountId) return false;
  return Boolean(
    (row.externalId && txn.source === 'import' && row.externalId === txn.externalId) ||
    (row.fingerprint && row.fingerprint === txn.importFingerprint),
  );
}

/** Similarity is a review candidate, never evidence to silently discard a row. */
export function duplicateCandidates(
  rows: readonly ImportPreviewRow[],
  existing: readonly Transaction[],
  accounts: ReadonlyMap<string, Account>,
): DuplicateCandidate[] {
  return rows.flatMap((row) => {
    if (row.decision !== 'new' || !row.accountId) return [];
    if (existing.some((t) => sameImportIdentity(row, t))) return [];
    const currency = row.currency ?? accounts.get(row.accountId)?.currency;
    const transactionIds = existing
      .filter(
        (t) =>
          t.accountId === row.accountId &&
          t.currency === currency &&
          t.amount === row.amount &&
          !t.splitParentId &&
          Math.abs(daysBetween(t.date, row.date)) <= 3,
      )
      .map((t) => t.id);
    return transactionIds.length ? [{ line: row.line, transactionIds }] : [];
  });
}
