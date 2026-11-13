import type { AccountType, DateFormat } from '@manaclaude/shared';

/** Plain names for account types on the import screen. */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  cash: 'Cash',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
  crypto: 'Crypto',
  loan: 'Loan',
  mortgage: 'Mortgage',
  property: 'Property',
  vehicle: 'Vehicle',
  other_asset: 'Other (history only)',
  other_liability: 'Other debt',
};

/** A date format with an example, using 31 December 2026 so day and month cannot be confused. */
export function dateFormatLabel(format: DateFormat): string {
  const example: Record<DateFormat, string> = {
    'YYYY-MM-DD': '2026-12-31',
    'YYYY/MM/DD': '2026/12/31',
    YYYYMMDD: '20261231',
    'MM/DD/YYYY': '12/31/2026',
    'DD/MM/YYYY': '31/12/2026',
    'MM-DD-YYYY': '12-31-2026',
    'DD-MM-YYYY': '31-12-2026',
    'DD.MM.YYYY': '31.12.2026',
    'MM/DD/YY': '12/31/26',
    'DD/MM/YY': '31/12/26',
    'DD-MMM-YYYY': '31-Dec-2026',
    'DD MMM YYYY': '31 Dec 2026',
    'MMM DD, YYYY': 'Dec 31, 2026',
    'DD-MMM-YY': '31-Dec-26',
  };
  const order = /^D/.test(format) ? 'Day first' : /^M/.test(format) ? 'Month first' : 'Year first';
  return `${order} (${example[format]})`;
}

const STATUS: Record<string, string> = {
  committed: 'Saved',
  undone: 'Undone',
  failed: 'Could not be read',
  committing: 'Saving',
  preview: 'Not saved',
  needs_mapping: 'Not saved',
  discarded: 'Cancelled',
};

export function importStatusLabel(status: string): string {
  return STATUS[status] ?? status;
}
