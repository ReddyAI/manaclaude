import { beforeEach, describe, expect, it } from 'vitest';
import type {
  CsvMapping,
  ImportCommitResult,
  ImportDetail,
  ImportMappingsResponse,
  ImportResponse,
} from '@manaclaude/shared';
import { addAccount, addTxn, allTxns, freshDb } from './helpers';
import { client, upload } from './worker';

beforeEach(freshDb);

// Invented exports with deliberately nonstandard columns and ambiguous dates.
const header = 'Booked,Details,Out,In,Value,Unit,Memo';
const rows = [
  '03/11/2026,Orchard stationery,12.50,,12.50,USD,Paper',
  '03/11/2026,Orchard stationery,12.50,,12.50,USD,Paper',
  '04/11/2026,Meadow refund,,7.25,-7.25,USD,Return',
  '05/11/2026,Cedar books,18.00,,18.00,USD,Reading',
];
const expected = [
  ['2026-11-03', 'Orchard stationery', -1250, 'USD', 'Paper'],
  ['2026-11-03', 'Orchard stationery', -1250, 'USD', 'Paper'],
  ['2026-11-04', 'Meadow refund', 725, 'USD', 'Return'],
  ['2026-11-05', 'Cedar books', -1800, 'USD', 'Reading'],
];
const savedMapping: CsvMapping = {
  delimiter: ',',
  hasHeader: true,
  skipRows: 2,
  dateColumn: 0,
  dateFormat: 'DD/MM/YYYY',
  amountMode: 'debit_credit',
  amountColumn: null,
  debitColumn: 2,
  creditColumn: 3,
  invertSign: false,
  decimalSeparator: '.',
  descriptionColumn: 1,
  notesColumn: 6,
  categoryColumn: null,
  currencyColumn: 5,
  idColumn: null,
};

function statement(skipRows: number, entries = rows) {
  return [
    ...Array.from({ length: skipRows }, (_, i) => `Invented statement preamble ${i + 1}`),
    header,
    ...entries,
  ].join('\n');
}

const { api } = client();
async function preview(fields: Record<string, string> = {}, entries = rows) {
  const response = await api<ImportResponse>(
    'POST',
    '/v1/imports',
    upload(
      { format: 'csv', ...fields },
      statement(Number(fields.skipRows ?? 0), entries),
      'next.csv',
    ),
  );
  expect(response.status).toBe(201);
  return response.body;
}

async function saveLayout(mapping = savedMapping) {
  const account = await addAccount({ type: 'checking' });
  const { preview: original } = await preview(
    { accountId: account.id, skipRows: '2', mapping: JSON.stringify(mapping) },
    ['23/10/2025,Prior supplies,9.00,,9.00,USD,Earlier file'],
  );
  const saved = await api<ImportCommitResult>(
    'POST',
    `/v1/imports/${original.importId}/commit`,
    {},
  );
  expect(saved.status).toBe(200);
  expect(saved.body.added).toBe(1);
  const layouts = await api<ImportMappingsResponse>('GET', '/v1/import-mappings');
  expect(layouts.body.mappings).toHaveLength(1);
  expect(layouts.body.mappings[0]?.mapping).toEqual(mapping);
  return account;
}

function values(row: {
  date: string;
  rawName: string;
  amount: number;
  currency: string | null;
  notes: string | null;
}) {
  return [row.date, row.rawName, row.amount, row.currency, row.notes];
}

describe.each(['debit_credit', 'single'] as const)('saved CSV %s layout', (amountMode) => {
  const mapping: CsvMapping =
    amountMode === 'single'
      ? { ...savedMapping, amountMode, amountColumn: 4, invertSign: true }
      : savedMapping;

  it.each<{ label: string; fields: Record<string, string>; skipRows: number }>([
    { label: 'omitted skipRows', fields: {}, skipRows: 0 },
    { label: 'explicit zero', fields: { skipRows: '0' }, skipRows: 0 },
    { label: 'shorter preamble', fields: { skipRows: '1' }, skipRows: 1 },
    { label: 'longer preamble', fields: { skipRows: '3' }, skipRows: 3 },
  ])(
    'uses the current file with $label in preview, commit and repeat',
    async ({ fields, skipRows }) => {
      const account = await saveLayout(mapping);
      const options = { accountId: account.id, ...fields };
      const { preview: p, result } = await preview(options);
      expect(result).toBeNull();
      expect(p.status).toBe('preview');
      expect(p.csv?.usedSavedMapping).toBe(true);
      expect(p.mapping).toEqual({ ...mapping, skipRows });
      expect(p.errors).toEqual([]);
      expect(p.rows.map(values)).toEqual(expected);
      expect(p.rows.map((r) => r.line)).toEqual([2, 3, 4, 5].map((line) => line + skipRows));
      expect(p.rows.every((r) => r.accountId === account.id)).toBe(true);
      expect(p.counts).toEqual({
        total: 4,
        new: 4,
        alreadyImported: 0,
        existing: 0,
        needsAccount: 0,
      });
      expect(new Set(p.rows.map((r) => r.fingerprint)).size).toBe(4);
      expect(await allTxns()).toHaveLength(1); // Preview alone writes no transactions.
      const beforeCommit = await api<ImportMappingsResponse>('GET', '/v1/import-mappings');
      expect(beforeCommit.body.mappings[0]?.mapping).toEqual(mapping);

      const saved = await api<ImportCommitResult>('POST', `/v1/imports/${p.importId}/commit`, {});
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ added: 4, matched: 0, skipped: 0, warnings: [] });
      expect(new Set(saved.body.transactionIds).size).toBe(4);
      expect((await allTxns()).filter((t) => t.importId === p.importId).map(values)).toEqual(
        expected,
      );
      const detail = await api<ImportDetail>('GET', `/v1/imports/${p.importId}`);
      expect(detail.body).toMatchObject({ status: 'committed', rowsTotal: 4, rowsAdded: 4 });
      expect(detail.body.preview?.rows).toEqual(p.rows);
      const layouts = await api<ImportMappingsResponse>('GET', '/v1/import-mappings');
      expect(layouts.body.mappings[0]?.mapping).toEqual({ ...mapping, skipRows });
      expect((await api('POST', `/v1/imports/${p.importId}/commit`, {})).status).toBe(409);

      // Same transactions with yet another preamble: every occurrence is recognized once.
      const { preview: repeat } = await preview({ accountId: account.id, skipRows: '4' });
      expect(repeat.csv?.usedSavedMapping).toBe(true);
      expect(repeat.errors).toEqual([]);
      expect(repeat.rows.map(values)).toEqual(expected);
      expect(repeat.counts).toMatchObject({ total: 4, new: 0, alreadyImported: 4 });
      const repeated = await api<ImportCommitResult>(
        'POST',
        `/v1/imports/${repeat.importId}/commit`,
        {},
      );
      expect(repeated.status).toBe(200);
      expect(repeated.body.added).toBe(0);
      expect(await allTxns()).toHaveLength(5);
    },
  );
});

describe('CSV mapping precedence and safeguards', () => {
  it('prefers explicit columns, dates and signs over a saved mapping for the same header', async () => {
    const account = await saveLayout();
    const mapping: CsvMapping = {
      ...savedMapping,
      skipRows: 1,
      dateFormat: 'MM/DD/YYYY',
      amountMode: 'single',
      amountColumn: 4,
    };
    const { preview: p } = await preview({
      accountId: account.id,
      skipRows: '1',
      mapping: JSON.stringify(mapping),
    });
    const layouts = await api<ImportMappingsResponse>('GET', '/v1/import-mappings');
    expect(p.csv?.signature).toBe(layouts.body.mappings[0]?.signature);
    expect(p.csv?.usedSavedMapping).toBe(false);
    expect(p.mapping).toEqual(mapping);
    expect(p.errors).toEqual([]);
    expect(p.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-03-11', 1250],
      ['2026-03-11', 1250],
      ['2026-04-11', -725],
      ['2026-05-11', 1800],
    ]);
    const saved = await api<ImportCommitResult>('POST', `/v1/imports/${p.importId}/commit`, {});
    expect(saved.status).toBe(200);
    expect(saved.body.added).toBe(4);
    expect((await allTxns()).filter((t) => t.importId === p.importId).map(values)).toEqual(
      p.rows.map(values),
    );
  });

  it.each([undefined, '0', '1'])(
    'keeps explicit mapping.skipRows when request skipRows is %s',
    async (skipRows) => {
      const account = await saveLayout();
      const mapping: CsvMapping = {
        ...savedMapping,
        amountMode: 'single',
        amountColumn: 4,
        invertSign: false,
        skipRows: 0,
        hasHeader: false,
      };
      const response = await api<ImportResponse>(
        'POST',
        '/v1/imports',
        upload(
          {
            accountId: account.id,
            mapping: JSON.stringify(mapping),
            ...(skipRows === undefined ? {} : { skipRows }),
          },
          rows.join('\n'),
          'explicit.csv',
        ),
      );
      expect(response.status).toBe(201);
      const p = response.body.preview;
      expect(p.csv?.usedSavedMapping).toBe(false);
      expect(p.mapping).toEqual(mapping);
      expect(p.errors).toEqual([]);
      expect(p.rows.map((r) => r.line)).toEqual([1, 2, 3, 4]);
      expect(p.rows.map((r) => r.amount)).toEqual([1250, 1250, -725, 1800]);
      expect(
        (await api<ImportCommitResult>('POST', `/v1/imports/${p.importId}/commit`, {})).body.added,
      ).toBe(4);
    },
  );

  it('uses the current preamble for multipart commit=true too', async () => {
    const account = await saveLayout();
    const { preview: p, result } = await preview({ accountId: account.id, commit: 'true' });
    expect(p.csv?.usedSavedMapping).toBe(true);
    expect(p.rows.map(values)).toEqual(expected);
    expect(result).toMatchObject({ added: 4, skipped: 0 });
    expect((await allTxns()).filter((t) => t.importId === p.importId).map(values)).toEqual(
      expected,
    );
  });

  it('keeps parse-error acknowledgement and duplicate review at current file line numbers', async () => {
    const account = await saveLayout();
    const existing = await addTxn(account, {
      date: '2026-11-05',
      amount: -1800,
      source: 'connector',
    });
    const { preview: p } = await preview({ accountId: account.id, skipRows: '1' }, [
      ...rows,
      'bad date,Unreadable,1.00,,1.00,USD,Fix me',
    ]);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]?.line).toBe(7);
    expect(p.duplicateCandidates).toEqual([{ line: 6, transactionIds: [existing.id] }]);
    const commit = (body: unknown) => api('POST', `/v1/imports/${p.importId}/commit`, body);
    expect(await commit({})).toMatchObject({ status: 400, body: { error: 'import_parse_errors' } });
    expect(await commit({ skipLines: [7] })).toMatchObject({
      status: 400,
      body: { error: 'import_duplicates_require_review' },
    });
    expect(await commit({ skipLines: [6, 7], keepLines: [6] })).toMatchObject({
      status: 400,
      body: { error: 'bad_request' },
    });
    expect(await allTxns()).toHaveLength(2);
    expect(await commit({ skipLines: [6, 7] })).toMatchObject({
      status: 200,
      body: { added: 3, skipped: 2 },
    });
    expect((await allTxns()).filter((t) => t.importId === p.importId).map(values)).toEqual(
      expected.slice(0, 3),
    );
  });

  it('does not reuse a saved destination or bypass currency checks', async () => {
    const original = await saveLayout();
    const other = await addAccount({ type: 'checking' });
    const { preview: p } = await preview({ accountId: other.id });
    expect(p.rows.every((r) => r.accountId === other.id)).toBe(true);
    const { preview: unresolved } = await preview();
    expect(unresolved.counts.needsAccount).toBe(4);
    expect(await api('POST', `/v1/imports/${unresolved.importId}/commit`, {})).toMatchObject({
      status: 400,
      body: { error: 'import_account_required' },
    });
    const inr = await addAccount({ type: 'savings', currency: 'INR' });
    expect(
      await api(
        'POST',
        '/v1/imports',
        upload({ accountId: inr.id }, statement(0), 'wrong-currency.csv'),
      ),
    ).toMatchObject({ status: 400, body: { error: 'import_currency_mismatch' } });
    expect((await allTxns()).map((t) => t.accountId)).toEqual([original.id]);
  });
});
