import type { AccountType } from '../model/account';
import { parseAmountText } from './amount';
import { parseDateWithFormat } from './dates';
import { emptyRow, type ParseResult, type ParsedAccount, type ParsedImportRow } from './types';

/** Value of an OFX tag in SGML (<TAG>value) or XML (<TAG>value</TAG>) form. */
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? decodeEntities(m[1]!.trim()) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function blocks(text: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)(?=</${name}>|<${name}>|$)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]!.trim()) out.push(m[1]!);
  }
  return out;
}

const OFX_ACCOUNT_TYPES: Record<string, AccountType> = {
  CHECKING: 'checking',
  SAVINGS: 'savings',
  MONEYMRKT: 'savings',
  CREDITLINE: 'credit_card',
  CD: 'savings',
};

function maskOf(acctId: string | null): string | null {
  if (!acctId) return null;
  const digits = acctId.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Reads OFX 1.x (SGML) and 2.x (XML) bank and card statements. FITID is the
 * stable id, so re-imports match on it. Only the last four digits of the
 * account number are kept.
 */
export function parseOfx(text: string): ParseResult {
  const rows: ParsedImportRow[] = [];
  const accounts: ParsedAccount[] = [];
  const errors: ParseResult['errors'] = [];
  const statements = [
    ...blocks(text, 'STMTRS').map((b) => ({ b, card: false })),
    ...blocks(text, 'CCSTMTRS').map((b) => ({ b, card: true })),
  ];
  let record = 0;
  for (const { b, card } of statements) {
    const currency = (tag(b, 'CURDEF') ?? 'USD').toUpperCase();
    const acctId = tag(b, 'ACCTID');
    const type = card ? 'credit_card' : (OFX_ACCOUNT_TYPES[(tag(b, 'ACCTTYPE') ?? '').toUpperCase()] ?? 'checking');
    const mask = maskOf(acctId);
    const name = `${card ? 'Card' : type === 'savings' ? 'Savings' : 'Checking'}${mask ? ` ••${mask}` : ''}`;
    const ledger = blocks(b, 'LEDGERBAL')[0];
    const balanceRaw = ledger ? tag(ledger, 'BALAMT') : null;
    const balanceSigned = balanceRaw ? parseAmountText(balanceRaw, currency) : null;
    accounts.push({
      name,
      type,
      currency,
      mask,
      // OFX card balances are negative when you owe; the model stores what you owe as positive.
      balance: balanceSigned === null ? null : card ? -balanceSigned : balanceSigned,
      balanceDate: ledger ? parseDateWithFormat(tag(ledger, 'DTASOF') ?? '', 'YYYYMMDD') : null,
    });
    for (const t of blocks(b, 'STMTTRN')) {
      record += 1;
      const date = parseDateWithFormat(tag(t, 'DTPOSTED') ?? tag(t, 'DTUSER') ?? '', 'YYYYMMDD');
      const amount = parseAmountText(tag(t, 'TRNAMT') ?? '', currency);
      if (!date || amount === null) {
        errors.push({ line: record, message: 'Transaction without a date or amount.' });
        continue;
      }
      const row = emptyRow(record, date, amount);
      row.currency = currency;
      row.externalId = tag(t, 'FITID');
      const nameValue = tag(t, 'NAME') ?? tag(t, 'PAYEE') ?? '';
      const memo = tag(t, 'MEMO');
      row.rawName = nameValue || memo || '';
      row.notes = nameValue && memo ? memo : null;
      row.accountName = name;
      const trnType = (tag(t, 'TRNTYPE') ?? '').toUpperCase();
      if (trnType === 'XFER') {
        row.transferHint = true;
        row.kindHint = 'transfer';
      }
      rows.push(row);
    }
  }
  if (statements.length === 0) errors.push({ line: 0, message: 'No bank or card statement found in this OFX file.' });
  return {
    format: 'ofx',
    rows,
    accounts,
    errors,
    warnings: [],
    dateFormat: 'YYYYMMDD',
    dateFormatAmbiguous: false,
  };
}
