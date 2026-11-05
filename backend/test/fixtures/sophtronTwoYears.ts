/**
 * An invented Sophtron login with two years of history: a checking account
 * and a credit card, 3,120 transactions in all, dated from 2024-11-06 to
 * 2026-11-05. Everything is made up (names, amounts, ids). It is generated
 * from a fixed seed, so every run gets the same rows.
 *
 * - 24 monthly card payments: checking -X "LAKEVIEW CARD PAYMENT" and the card
 *   +X "PAYMENT THANK YOU" the same day (the transfer matcher should link them).
 * - 24 ATM withdrawals from checking (each should get a cash deposit and a link).
 * - 24 paychecks, rent, and everyday purchases on both accounts.
 * - Signs as the customer sees them (purchases negative), like the existing fixtures.
 */

export const TWO_YEARS = { from: '2024-11-06', to: '2026-11-05' } as const;
export const CHECKING_ID = 'soph-2y-chk';
export const CARD_ID = 'soph-2y-card';

export interface SophtronRow {
  TransactionID: string;
  Type: 'Debit' | 'Credit';
  Status: 'Completed' | 'Pending';
  Amount: number;
  Currency: 'USD';
  TransactionDate: string;
  Merchant: string;
  Description: string;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const SHOPS = [
  ['Hillside Grocer', 'HILLSIDE GROCER 118'],
  ['Corner Coffee', 'CORNER COFFEE'],
  ['Northgate Fuel', 'NORTHGATE FUEL 22'],
  ['Pine Street Pharmacy', 'PINE ST PHARMACY'],
  ['Maple Diner', 'MAPLE DINER'],
  ['Brightline Transit', 'BRIGHTLINE TRANSIT'],
  ['Orchard Books', 'ORCHARD BOOKS 7'],
  ['Summit Hardware', 'SUMMIT HARDWARE'],
] as const;

export function twoYearsOfSophtron(): {
  accounts: Record<string, unknown>[];
  transactions: Record<string, SophtronRow[]>;
} {
  const random = rng(20261105);
  const checking: SophtronRow[] = [];
  const card: SophtronRow[] = [];
  let n = 0;
  const id = (prefix: string) => `${prefix}-${String((n += 1)).padStart(5, '0')}`;
  const row = (
    list: SophtronRow[],
    date: string,
    amount: number,
    merchant: string,
    description: string,
    pending = false,
  ) => {
    list.push({
      TransactionID: id(list === checking ? 'c' : 'k'),
      Type: amount < 0 ? 'Debit' : 'Credit',
      Status: pending ? 'Pending' : 'Completed',
      Amount: Math.round(amount * 100) / 100,
      Currency: 'USD',
      TransactionDate: `${date}T00:00:00`,
      Merchant: merchant,
      Description: description,
    });
  };

  for (let month = 0; month < 24; month += 1) {
    const first = addDays(TWO_YEARS.from, month * 30);
    row(checking, addDays(first, 1), 3150, 'Acme Payroll', 'ACME PAYROLL');
    row(checking, addDays(first, 2), -1450, 'Oakridge Apartments', 'OAKRIDGE APTS RENT');
    row(checking, addDays(first, 9), -200, '', 'ATM WITHDRAWAL 0042');
    const pay = Math.round((300 + random() * 900) * 100) / 100;
    row(checking, addDays(first, 20), -pay, '', 'LAKEVIEW CARD PAYMENT');
    row(card, addDays(first, 20), pay, '', 'PAYMENT THANK YOU');
  }

  // Everyday purchases until the list holds 3,120 rows.
  let day = 0;
  while (checking.length + card.length < 3120) {
    const date = addDays(TWO_YEARS.from, day % 730);
    const [merchant, description] = SHOPS[Math.floor(random() * SHOPS.length)]!;
    const amount = -(2 + Math.round(random() * 9000) / 100);
    const pending = date >= addDays(TWO_YEARS.to, -2) && random() < 0.3;
    row(random() < 0.55 ? card : checking, date, amount, merchant, description, pending);
    day += 1;
  }

  return {
    accounts: [
      {
        AccountID: CHECKING_ID,
        AccountName: 'Everyday Checking',
        AccountType: 'Checking',
        AccountBalance: 4210.33,
        BalanceCurrency: 'USD',
        AccountNumber: '000044410042',
        AccountStatus: 'Active',
        InstitutionName: 'Lakeview Bank',
      },
      {
        AccountID: CARD_ID,
        AccountName: 'Lakeview Rewards Card',
        AccountType: 'CreditCard',
        AccountBalance: -1288.4,
        BalanceCurrency: 'USD',
        AccountNumber: '4409',
        AccountStatus: 'Active',
        InstitutionName: 'Lakeview Bank',
      },
    ],
    transactions: { [CHECKING_ID]: checking, [CARD_ID]: card },
  };
}
