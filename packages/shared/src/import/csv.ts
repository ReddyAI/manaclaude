import type { CurrencyCode } from '../model/common';
import { detectDecimalSeparator, parseAmountText, type DecimalSeparator } from './amount';
import { detectDateFormat, parseDateWithFormat } from './dates';
import { emptyRow, type DateFormat, type ParseResult, type ParsedImportRow } from './types';

/** Splits CSV text into rows of cells (RFC 4180: quotes, doubled quotes, newlines in quotes). */
export function parseCsvTable(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Picks the delimiter that splits the first lines most consistently. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * How the columns of one bank's CSV map to transactions. Saved per header
 * signature so the next file from the same bank imports with no questions.
 */
export interface CsvMapping {
  delimiter: string;
  hasHeader: boolean;
  /** Lines to skip before the header (bank preamble). */
  skipRows: number;
  dateColumn: number;
  dateFormat: DateFormat;
  /** single: one signed column. debit_credit: money out and money in in separate columns. */
  amountMode: 'single' | 'debit_credit';
  amountColumn: number | null;
  debitColumn: number | null;
  creditColumn: number | null;
  /** Flip the sign of the single amount column (card exports that show purchases as positive). */
  invertSign: boolean;
  decimalSeparator: DecimalSeparator;
  descriptionColumn: number;
  notesColumn: number | null;
  categoryColumn: number | null;
  currencyColumn: number | null;
  idColumn: number | null;
}

/** Normalised header list. The backend saves mappings under this key. */
export function csvHeaderSignature(headers: readonly string[]): string {
  return headers
    .map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_'),
    )
    .join('|');
}

function findColumn(headers: readonly string[], patterns: RegExp[]): number | null {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h.trim().toLowerCase()));
    if (i >= 0) return i;
  }
  return null;
}

export interface MappingSuggestion {
  mapping: CsvMapping;
  headers: string[];
  /** Columns the guess could not find. The app asks for these. */
  missing: ('date' | 'amount' | 'description')[];
  dateFormatAmbiguous: boolean;
  dateFormatCandidates: DateFormat[];
}

/** Guesses a mapping from the header names and the first rows. */
export function suggestCsvMapping(
  text: string,
  options: { preferDayFirst?: boolean; skipRows?: number } = {},
): MappingSuggestion {
  const delimiter = detectDelimiter(text);
  const table = parseCsvTable(text, delimiter).slice(options.skipRows ?? 0);
  const headers = (table[0] ?? []).map((h) => h.trim());
  const body = table.slice(1, 200);
  const lower = headers.map((h) => h.toLowerCase());
  const dateColumn = findColumn(lower, [
    /^(transaction |txn |trans\.? |posting |posted |value )?date$/,
    /date/,
  ]);
  const debitColumn = findColumn(lower, [/^(debit|withdrawal|withdrawals|money out|paid out)/]);
  const creditColumn = findColumn(lower, [/^(credit|deposit|deposits|money in|paid in)/]);
  const amountColumn = findColumn(lower, [/^amount$/, /amount/, /^value$/]);
  const descriptionColumn = findColumn(lower, [
    /^(description|narration|details|payee|merchant|name|memo|particulars|transaction details)$/,
    /descr|narrat|payee|merchant|particular/,
  ]);
  const notesColumn = findColumn(lower, [/^(notes?|memo|remarks)$/]);
  const categoryColumn = findColumn(lower, [/^category$/, /category/]);
  const currencyColumn = findColumn(lower, [/^currency$/, /^ccy$/]);
  const idColumn = findColumn(lower, [/^(transaction id|txn id|reference|ref no\.?|id)$/]);

  const amountMode: CsvMapping['amountMode'] =
    debitColumn !== null && creditColumn !== null ? 'debit_credit' : 'single';
  const amountSamples = body
    .flatMap((r) =>
      amountMode === 'single'
        ? [r[amountColumn ?? -1] ?? '']
        : [r[debitColumn ?? -1] ?? '', r[creditColumn ?? -1] ?? ''],
    )
    .filter((v) => v.trim());
  const detection = detectDateFormat(
    body.map((r) => r[dateColumn ?? -1] ?? ''),
    { preferDayFirst: options.preferDayFirst },
  );
  const missing: MappingSuggestion['missing'] = [];
  if (dateColumn === null || !detection.format) missing.push('date');
  if (amountMode === 'single' && amountColumn === null) missing.push('amount');
  if (descriptionColumn === null) missing.push('description');
  return {
    headers,
    missing,
    dateFormatAmbiguous: detection.ambiguous,
    dateFormatCandidates: detection.candidates,
    mapping: {
      delimiter,
      hasHeader: true,
      skipRows: options.skipRows ?? 0,
      dateColumn: dateColumn ?? 0,
      dateFormat: detection.format ?? 'YYYY-MM-DD',
      amountMode,
      amountColumn: amountMode === 'single' ? (amountColumn ?? 1) : null,
      debitColumn: amountMode === 'debit_credit' ? debitColumn : null,
      creditColumn: amountMode === 'debit_credit' ? creditColumn : null,
      invertSign: false,
      decimalSeparator: detectDecimalSeparator(amountSamples),
      descriptionColumn: descriptionColumn ?? 2,
      notesColumn: notesColumn === descriptionColumn ? null : notesColumn,
      categoryColumn,
      currencyColumn,
      idColumn,
    },
  };
}

function cellAt(row: readonly string[], index: number | null): string {
  return index === null ? '' : (row[index] ?? '').trim();
}

/** Reads a CSV with a mapping. Bad rows are reported and skipped; the rest import. */
export function parseCsvWithMapping(
  text: string,
  mapping: CsvMapping,
  accountCurrency: CurrencyCode,
): ParseResult {
  const table = parseCsvTable(text, mapping.delimiter).slice(mapping.skipRows);
  const startLine = mapping.skipRows + (mapping.hasHeader ? 2 : 1);
  const body = mapping.hasHeader ? table.slice(1) : table;
  const rows: ParsedImportRow[] = [];
  const errors: ParseResult['errors'] = [];
  body.forEach((r, i) => {
    const line = startLine + i;
    const rawDate = cellAt(r, mapping.dateColumn);
    const date = parseDateWithFormat(rawDate, mapping.dateFormat);
    if (!date) {
      errors.push({ line, message: `Can't read the date "${rawDate}" as ${mapping.dateFormat}.` });
      return;
    }
    const currency = cellAt(r, mapping.currencyColumn).toUpperCase() || null;
    const cur = currency ?? accountCurrency;
    let amount: number | null;
    if (mapping.amountMode === 'single') {
      amount = parseAmountText(cellAt(r, mapping.amountColumn), cur, mapping.decimalSeparator);
      if (amount !== null && mapping.invertSign) amount = -amount;
    } else {
      const debit = parseAmountText(cellAt(r, mapping.debitColumn), cur, mapping.decimalSeparator);
      const credit = parseAmountText(
        cellAt(r, mapping.creditColumn),
        cur,
        mapping.decimalSeparator,
      );
      amount = debit === null && credit === null ? null : (credit ?? 0) - Math.abs(debit ?? 0);
    }
    if (amount === null) {
      errors.push({ line, message: 'No amount on this row.' });
      return;
    }
    const row = emptyRow(line, date, amount);
    row.currency = currency;
    row.rawName = cellAt(r, mapping.descriptionColumn);
    row.notes = cellAt(r, mapping.notesColumn) || null;
    row.categoryName = cellAt(r, mapping.categoryColumn) || null;
    row.externalId = cellAt(r, mapping.idColumn) || null;
    rows.push(row);
  });
  return {
    format: 'csv',
    rows,
    accounts: [],
    errors,
    warnings: [],
    dateFormat: mapping.dateFormat,
    dateFormatAmbiguous: false,
  };
}
