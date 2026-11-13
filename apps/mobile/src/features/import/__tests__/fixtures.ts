import type { ImportPreview, ImportPreviewRow, ImportRecord } from '@manaclaude/shared';

/** Invented preview data for the import tests. Nothing here comes from a real file. */
export function row(line: number, patch: Partial<ImportPreviewRow> = {}): ImportPreviewRow {
  return {
    line,
    date: '2026-10-03',
    amount: -1_250_00,
    currency: 'INR',
    rawName: `Row ${line}`,
    notes: null,
    categoryName: null,
    externalId: null,
    accountName: null,
    tags: [],
    splits: [],
    transferHint: false,
    kindHint: null,
    pending: false,
    accountId: 'acc_nre',
    fingerprint: `f${line}`,
    occurrence: 1,
    categoryId: null,
    decision: 'new',
    matchedTransactionId: null,
    ...patch,
  };
}

export function makePreview(patch: Partial<ImportPreview> = {}): ImportPreview {
  const rows = patch.rows ?? [row(2)];
  return {
    importId: 'imp_1',
    format: 'csv',
    status: 'preview',
    fileName: 'statement.csv',
    accountId: null,
    accountsToCreate: [],
    errors: [],
    warnings: [],
    counts: {
      total: rows.length,
      new: rows.filter((r) => r.decision === 'new').length,
      alreadyImported: rows.filter((r) => r.decision === 'already_imported').length,
      existing: 0,
      needsAccount: rows.filter((r) => r.decision === 'needs_account').length,
    },
    csv: null,
    mapping: null,
    statementCheck: null,
    periodStart: null,
    periodEnd: null,
    duplicateCandidates: [],
    dateRange: { from: null, to: null, excluded: 0 },
    requiresDateConfirmation: false,
    ...patch,
    rows,
  };
}

/** A Monefy-style preview: two accounts in the file, neither known yet. */
export function monefyPreview(patch: Partial<ImportPreview> = {}): ImportPreview {
  const pocket = { accountName: 'Pocket', accountId: null, decision: 'needs_account' as const };
  const travel = { accountName: 'Travel', accountId: null, decision: 'needs_account' as const };
  return makePreview({
    sourceFormat: 'monefy',
    fileName: 'history.csv',
    rows: [
      row(2, {
        ...pocket,
        currency: 'USD',
        amount: -14_25,
        date: '2025-10-23',
        rawName: 'Paint, paper',
        categoryName: 'Hobbies',
        externalId: 'monefy:a',
      }),
      row(3, {
        ...pocket,
        currency: 'USD',
        amount: -14_25,
        date: '2025-10-23',
        rawName: 'Paint, paper',
        categoryName: 'Hobbies',
        externalId: 'monefy:b',
      }),
      row(4, {
        ...travel,
        currency: 'INR',
        amount: -270_00,
        date: '2025-10-24',
        rawName: 'Book',
        categoryName: 'Books',
        externalId: 'monefy:c',
      }),
      row(5, {
        ...pocket,
        currency: 'USD',
        amount: 125_50,
        date: '2025-10-25',
        rawName: 'Project fee',
        categoryName: 'Freelance',
        externalId: 'monefy:d',
      }),
    ],
    accountsToCreate: [
      {
        name: 'Pocket',
        type: 'other_asset',
        currency: 'USD',
        mask: null,
        balance: null,
        balanceDate: null,
      },
      {
        name: 'Travel',
        type: 'other_asset',
        currency: 'INR',
        mask: null,
        balance: null,
        balanceDate: null,
      },
    ],
    ...patch,
  });
}

export function record(patch: Partial<ImportRecord> = {}): ImportRecord {
  return {
    id: 'imp_1',
    format: 'csv',
    status: 'committed',
    accountId: null,
    fileName: 'statement.csv',
    contentType: 'text/csv',
    size: 120,
    sha256: 'x',
    r2Key: 'vault/2026-11/imp_1/statement.csv',
    rowsTotal: 1,
    rowsAdded: 1,
    rowsMatched: 0,
    rowsSkipped: 0,
    error: null,
    periodStart: null,
    periodEnd: null,
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
    committedAt: '2026-11-05T12:00:00.000Z',
    ...patch,
  };
}
