import { createSampleData } from '@manaclaude/shared/sample';
import {
  carryDecisions,
  carryLeftOut,
  commitLines,
  dateProblem,
  duplicateAnswer,
  EMPTY_OPTIONS,
  EMPTY_REVIEW,
  markOf,
  needsDateConfirmation,
  planImport,
  requestKey,
  resultFromRecord,
  rowChoices,
  rowSpan,
  sourcesOf,
  toRequest,
  type ImportOptions,
  type Review,
} from '../importFlow';
import { leftOutText } from '../PreviewCard';
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
    const review = { ...EMPTY_REVIEW, decisions: { 2: 'keep' as const, 3: 'skip' as const } };
    expect(commitLines(preview, EMPTY_OPTIONS, review)).toEqual({ skipLines: [3], keepLines: [2] });
    const done = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts);
    expect(done.blockers).toEqual([]);
    expect(done.importing.map((r) => r.line)).toEqual([2, 4]);
  });

  it('never both keeps and skips a line', () => {
    const preview = monefyPreview({ duplicateCandidates: [{ line: 2, transactionIds: ['t1'] }] });
    const lines = commitLines(preview, opts({ sources: { Pocket: { kind: 'skip' } } }), {
      ...EMPTY_REVIEW,
      decisions: { 2: 'keep' },
    });
    expect(lines.keepLines).toEqual([]);
    expect(lines.skipLines).toContain(2);
  });

  it('needs unreadable lines acknowledged before saving the rest', () => {
    const preview = makePreview({ errors: [{ line: 7, message: 'No amount on this row.' }] });
    expect(
      planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts).blockers,
    ).toEqual(['1 line could not be read. Fix the file, or choose to leave it out.']);
    const review = { ...EMPTY_REVIEW, skipErrors: true };
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

describe('single rows left out by hand', () => {
  /** A review with these rows of `preview` unticked. */
  const without = (preview: ReturnType<typeof makePreview>, lines: number[]): Review => ({
    ...EMPTY_REVIEW,
    leftOut: Object.fromEntries(
      lines.map((line) => [line, markOf(preview.rows.find((r) => r.line === line)!)]),
    ),
  });

  it('sends the row as a skipped line and takes it out of the counts and totals', () => {
    const preview = monefyPreview();
    const review = without(preview, [5]);
    expect(commitLines(preview, EMPTY_OPTIONS, review)).toEqual({ skipLines: [5], keepLines: [] });
    const plan = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts);
    expect(plan.importing.map((r) => r.line)).toEqual([2, 3, 4]);
    expect([plan.leftOut, plan.leftOutByHand]).toEqual([1, 1]);
    // Line 5 was the only money coming in to Pocket.
    expect(plan.totals.find((t) => t.label === 'Pocket')).toMatchObject({
      count: 2,
      moneyIn: 0,
      moneyOut: 28_50,
    });
    expect(plan.blockers).toEqual([]);
  });

  it('says nothing is left to import when every row is unticked', () => {
    const preview = makePreview({ rows: [row(2), row(3)] });
    const plan = planImport(
      preview,
      EMPTY_OPTIONS,
      EMPTY_OPTIONS,
      without(preview, [2, 3]),
      accounts,
    );
    expect(plan.importing).toEqual([]);
    expect(plan.totals).toEqual([]);
    expect(plan.blockers).toEqual(['Nothing new to import.']);
  });

  it('lets a row with no account be left out, which clears that reason not to save', () => {
    const preview = makePreview({
      rows: [row(2), row(3, { accountId: null, decision: 'needs_account' })],
    });
    expect(
      planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, EMPTY_REVIEW, accounts).blockers,
    ).toEqual(['1 row has no account yet. Choose where they go.']);
    const plan = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, without(preview, [3]), accounts);
    expect(plan.blockers).toEqual([]);
    expect(plan.unplaced).toBe(0);
  });

  it('counts each line once next to duplicate answers, unreadable lines and an account left out', () => {
    const preview = monefyPreview({
      rows: [
        ...monefyPreview().rows,
        row(6, { accountName: 'Travel', accountId: null, decision: 'needs_account' }),
        row(7, { accountName: 'Travel', accountId: null, decision: 'needs_account' }),
        row(8, { accountName: 'Travel', accountId: null, decision: 'already_imported' }),
      ],
      duplicateCandidates: [
        { line: 4, transactionIds: ['t1'] },
        { line: 6, transactionIds: ['t2'] },
      ],
      errors: [{ line: 11, message: 'No amount on this row.' }],
    });
    const options = opts({ sources: { Pocket: { kind: 'skip' } } });
    const review: Review = {
      decisions: { 4: 'keep', 6: 'skip' },
      skipErrors: true,
      // Line 2 belongs to the account that is left out as a whole; line 7 does not.
      leftOut: without(preview, [2, 7]).leftOut,
    };
    const lines = commitLines(preview, options, review);
    expect(lines).toEqual({ skipLines: [2, 3, 5, 6, 7, 11], keepLines: [4] });
    const plan = planImport(preview, options, EMPTY_OPTIONS, review, accounts);
    expect(plan.importing.map((r) => r.line)).toEqual([4]);
    expect(plan.alreadyThere).toBe(1);
    expect(plan.leftOut).toBe(5);
    expect(plan.leftOutByHand).toBe(1);
    expect(plan.unreadableLeftOut).toBe(1);
    // What the screen says is left out is what the save will report as left out.
    expect(plan.leftOut + plan.unreadableLeftOut).toBe(lines.skipLines.length);
    expect(leftOutText(plan)).toBe('6 left out (5 rows, 1 unreadable line)');
    expect(plan.totals).toEqual([
      expect.objectContaining({ label: 'Travel', count: 1, moneyIn: 0, moneyOut: 270_00 }),
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('words the left-out count', () => {
    expect(leftOutText({ leftOut: 0, unreadableLeftOut: 0 })).toBeNull();
    expect(leftOutText({ leftOut: 3, unreadableLeftOut: 0 })).toBe('3 left out');
    expect(leftOutText({ leftOut: 0, unreadableLeftOut: 2 })).toBe(
      '2 left out (2 unreadable lines)',
    );
    expect(leftOutText({ leftOut: 1, unreadableLeftOut: 1 })).toBe(
      '2 left out (1 row, 1 unreadable line)',
    );
  });

  it('treats an unticked row that is a possible duplicate as answered with skip', () => {
    const preview = makePreview({
      rows: [row(2), row(3)],
      duplicateCandidates: [{ line: 2, transactionIds: ['t1'] }],
    });
    const review = without(preview, [2]);
    expect(duplicateAnswer(review, 2)).toBe('skip');
    expect(duplicateAnswer(EMPTY_REVIEW, 2)).toBeUndefined();
    const plan = planImport(preview, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts);
    expect(plan.undecided).toEqual([]);
    expect(plan.blockers).toEqual([]);
    // An untick outranks an older "keep" for the same line: it is never both kept and skipped.
    expect(commitLines(preview, EMPTY_OPTIONS, { ...review, decisions: { 2: 'keep' } })).toEqual({
      skipLines: [2],
      keepLines: [],
    });
  });

  it('offers a tick box only for rows that are not settled somewhere else', () => {
    const preview = monefyPreview({
      rows: [
        ...monefyPreview().rows,
        row(6, { accountName: 'Travel', accountId: null, decision: 'already_imported' }),
        row(7, { accountName: 'Travel', accountId: null, decision: 'needs_account' }),
      ],
      duplicateCandidates: [{ line: 7, transactionIds: ['t1'] }],
    });
    const options = opts({ sources: { Pocket: { kind: 'skip' } } });
    // Pocket (2, 3, 5) is left out as an account, 6 is already stored, 7 has its own question.
    expect([...rowChoices(preview, options, EMPTY_REVIEW)]).toEqual([[4, 'in']]);
    expect([...rowChoices(preview, options, without(preview, [4]))]).toEqual([[4, 'out']]);
    expect([...rowChoices(preview, EMPTY_OPTIONS, EMPTY_REVIEW).keys()]).toEqual([2, 3, 4, 5]);
  });

  it('ignores a left-out line that is not a row of this preview', () => {
    const wide = makePreview({ rows: [row(2), row(3), row(4)] });
    const narrow = makePreview({ rows: [row(2), row(4)] });
    const review = without(wide, [3]);
    expect(commitLines(narrow, EMPTY_OPTIONS, review).skipLines).toEqual([]);
    const plan = planImport(narrow, EMPTY_OPTIONS, EMPTY_OPTIONS, review, accounts);
    expect([plan.leftOut, plan.leftOutByHand, plan.importing.length]).toEqual([0, 0, 2]);
  });
});

describe('rows left out by hand, after a new preview of the same file', () => {
  const before = makePreview({ rows: [row(2), row(3), row(4)] });
  const leftOut = { 3: markOf(before.rows[1]!) };

  it('keeps the row left out when it is still there, and while it is outside the dates', () => {
    expect(carryLeftOut(before, leftOut)).toEqual({ leftOut, putBack: [] });
    // Narrowed dates: line 3 is not in the preview. It is remembered for when it returns.
    const narrow = makePreview({ rows: [row(2), row(4)] });
    expect(carryLeftOut(narrow, leftOut)).toEqual({ leftOut, putBack: [] });
  });

  it('keeps a CSV line left out when the same line is read another way', () => {
    // Another date order: the same line of the file, now with another date.
    const reread = makePreview({ rows: [row(2), row(3, { date: '2026-03-10' }), row(4)] });
    const carried = carryLeftOut(reread, leftOut);
    expect(carried.putBack).toEqual([]);
    expect(carried.leftOut).toEqual({ 3: markOf(reread.rows[1]!) });
    expect(commitLines(reread, EMPTY_OPTIONS, { ...EMPTY_REVIEW, ...carried }).skipLines).toEqual([
      3,
    ]);
  });

  it('puts a PDF row back when another row now has its number, and says which', () => {
    const same = makePreview({ format: 'pdf', rows: [row(2), row(3), row(4)] });
    expect(carryLeftOut(same, leftOut)).toEqual({ leftOut, putBack: [] });
    // The statement was read again and the rows came back in another order.
    const shuffled = makePreview({
      format: 'pdf',
      rows: [row(2), row(3, { rawName: 'Row 4', amount: -99_00 }), row(4, { rawName: 'Row 3' })],
    });
    expect(carryLeftOut(shuffled, leftOut)).toEqual({ leftOut: {}, putBack: [3] });
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
