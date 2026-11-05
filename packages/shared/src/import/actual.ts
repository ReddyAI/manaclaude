import type { CurrencyCode } from '../model/common';
import { parseAmountText } from './amount';
import { parseCsvTable } from './csv';
import { detectDateFormat, parseDateWithFormat } from './dates';
import { emptyRow, type ParseResult, type ParsedAccount, type ParsedImportRow } from './types';

/**
 * Reads Actual Budget's transaction CSV export
 * (Account, Date, Payee, Notes, Category, Amount, Split_Amount, Cleared). Cleared is ignored.
 * A row with an empty Category followed by rows carrying Split_Amount for the
 * same account, date and payee is a split parent. "Transfer : X" payees are
 * transfers.
 */
export function parseActualCsv(text: string, options: { currency: CurrencyCode }): ParseResult {
  const table = parseCsvTable(text, ',');
  const headers = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => headers.indexOf(name);
  const iAccount = col('account');
  const iDate = col('date');
  const iPayee = col('payee');
  const iNotes = col('notes');
  const iCategory = col('category');
  const iAmount = col('amount');
  const iSplit = col('split_amount');
  const errors: ParseResult['errors'] = [];
  if (iDate < 0 || iAmount < 0) {
    return {
      format: 'actual_csv',
      rows: [],
      accounts: [],
      errors: [
        { line: 1, message: 'This is not an Actual Budget export (no Date or Amount column).' },
      ],
      warnings: [],
      dateFormat: null,
      dateFormatAmbiguous: false,
    };
  }
  const body = table.slice(1);
  const detection = detectDateFormat(body.map((r) => r[iDate] ?? ''));
  const format = detection.format ?? 'YYYY-MM-DD';
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const rows: ParsedImportRow[] = [];
  const accountNames = new Set<string>();
  let parent: ParsedImportRow | null = null;
  body.forEach((r, i) => {
    const line = i + 2;
    const date = parseDateWithFormat(cell(r, iDate), format);
    const splitText = cell(r, iSplit);
    const account = cell(r, iAccount) || null;
    const payee = cell(r, iPayee);
    if (
      splitText &&
      parent &&
      parent.date === date &&
      parent.accountName === account &&
      parent.rawName === payee
    ) {
      const amount = parseAmountText(splitText, options.currency);
      if (amount !== null) {
        parent.splits.push({
          amount,
          categoryName: cell(r, iCategory) || null,
          memo: cell(r, iNotes) || null,
        });
      }
      return;
    }
    const amount = parseAmountText(cell(r, iAmount), options.currency);
    if (!date || amount === null) {
      errors.push({ line, message: 'Missing or unreadable date or amount.' });
      return;
    }
    const row = emptyRow(line, date, amount);
    row.rawName = payee;
    row.notes = cell(r, iNotes) || null;
    row.categoryName = cell(r, iCategory) || null;
    row.accountName = account;
    if (/^transfer\s*:/i.test(payee)) {
      row.transferHint = true;
      row.kindHint = 'transfer';
    }
    if (account) accountNames.add(account);
    rows.push(row);
    parent = row.categoryName ? null : row;
  });
  for (const row of rows) {
    if (row.splits.length === 0) continue;
    const total = row.splits.reduce((s, l) => s + l.amount, 0);
    if (total !== row.amount) {
      errors.push({ line: row.line, message: 'Split amounts do not add up; splits dropped.' });
      row.splits = [];
    }
  }
  const accounts: ParsedAccount[] = [...accountNames].map((name) => ({
    name,
    type: null,
    currency: options.currency,
    mask: null,
    balance: null,
    balanceDate: null,
  }));
  return {
    format: 'actual_csv',
    rows,
    accounts,
    errors,
    warnings: detection.ambiguous
      ? ['Dates fit more than one format; check them in the preview.']
      : [],
    dateFormat: format,
    dateFormatAmbiguous: detection.ambiguous,
  };
}
