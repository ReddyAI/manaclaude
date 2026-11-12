import { createSampleData } from '@manaclaude/shared/sample';
import {
  carryDecisions,
  commitLines,
  dateProblem,
  EMPTY_OPTIONS,
  EMPTY_REVIEW,
  needsDateConfirmation,
  planImport,
  requestKey,
  resultFromRecord,
  rowSpan,
  sourcesOf,
  toRequest,
  type ImportOptions,
} from '../importFlow';
import { makePreview, monefyPreview, record, row } from './fixtures';

const accounts = createSampleData().accounts;
const opts = (patch: Partial<ImportOptions> = {}): ImportOptions => ({
  ...EMPTY_OPTIONS,
  ...patch,
});

describe('what a preview is asked for', () => {
  it('sends only what was chosen', () => {
    expect(toRequest(EMPTY_OPTIONS)).toEqual({});
    expect(
      toRequest(
        opts({
          fromDate: '2026-10-01',
          toDate: '2026-10-31',
          accountId: 'acc_nre',
          dayFirst: false,
          currency: 'INR',
        }),
      ),
    ).toEqual({
      fromDate: '2026-10-01',
      toDate: '2026-10-31',
      accountId: 'acc_nre',
      preferDayFirst: false,
      currency: 'INR',
    });
  });

  it('maps accounts named in the file, and leaves "leave out" and "from the file" unsent', () => {
    const options = opts({
      accountId: 'acc_nre',
      sources: {
        Pocket: { kind: 'account', accountId: 'acc_cash_usd' },
        Travel: { kind: 'skip' },
        Spare: { kind: 'file' },
      },
    });
    // A single destination is never sent together with per-account mappings.
    expect(toRequest(options)).toEqual({ accountMappings: { Pocket: 'acc_cash_usd' } });
    // Leaving an account out does not need a new preview.
    expect(requestKey(options)).toBe(
      requestKey(opts({ sources: { Pocket: { kind: 'account', accountId: 'acc_cash_usd' } } })),
    );
  });

  it('says what is wrong with the dates', () => {
    expect(dateProblem(opts())).toBeNull();
    expect(dateProblem(opts({ fromDate: '2026-10-01', toDate: '2026-10-01' }))).toBeNull();
    expect(dateProblem(opts({ fromDate: '1/10/2026' }))).toMatch(/first date as YYYY-MM-DD/);
    expect(dateProblem(opts({ toDate: '2026-02-30' }))).toMatch(/last date as YYYY-MM-DD/);
    expect(dateProblem(opts({ fromDate: '2026-10-02', toDate: '2026-10-01' }))).toMatch(/after/);
  });
});

describe('what a save would do', () => {
  it('counts rows and totals per account and currency', () => {
    const preview = monefyPreview();
    const plan = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts);
    expect(plan.blockers).toEqual([]);
    expect(plan.importing).toHaveLength(4);
    expect(plan.totals).toEqual([
      {
        key: 'new:Pocket|USD',
        label: 'Pocket',
        isNew: true,
        currency: 'USD',
        count: 3,
        moneyIn: 125_50,
        moneyOut: 28_50,
      },
      {
        key: 'new:Travel|INR',
        label: 'Travel',
        isNew: true,
        currency: 'INR',
        count: 1,
        moneyIn: 0,
        moneyOut: 270_00,
      },
    ]);
    expect(sourcesOf(preview).map((s) => [s.name, s.rows, s.create?.currency])).toEqual([
      ['Pocket', 3, 'USD'],
      ['Travel', 1, 'INR'],
    ]);
  });

  it('leaves a whole account out and keeps it out of the totals', () => {
    const options = opts({ sources: { Pocket: { kind: 'skip' } } });
    const preview = monefyPreview();
    expect(commitLines(preview, options, EMPTY_REVIEW)).toEqual({
      skipLines: [2, 3, 5],
      keepLines: [],
    });
    const plan = planImport(preview, options, EMPTY_OPTIONS, EMPTY_REVIEW, accounts);
    expect(plan.leftOut).toBe(3);
    expect(plan.totals.map((t) => t.label)).toEqual(['Travel']);
    expect(plan.blockers).toEqual([]);
  });

  it('will not save rows that have no account', () => {
    const preview = makePreview({ rows: [row(2, { accountId: null, decision: 'needs_account' })] });
    const plan = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts);
    expect(plan.unplaced).toBe(1);
    expect(plan.importing).toHaveLength(0);
    expect(plan.blockers).toEqual(['1 row has no account yet. Choose where they go.']);
  });

  it('needs every possible duplicate answered, and sends keep and skip apart', () => {
    const preview = makePreview({
      rows: [row(2), row(3), row(4)],
      duplicateCandidates: [
        { line: 2, transactionIds: ['t1'] },
        { line: 3, transactionIds: ['t2'] },
      ],
    });
    const none = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts);
    expect(none.blockers).toEqual(['2 possible duplicates need a choice: keep or skip.']);
    const review = { decisions: { 2: 'keep' as const, 3: 'skip' as const }, skipErrors: false };
    expect(commitLines(preview, EMPTY_OPTIONS, review)).toEqual({ skipLines: [3], keepLines: [2] });
    const done = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts);
    expect(done.blockers).toEqual([]);
    expect(done.importing.map((r) => r.line)).toEqual([2, 4]);
  });

  it('never both keeps and skips a line', () => {
    const preview = monefyPreview({ duplicateCandidates: [{ line: 2, transactionIds: ['t1'] }] });
    const lines = commitLines(preview, opts({ sources: { Pocket: { kind: 'skip' } } }), {
      decisions: { 2: 'keep' },
      skipErrors: false,
    });
    expect(lines.keepLines).toEqual([]);
    expect(lines.skipLines).toContain(2);
  });

  it('needs unreadable lines acknowledged before saving the rest', () => {
    const preview = makePreview({ errors: [{ line: 7, message: 'No amount on this row.' }] });
    expect(
      planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts).blockers,
    ).toEqual(['1 line could not be read. Fix the file, or choose to leave it out.']);
    const review = { decisions: {}, skipErrors: true };
    expect(planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts).blockers).toEqual(
      [],
    );
    expect(commitLines(preview, EMPTY_OPTIONS, review).skipLines).toEqual([7]);
  });

  it('blocks a save when the choices no longer match the preview, or nothing is new', () => {
    const preview = makePreview();
    const changed = planImport(
      preview,
      opts({ fromDate: '2026-10-01' }),
      EMPTY_OPTIONS,
      EMPTY_REVIEW,
      accounts,
    );
    expect(changed.blockers[0]).toMatch(/Update the preview/);
    const nothing = makePreview({ rows: [row(2, { decision: 'already_imported' })] });
    expect(
      planImport(nothing, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts).blockers,
    ).toEqual(['Nothing new to import.']);
  });

  it('asks for the date order when the file can be read two ways', () => {
    expect(
      needsDateConfirmation(makePreview({ requiresDateConfirmation: true }), EMPTY_OPTIONS),
    ).toBe(true);
    const csv = {
      headers: ['Date', 'Description', 'Amount'],
      signature: 'date|description|amount',
      suggestedMapping: {} as never,
      missing: [],
      dateFormatAmbiguous: true,
      dateFormatCandidates: ['DD/MM/YYYY' as const, 'MM/DD/YYYY' as const],
      usedSavedMapping: false,
    };
    const preview = makePreview({ csv });
    expect(needsDateConfirmation(preview, EMPTY_OPTIONS)).toBe(true);
    expect(
      planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts).blockers,
    ).toEqual(['Confirm how the dates in the file are written.']);
    // Answered by choosing a format, or by a layout saved from an earlier import.
    expect(
      needsDateConfirmation(preview, opts({ mapping: { dateFormat: 'DD/MM/YYYY' } as never })),
    ).toBe(false);
    expect(
      needsDateConfirmation(
        makePreview({ csv: { ...csv, usedSavedMapping: true } }),
        EMPTY_OPTIONS,
      ),
    ).toBe(false);
  });
});

describe('a new preview of the same file', () => {
  const before = makePreview({
    rows: [row(2), row(3)],
    duplicateCandidates: [
      { line: 2, transactionIds: ['t1'] },
      { line: 3, transactionIds: ['t2'] },
    ],
  });
  const decisions = { 2: 'keep' as const, 3: 'skip' as const };

  it('keeps an answer only where the same row faces the same stored transactions', () => {
    const after = makePreview({
      rows: [row(2), row(3)],
      duplicateCandidates: [
        { line: 2, transactionIds: ['t1'] },
        { line: 3, transactionIds: ['t2', 't9'] },
      ],
    });
    expect(carryDecisions(before, after, decisions)).toEqual({ 2: 'keep' });
  });

  it('drops answers when line numbers now point at other rows', () => {
    const after = makePreview({
      rows: [row(2, { rawName: 'Another row' }), row(3)],
      duplicateCandidates: before.duplicateCandidates,
    });
    expect(carryDecisions(before, after, decisions)).toEqual({ 3: 'skip' });
    expect(carryDecisions(null, after, decisions)).toEqual({});
  });
});

describe('small helpers', () => {
  it('reads the counts of a saved import back from its record', () => {
    expect(
      resultFromRecord(
        record({ rowsAdded: 12, rowsMatched: 3, rowsSkipped: 1, error: 'Transfers need a retry.' }),
      ),
    ).toMatchObject({
      importId: 'imp_1',
      added: 12,
      matched: 3,
      skipped: 1,
      warnings: ['Transfers need a retry.'],
    });
  });

  it('finds the first and last date', () => {
    expect(rowSpan([])).toBeNull();
    expect(
      rowSpan([{ date: '2026-03-04' }, { date: '2025-12-31' }, { date: '2026-01-01' }]),
    ).toEqual({
      first: '2025-12-31',
      last: '2026-03-04',
    });
  });
});
