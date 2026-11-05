import type { CurrencyCode, LocalDate, MinorUnits } from '../model/common';
import type { AccountType } from '../model/account';
import type { TransactionKind } from '../model/transaction';

/** File formats the backend can import. */
export type ImportFormat = 'csv' | 'qif' | 'ofx' | 'sure_ndjson' | 'actual_csv' | 'pdf';

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  'csv',
  'qif',
  'ofx',
  'sure_ndjson',
  'actual_csv',
  'pdf',
];

/** One split line inside a parsed row (QIF S/$ lines, Actual split rows). */
export interface ParsedSplitLine {
  /** Same sign rule as the parent: negative = money out. */
  amount: MinorUnits;
  categoryName: string | null;
  memo: string | null;
}

/**
 * One transaction read from a file, before it is matched to an account or
 * deduplicated. Amounts already follow the model's sign rule
 * (negative = money left the account).
 */
export interface ParsedImportRow {
  /** 1-based line or record number in the file, for error messages. */
  line: number;
  date: LocalDate;
  amount: MinorUnits;
  /** null when the file doesn't say; the account's currency is used. */
  currency: CurrencyCode | null;
  /** Description exactly as the file has it. */
  rawName: string;
  notes: string | null;
  /** Category label from the file (matched to categories by name). */
  categoryName: string | null;
  /** Stable id from the file (OFX FITID, Sure ids). Preferred over fingerprints. */
  externalId: string | null;
  /** Multi-account files (Sure, Actual, QIF with !Account) name the account per row. */
  accountName: string | null;
  tags: string[];
  splits: ParsedSplitLine[];
  /** The file marks this row as a transfer (QIF [Account] category, Actual "Transfer :" payee). */
  transferHint: boolean;
  kindHint: TransactionKind | null;
  pending: boolean;
}

/** Account named in a multi-account file. */
export interface ParsedAccount {
  name: string;
  type: AccountType | null;
  currency: CurrencyCode | null;
  /** Last four digits at most. Full account numbers are never kept. */
  mask: string | null;
  /** Statement closing balance when the file has one (OFX LEDGERBAL). */
  balance: MinorUnits | null;
  balanceDate: LocalDate | null;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  format: ImportFormat;
  rows: ParsedImportRow[];
  accounts: ParsedAccount[];
  /** Rows that could not be read. The rest of the file still imports. */
  errors: ParseIssue[];
  warnings: string[];
  /** Date format the parser used (detected or given). */
  dateFormat: DateFormat | null;
  /** True when more than one date format fits every date in the file. */
  dateFormatAmbiguous: boolean;
}

export type DateFormat =
  | 'YYYY-MM-DD'
  | 'YYYY/MM/DD'
  | 'YYYYMMDD'
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'MM-DD-YYYY'
  | 'DD-MM-YYYY'
  | 'DD.MM.YYYY'
  | 'MM/DD/YY'
  | 'DD/MM/YY'
  | 'DD-MMM-YYYY'
  | 'DD MMM YYYY'
  | 'MMM DD, YYYY'
  | 'DD-MMM-YY';

export function emptyRow(line: number, date: LocalDate, amount: MinorUnits): ParsedImportRow {
  return {
    line,
    date,
    amount,
    currency: null,
    rawName: '',
    notes: null,
    categoryName: null,
    externalId: null,
    accountName: null,
    tags: [],
    splits: [],
    transferHint: false,
    kindHint: null,
    pending: false,
  };
}
