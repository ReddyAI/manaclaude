import type { CurrencyCode } from '../model/common';
import type { AccountType } from '../model/account';
import { parseAmountText } from './amount';
import { detectDateFormat, parseDateWithFormat } from './dates';
import { emptyRow, type ParseResult, type ParsedAccount, type ParsedImportRow } from './types';

const QIF_ACCOUNT_TYPES: Record<string, AccountType> = {
  bank: 'checking',
  cash: 'cash',
  ccard: 'credit_card',
  invst: 'brokerage',
  'oth a': 'other_asset',
  'oth l': 'other_liability',
};

/** QIF writes 1/5'26 for 2026-01-05. Normalise to slashes. */
function normaliseQifDate(raw: string): string {
  return raw.trim().replace(/'/g, '/').replace(/\s+/g, '');
}

interface RawRecord {
  line: number;
  fields: [string, string][];
  account: string | null;
}

/**
 * Reads a QIF file, including split lines (S category, E memo, $ amount) and
 * transfers written as a category in brackets ("[Savings]"). Amounts in QIF are
 * already signed from the account's side.
 */
export function parseQif(
  text: string,
  options: { currency: CurrencyCode; preferDayFirst?: boolean },
): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const records: RawRecord[] = [];
  const accounts: ParsedAccount[] = [];
  let current: RawRecord | null = null;
  let inAccountBlock = false;
  let pendingAccount: { name: string; type: AccountType | null } = { name: '', type: null };
  let activeAccount: string | null = null;
  let section: 'transactions' | 'other' = 'transactions';
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trimEnd();
    if (!line) return;
    if (line.startsWith('!')) {
      const header = line.toLowerCase();
      if (header === '!account') {
        inAccountBlock = true;
        pendingAccount = { name: '', type: null };
      } else if (header.startsWith('!type:')) {
        const t = header.slice(6).trim();
        section = ['cat', 'class', 'memorized', 'prices', 'security'].includes(t)
          ? 'other'
          : 'transactions';
        inAccountBlock = false;
      } else if (header.startsWith('!option') || header.startsWith('!clear')) {
        // ignore
      }
      return;
    }
    const code = line[0]!;
    const value = line.slice(1);
    if (inAccountBlock) {
      if (code === 'N') pendingAccount.name = value.trim();
      if (code === 'T') pendingAccount.type = QIF_ACCOUNT_TYPES[value.trim().toLowerCase()] ?? null;
      if (code === '^') {
        inAccountBlock = false;
        activeAccount = pendingAccount.name || null;
        if (activeAccount && !accounts.some((a) => a.name === activeAccount)) {
          accounts.push({
            name: activeAccount,
            type: pendingAccount.type,
            currency: options.currency,
            mask: null,
            balance: null,
            balanceDate: null,
          });
        }
      }
      return;
    }
    if (section === 'other') return;
    if (code === '^') {
      if (current) records.push(current);
      current = null;
      return;
    }
    current ??= { line: idx + 1, fields: [], account: activeAccount };
    current.fields.push([code, value]);
  });
  if (current) records.push(current);

  const dateValues = records.map(
    (r) => normaliseQifDate(r.fields.find(([c]) => c === 'D')?.[1] ?? ''),
  );
  const detection = detectDateFormat(dateValues, { preferDayFirst: options.preferDayFirst });
  const format = detection.format;
  const rows: ParsedImportRow[] = [];
  const errors: ParseResult['errors'] = [];
  for (const rec of records) {
    const get = (c: string) => rec.fields.find(([k]) => k === c)?.[1]?.trim() ?? '';
    const date = format ? parseDateWithFormat(normaliseQifDate(get('D')), format) : null;
    const amount = parseAmountText(get('T') || get('U'), options.currency);
    if (!date || amount === null) {
      errors.push({ line: rec.line, message: 'Missing or unreadable date or amount.' });
      continue;
    }
    const row = emptyRow(rec.line, date, amount);
    row.rawName = get('P') || get('M');
    row.notes = get('P') && get('M') ? get('M') : null;
    row.accountName = rec.account;
    const category = get('L');
    if (/^\[.*\]$/.test(category)) {
      row.transferHint = true;
      row.kindHint = 'transfer';
    } else {
      row.categoryName = category ? (category.split('/')[0] ?? '').trim() || null : null;
    }
    // Split lines: S (category), E (memo), $ (amount), in that order.
    let split: { categoryName: string | null; memo: string | null } | null = null;
    for (const [c, v] of rec.fields) {
      if (c === 'S') {
        split = { categoryName: v.trim() || null, memo: null };
      } else if (c === 'E' && split) {
        split.memo = v.trim() || null;
      } else if (c === '$' && split) {
        const splitAmount = parseAmountText(v, options.currency);
        if (splitAmount !== null) {
          const cat = split.categoryName;
          row.splits.push({
            amount: splitAmount,
            categoryName: cat && /^\[.*\]$/.test(cat) ? null : cat,
            memo: split.memo,
          });
        }
        split = null;
      }
    }
    if (row.splits.length > 0) {
      const total = row.splits.reduce((s, l) => s + l.amount, 0);
      if (total !== row.amount) {
        errors.push({
          line: rec.line,
          message: `Split lines add up to ${total} but the transaction is ${row.amount}; splits dropped.`,
        });
        row.splits = [];
      }
    }
    rows.push(row);
  }
  return {
    format: 'qif',
    rows,
    accounts,
    errors,
    warnings: detection.ambiguous ? ['Dates fit more than one format; check them in the preview.'] : [],
    dateFormat: format,
    dateFormatAmbiguous: detection.ambiguous,
  };
}
