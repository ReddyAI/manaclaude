import type { AccountType } from '../model/account';
import { parseAmountText } from './amount';
import { parseDateWithFormat } from './dates';
import { emptyRow, type ParseResult, type ParsedAccount, type ParsedImportRow } from './types';

type Json = Record<string, unknown>;

const SURE_ACCOUNT_TYPES: Record<string, AccountType> = {
  Depository: 'checking',
  CreditCard: 'credit_card',
  Investment: 'brokerage',
  Crypto: 'crypto',
  Property: 'property',
  Vehicle: 'vehicle',
  Loan: 'loan',
  OtherAsset: 'other_asset',
  OtherLiability: 'other_liability',
};

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * Reads Sure's NDJSON export (one `{"type": ..., "data": {...}}` object per
 * line: Account, Category, Tag, Merchant, Transaction). Sure stores entry
 * amounts with outflows positive, so the sign is flipped to this app's rule.
 * Unknown record types are counted and skipped.
 */
export function parseSureNdjson(text: string): ParseResult {
  const accountsById = new Map<string, ParsedAccount>();
  const categoryNames = new Map<string, string>();
  const tagNames = new Map<string, string>();
  const merchantNames = new Map<string, string>();
  const txnRecords: { line: number; data: Json }[] = [];
  const errors: ParseResult['errors'] = [];
  const skipped = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let obj: Json;
    try {
      obj = JSON.parse(line) as Json;
    } catch {
      errors.push({ line: i + 1, message: 'Not valid JSON.' });
      return;
    }
    const type = str(obj.type) ?? '';
    const data = (obj.data ?? obj) as Json;
    const id = str(data.id) ?? '';
    switch (type) {
      case 'Account': {
        const accountable = str(data.accountable_type) ?? str(data.type) ?? '';
        accountsById.set(id, {
          name: str(data.name) ?? 'Account',
          type: SURE_ACCOUNT_TYPES[accountable] ?? null,
          currency: str(data.currency)?.toUpperCase() ?? null,
          mask: null,
          balance: null,
          balanceDate: null,
        });
        break;
      }
      case 'Category':
        categoryNames.set(id, str(data.name) ?? '');
        break;
      case 'Tag':
        tagNames.set(id, str(data.name) ?? '');
        break;
      case 'Merchant':
        merchantNames.set(id, str(data.name) ?? '');
        break;
      case 'Transaction':
        txnRecords.push({ line: i + 1, data });
        break;
      default:
        skipped.set(type, (skipped.get(type) ?? 0) + 1);
    }
  });

  const rows: ParsedImportRow[] = [];
  for (const { line, data } of txnRecords) {
    const account = accountsById.get(str(data.account_id) ?? '');
    const currency = (str(data.currency) ?? account?.currency ?? 'USD').toUpperCase();
    const date = parseDateWithFormat(str(data.date) ?? '', 'YYYY-MM-DD');
    const sureAmount = parseAmountText(str(data.amount) ?? '', currency);
    if (!date || sureAmount === null) {
      errors.push({ line, message: 'Transaction without a date or amount.' });
      continue;
    }
    const row = emptyRow(line, date, -sureAmount);
    row.currency = currency;
    row.rawName = str(data.name) ?? merchantNames.get(str(data.merchant_id) ?? '') ?? '';
    row.notes = str(data.notes);
    row.categoryName = categoryNames.get(str(data.category_id) ?? '') ?? null;
    row.externalId = str(data.id) ? `sure:${str(data.id)}` : null;
    row.accountName = account?.name ?? null;
    row.tags = Array.isArray(data.tag_ids)
      ? data.tag_ids.map((t) => tagNames.get(String(t)) ?? '').filter(Boolean)
      : [];
    const kind = str(data.kind);
    if (kind === 'funds_movement') {
      row.transferHint = true;
      row.kindHint = 'transfer';
    } else if (kind === 'cc_payment') {
      row.transferHint = true;
      row.kindHint = 'card_payment';
    } else if (kind === 'loan_payment') {
      row.kindHint = 'loan_payment';
    }
    rows.push(row);
  }
  const warnings = [...skipped.entries()].map(
    ([type, n]) => `Skipped ${n} ${type || 'unknown'} record${n === 1 ? '' : 's'}.`,
  );
  return {
    format: 'sure_ndjson',
    rows,
    accounts: [...accountsById.values()],
    errors,
    warnings,
    dateFormat: 'YYYY-MM-DD',
    dateFormatAmbiguous: false,
  };
}
