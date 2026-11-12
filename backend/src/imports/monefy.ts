import {
  detectDateFormat,
  emptyRow,
  parseAmountText,
  parseCsvTable,
  parseDateWithFormat,
  type ParseResult,
  type ParsedAccount,
} from '@manaclaude/shared';
import { sha256Hex } from '../util/ids';

const HEADERS = [
  'date',
  'account',
  'category',
  'amount',
  'currency',
  'converted amount',
  'currency',
  'description',
];

export function isMonefyCsv(text: string): boolean {
  const header = parseCsvTable(text, ',')[0] ?? [];
  return (
    header.length === HEADERS.length &&
    header.every((cell, i) => cell.trim().toLowerCase() === HEADERS[i])
  );
}

// The shared date parser already supports slash-separated two-digit years.
function dateText(value: string): string {
  return value.trim().replace(/^(\d{1,2})-(\d{1,2})-(\d{2})$/, '$1/$2/$3');
}

/** Positional columns matter: the two currency headers refer to different amounts. */
export async function parseMonefyCsv(text: string, preferDayFirst?: boolean): Promise<ParseResult> {
  const body = parseCsvTable(text, ',').slice(1);
  const dates = body.map((row) => dateText(row[0] ?? ''));
  // Invalid rows must not prevent otherwise valid rows from appearing in the preview.
  const validDates = dates.filter((value) => detectDateFormat([value]).format !== null);
  const detection = detectDateFormat(validDates, { preferDayFirst });
  const result: ParseResult = {
    format: 'csv',
    rows: [],
    accounts: [],
    errors: [],
    warnings: [
      'Monefy: original amounts are imported once. Converted amounts are retained in notes; they are not additional transactions.',
      'New Monefy accounts are history-only accounts with unknown balances, excluded from net worth. Map them to existing accounts when appropriate.',
    ],
    dateFormat: detection.format,
    dateFormatAmbiguous: detection.ambiguous,
  };
  if (detection.ambiguous) {
    result.warnings.push(
      `Monefy dates are ambiguous; preview uses ${detection.format}. Confirm day-first or month-first before saving.`,
    );
  }
  const accounts = new Map<string, ParsedAccount>();
  const occurrences = new Map<string, number>();
  for (const [index, cells] of body.entries()) {
    const line = index + 2;
    const fail = (message: string) => result.errors.push({ line, message });
    if (cells.length !== HEADERS.length) {
      fail('Expected all eight Monefy columns.');
      continue;
    }
    const [rawDate, account, category, rawAmount, rawCurrency, converted, rawConvertedCurrency] =
      cells.map((cell) => cell.trim());
    const description = cells[7]!;
    const date = detection.format
      ? parseDateWithFormat(dateText(rawDate!), detection.format)
      : null;
    const currency = rawCurrency!.toUpperCase();
    const convertedCurrency = rawConvertedCurrency!.toUpperCase();
    if (!date) {
      fail('Cannot read this Monefy date consistently with the rest of the file.');
      continue;
    }
    if (!account || !category || !/^[A-Z]{3}$/.test(currency)) {
      fail('Monefy rows need an account, category and three-letter original currency.');
      continue;
    }
    // A transfer export needs its own verified pairing contract; do not invent an expense.
    if (/^transfer(?:\s|$)/i.test(category)) {
      fail('Monefy transfer rows need transfer mapping before they can be imported.');
      continue;
    }
    const amount = /^[+-]?\d+(?:\.\d+)?$/.test(rawAmount!)
      ? parseAmountText(rawAmount!, currency)
      : null;
    if (amount === null || !Number.isSafeInteger(amount)) {
      fail('Cannot read the original Monefy amount.');
      continue;
    }
    if (
      !/^[A-Z]{3}$/.test(convertedCurrency) ||
      !/^[+-]?\d+(?:\.\d+)?$/.test(converted!) ||
      !Number.isSafeInteger(parseAmountText(converted!, convertedCurrency))
    ) {
      fail('Cannot read the converted Monefy amount or currency.');
      continue;
    }
    const prior = accounts.get(account);
    if (prior && prior.currency !== currency) {
      fail('One Monefy account name uses multiple currencies; separate those accounts first.');
      continue;
    }
    accounts.set(account, {
      name: account,
      type: 'other_asset',
      currency,
      mask: null,
      balance: null,
      balanceDate: null,
    });
    const row = emptyRow(line, date, amount);
    row.accountName = account;
    row.currency = currency;
    row.categoryName = category;
    row.rawName = description.trim() || category;
    row.notes = `${description}${description ? '\n\n' : ''}Monefy category: ${category}\nMonefy converted amount: ${converted} ${convertedCurrency}`;
    // Export order and current conversion rates can change. Keep identical-row
    // multiplicity, Unicode and category distinctions; exclude converted amounts.
    const identity = JSON.stringify([account, date, amount, currency, category, description]);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    row.externalId = `monefy:${await sha256Hex(new TextEncoder().encode(`${identity}|${occurrence}`))}`;
    result.rows.push(row);
  }
  result.accounts = [...accounts.values()];
  return result;
}
