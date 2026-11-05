import type { CurrencyCode, LocalDate, MinorUnits } from '../model/common';
import { parseAmountText } from './amount';
import { DATE_FORMATS, parseDateWithFormat } from './dates';
import { emptyRow, type ParseResult, type ParsedImportRow } from './types';

/**
 * What the AI is asked to return for a PDF statement. Amounts are strings so
 * the model never has to produce floats; the parser turns them into minor units.
 */
export interface AiStatementJson {
  accountName?: string | null;
  accountMask?: string | null;
  currency?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  openingBalance?: string | null;
  closingBalance?: string | null;
  transactions?: {
    date?: string | null;
    description?: string | null;
    /** Signed: negative = money out of the account. */
    amount?: string | null;
    /** Some statements give separate columns; either form is accepted. */
    debit?: string | null;
    credit?: string | null;
    balance?: string | null;
  }[];
}

export interface StatementCheck {
  openingBalance: MinorUnits | null;
  closingBalance: MinorUnits | null;
  /** opening + sum of rows; compare with closing. */
  computedClosing: MinorUnits | null;
  /** True when opening + rows = closing exactly (or the statement gives no balances). */
  balances: boolean;
}

export interface ParsedStatement extends ParseResult {
  currency: CurrencyCode;
  periodStart: LocalDate | null;
  periodEnd: LocalDate | null;
  accountMask: string | null;
  check: StatementCheck;
}

function anyDate(raw: string | null | undefined, dayFirst: boolean): LocalDate | null {
  if (!raw) return null;
  const order = dayFirst
    ? [...DATE_FORMATS].sort((a, b) => Number(b.startsWith('DD')) - Number(a.startsWith('DD')))
    : DATE_FORMATS;
  for (const f of order) {
    const d = parseDateWithFormat(raw, f);
    if (d) return d;
  }
  return null;
}

/**
 * Turns the AI's JSON for a PDF statement into import rows and checks the
 * running balance (opening + rows = closing). Nothing is saved here: the app
 * shows this as a preview and the user confirms.
 */
export function normalizeAiStatement(
  json: AiStatementJson,
  fallbackCurrency: CurrencyCode,
): ParsedStatement {
  const currency = (json.currency ?? fallbackCurrency).toUpperCase().slice(0, 3) || fallbackCurrency;
  // Indian statements (INR) are day-first.
  const dayFirst = currency === 'INR';
  const rows: ParsedImportRow[] = [];
  const errors: ParseResult['errors'] = [];
  (json.transactions ?? []).forEach((t, i) => {
    const date = anyDate(t.date, dayFirst);
    let amount: number | null = t.amount ? parseAmountText(t.amount, currency) : null;
    if (amount === null && (t.debit || t.credit)) {
      const debit = t.debit ? parseAmountText(t.debit, currency) : null;
      const credit = t.credit ? parseAmountText(t.credit, currency) : null;
      amount = (credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (!date || amount === null) {
      errors.push({ line: i + 1, message: `Row ${i + 1}: missing date or amount.` });
      return;
    }
    const row = emptyRow(i + 1, date, amount);
    row.currency = currency;
    row.rawName = (t.description ?? '').trim();
    rows.push(row);
  });
  const opening = json.openingBalance ? parseAmountText(json.openingBalance, currency) : null;
  const closing = json.closingBalance ? parseAmountText(json.closingBalance, currency) : null;
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  const computedClosing = opening === null ? null : opening + sum;
  const balances = opening === null || closing === null ? true : computedClosing === closing;
  const mask = (json.accountMask ?? '').replace(/\D/g, '').slice(-4) || null;
  return {
    format: 'pdf',
    rows,
    accounts: json.accountName
      ? [{ name: json.accountName, type: null, currency, mask, balance: closing, balanceDate: anyDate(json.periodEnd, dayFirst) }]
      : [],
    errors,
    warnings: balances
      ? []
      : [
          `Opening balance plus these rows is ${computedClosing}, but the statement says ${closing}. Some rows may be missing or misread.`,
        ],
    dateFormat: null,
    dateFormatAmbiguous: false,
    currency,
    periodStart: anyDate(json.periodStart, dayFirst),
    periodEnd: anyDate(json.periodEnd, dayFirst),
    accountMask: mask,
    check: { openingBalance: opening, closingBalance: closing, computedClosing, balances },
  };
}
