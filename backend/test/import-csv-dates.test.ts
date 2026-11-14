import { beforeEach, describe, expect, it } from 'vitest';
import {
  suggestCsvMapping,
  type ImportCommitResult,
  type ImportDetail,
  type ImportResponse,
} from '@manaclaude/shared';
import { addAccount, allTxns, freshDb } from './helpers';
import { client, upload } from './worker';

beforeEach(freshDb);
const { api } = client();
const header = 'Date,Description,Amount';
// Identical purchases are intentional: both occurrences must survive the preview.
const purchases = [
  '23/11/2026,Orchard books,-12.50',
  '23/11/2026,Orchard books,-12.50',
  '24/11/2026,Meadow refund,7.25',
];

async function preview(rows: string[], fields: Record<string, string> = {}) {
  return api<ImportResponse>(
    'POST',
    '/v1/imports',
    upload({ format: 'csv', ...fields }, [header, ...rows].join('\n'), 'invented-dates.csv'),
  );
}

describe('automatic CSV dates through preview and commit', () => {
  it.each([
    'not a date,Broken purchase,-9.00',
    '31/02/2026,Impossible day,-9.00',
    'Statement total',
    ',Missing date,-9.00',
  ])('previews every readable occurrence and requires acknowledgement of %s', async (badRow) => {
    const account = await addAccount({ type: 'checking' });
    const response = await preview([purchases[0]!, badRow, ...purchases.slice(1)], {
      accountId: account.id,
    });
    expect(response.status).toBe(201);
    const p = response.body.preview;
    expect(response.body.result).toBeNull();
    expect(p.status).toBe('preview');
    expect(p.csv).toMatchObject({
      missing: [],
      dateFormatAmbiguous: false,
      dateFormatCandidates: ['DD/MM/YYYY'],
      usedSavedMapping: false,
    });
    expect(p.mapping?.dateFormat).toBe('DD/MM/YYYY');
    expect(
      p.rows.map((row) => [row.line, row.date, row.rawName, row.amount, row.accountId]),
    ).toEqual([
      [2, '2026-11-23', 'Orchard books', -1250, account.id],
      [4, '2026-11-23', 'Orchard books', -1250, account.id],
      [5, '2026-11-24', 'Meadow refund', 725, account.id],
    ]);
    expect(new Set(p.rows.map((row) => row.fingerprint)).size).toBe(3);
    expect(p.counts).toEqual({
      total: 3,
      new: 3,
      alreadyImported: 0,
      existing: 0,
      needsAccount: 0,
    });
    expect(p.errors).toEqual([
      { line: 3, message: `Can't read the date "${badRow.split(',')[0]}" as DD/MM/YYYY.` },
    ]);
    expect((await api<ImportDetail>('GET', `/v1/imports/${p.importId}`)).body.preview).toEqual(p);
    expect(await allTxns()).toEqual([]);

    const commit = (body: unknown) =>
      api<ImportCommitResult>('POST', `/v1/imports/${p.importId}/commit`, body);
    for (const body of [{}, { keepLines: [3] }, { skipLines: [5] }]) {
      expect(await commit(body)).toMatchObject({
        status: 400,
        body: { error: 'import_parse_errors' },
      });
      expect(await allTxns()).toEqual([]);
      expect((await api<ImportDetail>('GET', `/v1/imports/${p.importId}`)).body.status).toBe(
        'preview',
      );
    }
    const saved = await commit({ skipLines: [3] });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ added: 3, skipped: 1, matched: 0, warnings: [] });
    expect(new Set(saved.body.transactionIds).size).toBe(3);
    expect((await allTxns()).map((row) => [row.date, row.rawName, row.amount])).toEqual(
      p.rows.map((row) => [row.date, row.rawName, row.amount]),
    );
    expect((await api<ImportDetail>('GET', `/v1/imports/${p.importId}`)).body).toMatchObject({
      status: 'committed',
      rowsAdded: 3,
      rowsSkipped: 1,
    });
    expect((await commit({ skipLines: [3] })).status).toBe(409);
    expect(await allTxns()).toHaveLength(3);
  });

  it('saves only reviewed rows when a readable purchase is deliberately left out too', async () => {
    const account = await addAccount({ type: 'checking' });
    const response = await preview([...purchases, 'Footer'], { accountId: account.id });
    expect(response.status).toBe(201);
    const p = response.body.preview;
    expect(p.rows.map((row) => row.line)).toEqual([2, 3, 4]);
    expect(p.errors.map((error) => error.line)).toEqual([5]);
    expect(
      await api('POST', `/v1/imports/${p.importId}/commit`, { skipLines: [3, 5] }),
    ).toMatchObject({ status: 200, body: { added: 2, skipped: 2 } });
    expect((await allTxns()).map((row) => [row.date, row.rawName, row.amount])).toEqual([
      ['2026-11-23', 'Orchard books', -1250],
      ['2026-11-24', 'Meadow refund', 725],
    ]);
  });

  it('refuses multipart immediate commit with unacknowledged line errors', async () => {
    const account = await addAccount({ type: 'checking' });
    expect(
      await preview([...purchases, 'Footer'], { accountId: account.id, commit: 'true' }),
    ).toMatchObject({ status: 400, body: { error: 'import_parse_errors' } });
    expect(await allTxns()).toEqual([]);
  });

  it.each<{ currency: string; fields: Record<string, string>; date: string }>([
    { currency: 'USD', fields: {}, date: '2026-03-04' },
    { currency: 'INR', fields: {}, date: '2026-04-03' },
    { currency: 'USD', fields: { preferDayFirst: 'true' }, date: '2026-04-03' },
    { currency: 'INR', fields: { preferDayFirst: 'false' }, date: '2026-03-04' },
  ])(
    'retains ambiguity and preference for $currency / $date',
    async ({ currency, fields, date }) => {
      const account = await addAccount({ type: 'checking', currency });
      const response = await preview(['03/04/2026,Orchard books,-12.50', 'Footer'], {
        accountId: account.id,
        ...fields,
      });
      expect(response.status).toBe(201);
      const p = response.body.preview;
      expect(p.status).toBe('preview');
      expect(p.csv).toMatchObject({
        missing: [],
        dateFormatAmbiguous: true,
        dateFormatCandidates: ['MM/DD/YYYY', 'DD/MM/YYYY'],
      });
      expect(p.rows.map((row) => row.date)).toEqual([date]);
      expect(p.warnings).toContain(
        `Dates could be MM/DD/YYYY or DD/MM/YYYY; read as ${p.mapping?.dateFormat}. Change it if that is wrong.`,
      );
      expect(p.errors.map((error) => error.line)).toEqual([3]);
      expect(await api('POST', `/v1/imports/${p.importId}/commit`, {})).toMatchObject({
        status: 400,
        body: { error: 'import_parse_errors' },
      });
    },
  );

  it.each([
    { rows: [] },
    { rows: ['bad,Unreadable,-9.00', '31/02/2026,Impossible,-8.00'] },
    { rows: [',Missing,-9.00'] },
    { rows: ['2026-11-23,Orchard books,-12.50', '24/11/2026,Meadow refund,7.25', 'Footer'] },
  ])('requires manual mapping without consistent usable evidence: $rows', async ({ rows }) => {
    const account = await addAccount({ type: 'checking' });
    const response = await preview(rows, { accountId: account.id });
    expect(response.status).toBe(201);
    const p = response.body.preview;
    expect(p.status).toBe('needs_mapping');
    expect(p.mapping).toBeNull();
    expect(p.csv).toMatchObject({ missing: ['date'], dateFormatCandidates: [] });
    expect(p.rows).toEqual([]);
    expect(await api('POST', `/v1/imports/${p.importId}/commit`, {})).toMatchObject({
      status: 400,
      body: { error: 'bad_request' },
    });
    expect(await allTxns()).toEqual([]);
  });

  it('honors an explicit date format even when the suggestion finds another one', async () => {
    const account = await addAccount({ type: 'checking' });
    const rows = ['03/04/2026,Orchard books,-12.50', '23/11/2026,Meadow books,-9.00', 'Footer'];
    const mapping = {
      ...suggestCsvMapping([header, ...rows].join('\n')).mapping,
      dateFormat: 'MM/DD/YYYY',
    };
    const response = await preview(rows, {
      accountId: account.id,
      mapping: JSON.stringify(mapping),
    });
    expect(response.status).toBe(201);
    const p = response.body.preview;
    expect(p.csv?.suggestedMapping.dateFormat).toBe('DD/MM/YYYY');
    expect(p.mapping).toEqual(mapping);
    expect(p.csv?.usedSavedMapping).toBe(false);
    expect(p.rows.map((row) => [row.line, row.date])).toEqual([[2, '2026-03-04']]);
    expect(p.errors.map((error) => error.line)).toEqual([3, 4]);
    expect(await api('POST', `/v1/imports/${p.importId}/commit`, { skipLines: [3] })).toMatchObject(
      { status: 400, body: { error: 'import_parse_errors' } },
    );
    expect(
      await api('POST', `/v1/imports/${p.importId}/commit`, { skipLines: [3, 4] }),
    ).toMatchObject({ status: 200, body: { added: 1, skipped: 2 } });
    expect((await allTxns()).map((row) => row.date)).toEqual(['2026-03-04']);
  });
});
