import type { Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import {
  draftFrom,
  draftProblems,
  isGoverned,
  isMonefy,
  monthCounts,
  monthLabel,
  periodText,
  policyFrom,
  selectableMonths,
  withEmptyMonths,
} from '../historyModel';

/** History sources: the pure parts. Invented data only. */

const sample = createSampleData({ today: '2026-11-05' });
const base = sample.transactions[0]!;
const txn = (patch: Partial<Transaction>): Transaction => ({ ...base, ...patch });

describe('which accounts a policy governs', () => {
  it('connected checking, savings, card, loan and mortgage accounts only', () => {
    expect(isGoverned({ type: 'checking', connectionId: 'conn_1' })).toBe(true);
    expect(isGoverned({ type: 'credit_card', connectionId: 'conn_1' })).toBe(true);
    expect(isGoverned({ type: 'mortgage', connectionId: 'conn_1' })).toBe(true);
    expect(isGoverned({ type: 'checking', connectionId: null })).toBe(false);
    expect(isGoverned({ type: 'cash', connectionId: 'conn_1' })).toBe(false);
    expect(isGoverned({ type: 'brokerage', connectionId: 'conn_1' })).toBe(false);
  });

  it('knows a Monefy row by its id, not by its file', () => {
    expect(isMonefy({ source: 'import', externalId: 'monefy:abc' })).toBe(true);
    expect(isMonefy({ source: 'import', externalId: 'csv:abc' })).toBe(false);
    expect(isMonefy({ source: 'connector', externalId: 'monefy:abc' })).toBe(false);
    expect(isMonefy({ source: 'import', externalId: null })).toBe(false);
  });
});

describe('months by source', () => {
  const rows = [
    txn({
      id: 'a',
      accountId: 'acc_checking',
      date: '2026-03-02',
      source: 'import',
      externalId: 'monefy:1',
    }),
    txn({
      id: 'b',
      accountId: 'acc_checking',
      date: '2026-03-20',
      source: 'connector',
      externalId: 'x',
    }),
    txn({
      id: 'c',
      accountId: 'acc_savings',
      date: '2026-01-09',
      source: 'manual',
      externalId: null,
    }),
    txn({
      id: 'd',
      accountId: 'acc_checking',
      date: '2026-03-21',
      source: 'connector',
      externalId: 'y',
      splitParentId: 'b',
    }),
  ];

  it('counts Monefy, bank and other per month, newest first, split parts once', () => {
    expect(monthCounts(rows, null)).toEqual([
      { month: '2026-03', monefy: 1, bank: 1, other: 0 },
      { month: '2026-01', monefy: 0, bank: 0, other: 1 },
    ]);
    expect(monthCounts(rows, 'acc_savings')).toEqual([
      { month: '2026-01', monefy: 0, bank: 0, other: 1 },
    ]);
  });

  it('shows a month with nothing at all as a gap', () => {
    expect(
      withEmptyMonths(monthCounts(rows, null)).map((m) => [m.month, m.monefy + m.bank + m.other]),
    ).toEqual([
      ['2026-03', 2],
      ['2026-02', 0],
      ['2026-01', 1],
    ]);
    expect(withEmptyMonths([])).toEqual([]);
  });

  it('labels a month with its year', () => {
    expect(monthLabel('2025-12')).toBe('Dec 2025');
  });
});

describe('months that can go to the bank', () => {
  it('whole months before the cutoff month, newest first, at least two years back', () => {
    const months = selectableMonths('2026-07-15', null);
    expect(months[0]).toBe('2026-06');
    expect(months).not.toContain('2026-07');
    expect(months).toHaveLength(24);
    expect(months[23]).toBe('2024-07');
  });

  it('reaches back to the oldest entry, and never past 240 months', () => {
    expect(selectableMonths('2026-07-01', '2019-01').at(-1)).toBe('2019-01');
    expect(selectableMonths('2026-07-01', '1980-01')).toHaveLength(240);
  });
});

describe('the policy sent to the Worker', () => {
  const ids = ['acc_savings', 'acc_checking', 'acc_card'];

  it('leaves out an account on the default with no months, sorts accounts and months', () => {
    const policy = policyFrom(
      {
        defaultCutoff: ' 2026-07-01 ',
        accounts: {
          acc_savings: { mode: 'default', cutoff: '', months: [] },
          acc_checking: { mode: 'default', cutoff: '', months: ['2026-05', '2026-03'] },
          acc_card: { mode: 'custom', cutoff: '2026-08-01', months: ['2026-02'] },
          acc_other: { mode: 'monefy_only', cutoff: '', months: [] },
        },
      },
      ids,
    );
    expect(policy).toEqual({
      defaultCutoff: '2026-07-01',
      accounts: [
        {
          accountId: 'acc_card',
          mode: 'custom',
          cutoff: '2026-08-01',
          replacementMonths: ['2026-02'],
        },
        { accountId: 'acc_checking', mode: 'default', replacementMonths: ['2026-03', '2026-05'] },
      ],
    });
  });

  it('Monefy only carries no cutoff or months, and an empty cutoff is null', () => {
    expect(
      policyFrom(
        {
          defaultCutoff: '',
          accounts: { acc_card: { mode: 'monefy_only', cutoff: 'x', months: ['2026-01'] } },
        },
        ids,
      ),
    ).toEqual({ defaultCutoff: null, accounts: [{ accountId: 'acc_card', mode: 'monefy_only' }] });
  });

  it('reads a saved policy back into the same draft', () => {
    const saved = {
      defaultCutoff: '2026-07-01',
      accounts: [
        {
          accountId: 'acc_card',
          mode: 'custom' as const,
          cutoff: '2026-08-01',
          replacementMonths: ['2026-02'],
        },
        { accountId: 'acc_checking', mode: 'default' as const, replacementMonths: ['2026-03'] },
        { accountId: 'acc_savings', mode: 'monefy_only' as const },
      ],
    };
    expect(policyFrom(draftFrom(saved), ids)).toEqual(saved);
  });
});

describe('what to fix before checking', () => {
  const governed = [
    { id: 'acc_checking', name: 'Everyday Checking' },
    { id: 'acc_card', name: 'Card' },
  ];

  it('asks for a real cutoff date', () => {
    expect(draftProblems({ defaultCutoff: '2026-02-30', accounts: {} }, governed)).toEqual([
      'Enter the cutoff as a date, for example 2025-06-01.',
    ]);
    expect(draftProblems({ defaultCutoff: '2026-02-28', accounts: {} }, governed)).toEqual([]);
  });

  it('names an account whose own cutoff is missing or whose months are not before it', () => {
    const problems = draftProblems(
      {
        defaultCutoff: '2026-07-01',
        accounts: {
          acc_checking: { mode: 'default', cutoff: '', months: ['2026-07', '2026-06'] },
          acc_card: { mode: 'custom', cutoff: 'soon', months: [] },
        },
      },
      governed,
    );
    expect(problems).toEqual([
      '"Everyday Checking": July 2026 is not before the cutoff\'s month. Only whole months before it can go to the bank.',
      'Enter "Card"\'s own cutoff as a date.',
    ]);
  });
});

describe('periods in words', () => {
  it.each([
    [{ source: 'monefy' as const, from: null, to: '2026-06-30' }, 'Monefy until Jun 30, 2026'],
    [{ source: 'bank' as const, from: '2026-07-01', to: null }, 'Bank from Jul 1, 2026'],
    [
      { source: 'bank' as const, from: '2026-02-01', to: '2026-02-28' },
      'Bank, all of February 2026',
    ],
    [
      { source: 'monefy' as const, from: '2026-03-01', to: '2026-05-31' },
      'Monefy, Mar 1, 2026 to May 31, 2026',
    ],
    [{ source: 'monefy' as const, from: null, to: null }, 'Monefy, every date'],
    [
      { source: 'independent' as const, from: null, to: null },
      'Not governed: every source is kept as it comes.',
    ],
  ])('%j', (period, text) => {
    expect(periodText(period)).toBe(text);
  });
});
