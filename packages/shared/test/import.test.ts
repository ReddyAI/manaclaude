import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignOccurrences,
  detectDateFormat,
  importFingerprint,
  normalizeAiStatement,
  parseActualCsv,
  parseAmountText,
  parseCsvTable,
  parseCsvWithMapping,
  parseOfx,
  parseQif,
  parseSureNdjson,
  suggestCsvMapping,
} from '../src';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../backend/test/fixtures/imports/${name}`, import.meta.url), 'utf8');

describe('amounts', () => {
  it('reads common statement amount styles without floats', () => {
    expect(parseAmountText('1,234.56', 'USD')).toBe(123_456);
    expect(parseAmountText('(12.50)', 'USD')).toBe(-1_250);
    expect(parseAmountText('12.50-', 'USD')).toBe(-1_250);
    expect(parseAmountText('$-5.75', 'USD')).toBe(-575);
    expect(parseAmountText('Rs. 1,76,240.00', 'INR')).toBe(17_624_000);
    expect(parseAmountText('240.00 DR', 'INR')).toBe(-24_000);
    expect(parseAmountText('1.234,56', 'EUR', ',')).toBe(123_456);
    expect(parseAmountText('0.1', 'USD')).toBe(10);
    expect(parseAmountText('1000', 'JPY')).toBe(1000);
    expect(parseAmountText('abc', 'USD')).toBeNull();
  });
});

describe('date-format detection', () => {
  it('finds day-first dates when a day is above 12', () => {
    const d = detectDateFormat(['17/10/2026', '03/11/2026']);
    expect(d.format).toBe('DD/MM/YYYY');
    expect(d.ambiguous).toBe(false);
  });

  it('marks 03/04/2026-only files as ambiguous and honours the day-first preference', () => {
    expect(detectDateFormat(['03/04/2026']).format).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['03/04/2026']).ambiguous).toBe(true);
    expect(detectDateFormat(['03/04/2026'], { preferDayFirst: true }).format).toBe('DD/MM/YYYY');
  });

  it('reads ISO, month names and compact dates', () => {
    expect(detectDateFormat(['2026-11-01']).format).toBe('YYYY-MM-DD');
    expect(detectDateFormat(['05-Nov-2026']).format).toBe('DD-MMM-YYYY');
    expect(detectDateFormat(['Nov 5, 2026']).format).toBe('MMM DD, YYYY');
    expect(detectDateFormat(['20261105']).format).toBe('YYYYMMDD');
  });
});

describe('csv', () => {
  it('handles quotes, commas and newlines inside cells', () => {
    expect(parseCsvTable('a,"b,c","d ""e"""\n1,2,3')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('suggests a debit/credit mapping after a bank preamble', () => {
    const text = fixture('lakeshore-checking.csv');
    const s = suggestCsvMapping(text, { skipRows: 2 });
    expect(s.missing).toEqual([]);
    expect(s.mapping.amountMode).toBe('debit_credit');
    expect(s.mapping.dateFormat).toBe('MM/DD/YYYY');
    const parsed = parseCsvWithMapping(text, s.mapping, 'USD');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.amount)).toEqual([-8_412, -200_000, 325_000, -20_000, -20_000]);
    expect(parsed.rows[1]?.rawName).toBe('WISE US INC');
  });

  it('reads an Indian day-first statement with lakh grouping', () => {
    const text = fixture('india-nre-dayfirst.csv');
    const s = suggestCsvMapping(text, { preferDayFirst: true });
    expect(s.mapping.dateFormat).toBe('DD/MM/YYYY');
    const parsed = parseCsvWithMapping(text, s.mapping, 'INR');
    expect(parsed.rows[0]).toMatchObject({ date: '2026-10-17', amount: 17_624_000 });
    expect(parsed.rows[2]).toMatchObject({ date: '2026-11-03', amount: -2_500_000 });
  });
});

describe('fingerprints', () => {
  it('gives two identical coffees different fingerprints and repeats them on re-import', () => {
    const rows = [
      { accountId: 'a', date: '2026-11-01', amount: -575, rawName: 'STARBUCKS STORE 04412' },
      { accountId: 'a', date: '2026-11-01', amount: -575, rawName: 'Starbucks  store 04412' },
    ];
    const occ = assignOccurrences(rows);
    expect(occ).toEqual([1, 2]);
    const fps = rows.map((r, i) => importFingerprint(r.accountId, r, occ[i]!));
    expect(fps[0]).not.toBe(fps[1]);
    expect(importFingerprint('a', rows[0]!, 1)).toBe(fps[0]);
    expect(importFingerprint('b', rows[0]!, 1)).not.toBe(fps[0]);
  });
});

describe('qif', () => {
  it('reads splits and bracketed transfers', () => {
    const r = parseQif(fixture('card-with-splits.qif'), { currency: 'USD' });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ date: '2026-11-02', amount: -10_000 });
    expect(r.rows[0]?.splits).toEqual([
      { amount: -6_000, categoryName: 'Shopping', memo: 'Plant pots' },
      { amount: -4_000, categoryName: 'Gifts', memo: 'Bouquet' },
    ]);
    expect(r.rows[2]).toMatchObject({ amount: 20_000, transferHint: true });
  });
});

describe('ofx', () => {
  it('reads SGML OFX with FITIDs and keeps only the last four digits', () => {
    const r = parseOfx(fixture('checking.ofx'));
    expect(r.rows.map((x) => [x.date, x.amount, x.externalId])).toEqual([
      ['2026-11-02', -4_218, 'LK20261102001'],
      ['2026-11-03', -100_000, 'LK20261103002'],
      ['2026-11-04', 1_500, 'LK20261104003'],
    ]);
    expect(r.rows[0]?.rawName).toBe('CITY POWER & LIGHT');
    expect(r.rows[1]?.transferHint).toBe(true);
    expect(r.accounts[0]).toMatchObject({ mask: '4821', balance: 576_588, type: 'checking' });
  });
});

describe('sure ndjson', () => {
  it('flips Sure amounts to this app’s sign rule and names categories', () => {
    const r = parseSureNdjson(fixture('sure-export.ndjson'));
    expect(r.accounts.map((a) => a.name)).toEqual(['Harbor Checking', 'Harbor Visa']);
    expect(r.rows[0]).toMatchObject({
      amount: -6_420,
      categoryName: 'Groceries',
      tags: ['Reimbursable'],
      externalId: 'sure:t1',
      accountName: 'Harbor Checking',
    });
    expect(r.rows[1]?.amount).toBe(280_000);
    expect(r.rows[2]).toMatchObject({ kindHint: 'card_payment', amount: -41_230 });
    expect(r.warnings).toEqual(['Skipped 1 Valuation record.']);
  });
});

describe('actual csv', () => {
  it('groups split rows under their parent and marks transfers', () => {
    const r = parseActualCsv(fixture('actual-export.csv'), { currency: 'USD' });
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(4);
    expect(r.rows[1]?.splits).toEqual([
      { amount: -5_500, categoryName: 'Home', memo: 'Towels' },
      { amount: -3_500, categoryName: 'Food', memo: 'Snacks' },
    ]);
    expect(r.rows[2]).toMatchObject({ transferHint: true, accountName: 'Pine Checking' });
  });
});

describe('ai statement normalisation', () => {
  it('turns AI JSON into rows and checks the running balance', () => {
    const s = normalizeAiStatement(
      {
        currency: 'INR',
        openingBalance: '3,50,000.00',
        closingBalance: '5,01,240.00',
        transactions: [
          { date: '17/10/2026', description: 'INWARD REMITTANCE', credit: '1,76,240.00' },
          { date: '03/11/2026', description: 'NEFT RENT', debit: '25,000.00' },
        ],
      },
      'USD',
    );
    expect(s.currency).toBe('INR');
    expect(s.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-17', 17_624_000],
      ['2026-11-03', -2_500_000],
    ]);
    expect(s.check.balances).toBe(true);
    const bad = normalizeAiStatement(
      {
        openingBalance: '10.00',
        closingBalance: '99.00',
        transactions: [{ date: '2026-11-01', amount: '-1.00' }],
      },
      'USD',
    );
    expect(bad.check.balances).toBe(false);
    expect(bad.warnings).toHaveLength(1);
  });
});
