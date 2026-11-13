import type { ImportRecord } from '@manaclaude/shared';

/** Invented vault records in the shape GET /v1/vault sends. Nothing here comes from a real file. */
export function stored(id: string, patch: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id,
    format: 'csv',
    status: 'committed',
    accountId: null,
    fileName: 'october.csv',
    contentType: 'text/csv',
    size: 12_400,
    sha256: 'sha-october',
    r2Key: `vault/2026-11/${id}/october.csv`,
    rowsTotal: 14,
    rowsAdded: 12,
    rowsMatched: 2,
    rowsSkipped: 0,
    error: null,
    periodStart: null,
    periodEnd: null,
    createdAt: '2026-11-03T09:00:00.000Z',
    updatedAt: '2026-11-03T09:00:00.000Z',
    committedAt: '2026-11-03T09:05:00.000Z',
    ...patch,
  };
}

/**
 * Three files as the Worker lists them, newest first: a CSV previewed three
 * times and imported once, a PDF that was imported and undone, and a QIF that
 * was only previewed.
 */
export const LISTED: ImportRecord[] = [
  stored('imp_6', {
    fileName: 'wallet.qif',
    format: 'qif',
    contentType: 'application/qif',
    sha256: 'sha-wallet',
    status: 'discarded',
    size: 840,
    rowsAdded: 0,
    rowsMatched: 0,
    committedAt: null,
    createdAt: '2026-11-05T08:00:00.000Z',
  }),
  stored('imp_5', {
    status: 'preview',
    rowsAdded: 0,
    rowsMatched: 0,
    committedAt: null,
    createdAt: '2026-11-04T10:02:00.000Z',
  }),
  stored('imp_4', { accountId: 'acc_nre', createdAt: '2026-11-04T10:01:00.000Z' }),
  stored('imp_3', {
    status: 'discarded',
    rowsAdded: 0,
    rowsMatched: 0,
    committedAt: null,
    createdAt: '2026-11-04T10:00:00.000Z',
  }),
  stored('imp_2', {
    fileName: 'nro-september.pdf',
    format: 'pdf',
    contentType: 'application/pdf',
    sha256: 'sha-nro',
    status: 'undone',
    size: 1_500_000,
    rowsAdded: 30,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    createdAt: '2026-11-02T07:00:00.000Z',
    committedAt: '2026-11-02T07:03:00.000Z',
  }),
];
