import {
  applyRules,
  assignOccurrences,
  buildSplitChildren,
  csvHeaderSignature,
  daysBetween,
  detectDelimiter,
  importFingerprint,
  parseActualCsv,
  parseCsvTable,
  parseCsvWithMapping,
  parseOfx,
  parseQif,
  parseSureNdjson,
  suggestCsvMapping,
  type Account,
  type CsvMapping,
  type Id,
  type ImportFormat,
  type ParseResult,
  type ParsedAccount,
  type ParsedImportRow,
  type Transaction,
  type ImportCommitResult,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportRecord,
} from '@manaclaude/shared';
import type { Env } from '../env';
import { getAi, type AiDeps } from '../ai/provider';
import { bulkInsertSpecs, runSpecs } from '../db/bulk';
import { selectAll } from '../db/table';
import {
  accountsTable,
  categoriesTable,
  rulesTable,
  tagsTable,
  transactionsTable,
} from '../db/tables';
import { badRequest, conflict, notFound } from '../util/errors';
import { newId, nowIso, sha256Hex } from '../util/ids';
import { recordAtmWithdrawals } from '../services/cash';
import { runTransferMatcher } from '../services/matcher';
import { getSettings } from '../services/settings';
import { makeTransaction } from '../services/transactions';
import { categoryMatcher } from './categories';
import { extractStatement } from './pdf';

export interface ImportFileInput {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  contentType?: string;
  format?: ImportFormat;
  /** The account the file belongs to (single-account files). */
  accountId?: Id;
  /** CSV only: use this mapping (and save it for this header layout). */
  mapping?: CsvMapping;
  /** CSV only: lines of bank preamble before the header. */
  skipRows?: number;
  /** Ambiguous dates (03/04/2026) read day-first. Defaults to true for INR accounts. */
  preferDayFirst?: boolean;
}

/** Guesses the format from the file name and the first bytes. */
export function detectFormat(fileName: string, text: string): ImportFormat {
  const name = fileName.toLowerCase();
  if (name.endsWith('.pdf') || text.startsWith('%PDF')) return 'pdf';
  if (name.endsWith('.qif') || /^!(type|account|option)/im.test(text.slice(0, 200))) return 'qif';
  if (name.endsWith('.ofx') || name.endsWith('.qfx') || /<OFX>/i.test(text.slice(0, 2000)))
    return 'ofx';
  if (name.endsWith('.ndjson') || name.endsWith('.jsonl')) return 'sure_ndjson';
  const header = (
    parseCsvTable(text.split(/\r?\n/).slice(0, 3).join('\n'), detectDelimiter(text))[0] ?? []
  ).map((h) => h.trim().toLowerCase());
  if (
    ['account', 'date', 'payee', 'category', 'amount'].every((h) => header.includes(h)) &&
    header.includes('split_amount')
  ) {
    return 'actual_csv';
  }
  return 'csv';
}

function vaultKey(importId: Id, fileName: string, now: string): string {
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'file';
  return `vault/${now.slice(0, 7)}/${importId}/${safe}`;
}

function matchAccount(
  accounts: readonly Account[],
  parsed: { name?: string | null; mask?: string | null },
): Account | null {
  if (parsed.mask) {
    const byMask = accounts.filter((a) => a.mask === parsed.mask);
    if (byMask.length === 1) return byMask[0]!;
  }
  if (parsed.name) {
    const n = parsed.name.trim().toLowerCase();
    const byName = accounts.find((a) => a.name.trim().toLowerCase() === n);
    if (byName) return byName;
  }
  return null;
}

async function loadRecord(
  db: D1Database,
  id: Id,
): Promise<ImportRecord & { preview: ImportPreview | null }> {
  const row = await db
    .prepare('SELECT * FROM imports WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row) throw notFound('Import not found.');
  return {
    id: String(row.id),
    format: row.format as ImportFormat,
    status: row.status as ImportRecord['status'],
    accountId: (row.account_id as string | null) ?? null,
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    r2Key: String(row.r2_key),
    rowsTotal: Number(row.rows_total),
    rowsAdded: Number(row.rows_added),
    rowsMatched: Number(row.rows_matched),
    rowsSkipped: Number(row.rows_skipped),
    error: (row.error as string | null) ?? null,
    periodStart: (row.period_start as string | null) ?? null,
    periodEnd: (row.period_end as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    committedAt: (row.committed_at as string | null) ?? null,
    preview: row.preview ? (JSON.parse(String(row.preview)) as ImportPreview) : null,
  };
}

export async function listImports(db: D1Database): Promise<ImportRecord[]> {
  const res = await db
    .prepare('SELECT id FROM imports ORDER BY created_at DESC LIMIT 200')
    .all<{ id: string }>();
  const out: ImportRecord[] = [];
  for (const r of res.results) {
    const { preview: _preview, ...rec } = await loadRecord(db, r.id);
    out.push(rec);
  }
  return out;
}

export async function getImport(db: D1Database, id: Id) {
  return loadRecord(db, id);
}

async function parseFile(
  env: Env,
  input: ImportFileInput,
  format: ImportFormat,
  text: string,
  account: Account | null,
  aiDeps: AiDeps,
): Promise<{
  parsed: ParseResult;
  mapping: CsvMapping | null;
  needsMapping: ImportPreview['csv'];
  period: { start: string | null; end: string | null };
  statementCheck: ImportPreview['statementCheck'];
}> {
  const currency = account?.currency ?? 'USD';
  const preferDayFirst = input.preferDayFirst ?? currency === 'INR';
  const none = { start: null, end: null };
  switch (format) {
    case 'csv': {
      const suggestion = suggestCsvMapping(text, { preferDayFirst, skipRows: input.skipRows ?? 0 });
      const signature = csvHeaderSignature(suggestion.headers);
      let mapping = input.mapping ?? null;
      if (!mapping) {
        const saved = await env.DB.prepare(
          'SELECT mapping FROM import_mappings WHERE signature = ?',
        )
          .bind(signature)
          .first<{ mapping: string }>();
        mapping = saved ? (JSON.parse(saved.mapping) as CsvMapping) : null;
      }
      const csvInfo = {
        headers: suggestion.headers,
        signature,
        suggestedMapping: suggestion.mapping,
        missing: suggestion.missing,
        dateFormatAmbiguous: suggestion.dateFormatAmbiguous,
        dateFormatCandidates: suggestion.dateFormatCandidates,
        usedSavedMapping: !input.mapping && mapping !== null,
      };
      if (!mapping) {
        if (suggestion.missing.length > 0) {
          return {
            parsed: {
              format,
              rows: [],
              accounts: [],
              errors: [],
              warnings: [],
              dateFormat: null,
              dateFormatAmbiguous: false,
            },
            mapping: null,
            needsMapping: csvInfo,
            period: none,
            statementCheck: null,
          };
        }
        mapping = suggestion.mapping;
      }
      const parsed = parseCsvWithMapping(text, mapping, currency);
      if (!input.mapping && !csvInfo.usedSavedMapping && suggestion.dateFormatAmbiguous) {
        parsed.warnings.push(
          `Dates could be ${suggestion.dateFormatCandidates.join(' or ')}; read as ${mapping.dateFormat}. Change it if that is wrong.`,
        );
        parsed.dateFormatAmbiguous = true;
      }
      return { parsed, mapping, needsMapping: csvInfo, period: none, statementCheck: null };
    }
    case 'qif':
      return {
        parsed: parseQif(text, { currency, preferDayFirst }),
        mapping: null,
        needsMapping: null,
        period: none,
        statementCheck: null,
      };
    case 'ofx':
      return {
        parsed: parseOfx(text),
        mapping: null,
        needsMapping: null,
        period: none,
        statementCheck: null,
      };
    case 'sure_ndjson':
      return {
        parsed: parseSureNdjson(text),
        mapping: null,
        needsMapping: null,
        period: none,
        statementCheck: null,
      };
    case 'actual_csv':
      return {
        parsed: parseActualCsv(text, { currency }),
        mapping: null,
        needsMapping: null,
        period: none,
        statementCheck: null,
      };
    case 'pdf': {
      const settings = await getSettings(env.DB);
      const ai = getAi(env, settings, aiDeps);
      const statement = await extractStatement(ai, input.bytes, input.fileName, currency);
      return {
        parsed: statement,
        mapping: null,
        needsMapping: null,
        period: { start: statement.periodStart, end: statement.periodEnd },
        statementCheck: statement.check,
      };
    }
  }
}

/**
 * Step 1 of every import: keep the original in the statement vault, parse it,
 * work out the account of each row and whether it is new, already imported
 * (same provider id or fingerprint) or already in the account from a sync
 * (reconciled). Nothing is written to transactions until commitImport.
 */
export async function previewImport(
  env: Env,
  input: ImportFileInput,
  aiDeps: AiDeps = {},
): Promise<ImportPreview> {
  const db = env.DB;
  if (input.bytes.byteLength === 0) throw badRequest('The file is empty.');
  if (input.bytes.byteLength > 20 * 1024 * 1024)
    throw badRequest('Files up to 20 MB can be imported.');
  const now = nowIso();
  const id = newId('imp');
  const sha256 = await sha256Hex(input.bytes);
  const text = new TextDecoder().decode(
    input.bytes.slice(0, input.format === 'pdf' ? 8 : undefined),
  );
  const format = input.format ?? detectFormat(input.fileName, text);
  const contentType = input.contentType || (format === 'pdf' ? 'application/pdf' : 'text/plain');
  const r2Key = vaultKey(id, input.fileName, now);
  await env.FILES.put(r2Key, input.bytes, {
    httpMetadata: { contentType },
    customMetadata: { importId: id, sha256, fileName: input.fileName.slice(0, 200) },
  });
  const accounts = await selectAll(db, accountsTable);
  const chosen = input.accountId ? (accounts.find((a) => a.id === input.accountId) ?? null) : null;
  if (input.accountId && !chosen) throw badRequest('No such account.');
  const earlier = await db
    .prepare(
      "SELECT id, committed_at FROM imports WHERE sha256 = ? AND status = 'committed' ORDER BY committed_at LIMIT 1",
    )
    .bind(sha256)
    .first<{ id: string; committed_at: string }>();

  let parsedResult;
  try {
    parsedResult = await parseFile(
      env,
      input,
      format,
      format === 'pdf' ? '' : new TextDecoder().decode(input.bytes),
      chosen,
      aiDeps,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read this file.';
    await db
      .prepare(
        'INSERT INTO imports (id, format, status, account_id, file_name, content_type, size, sha256, r2_key, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        format,
        'failed',
        chosen?.id ?? null,
        input.fileName,
        contentType,
        input.bytes.byteLength,
        sha256,
        r2Key,
        message,
        now,
        now,
      )
      .run();
    throw badRequest(
      message,
      e instanceof Error && e.name === 'AiDisabledError' ? 'ai_disabled' : 'unreadable_file',
    );
  }
  const { parsed, mapping, needsMapping, period, statementCheck } = parsedResult;

  // Resolve the account of each row.
  const accountFor = new Map<string, Account | null>();
  const toCreate: ParsedAccount[] = [];
  const resolve = (name: string | null): Account | null => {
    if (!name) return chosen;
    if (accountFor.has(name)) return accountFor.get(name)!;
    const info = parsed.accounts.find((a) => a.name === name);
    const found =
      matchAccount(accounts, { name, mask: info?.mask }) ??
      (parsed.accounts.length <= 1 ? chosen : null);
    accountFor.set(name, found);
    if (!found && info && !toCreate.includes(info)) toCreate.push(info);
    return found;
  };
  const rowAccounts = parsed.rows.map((r) => resolve(r.accountName));
  const occ = assignOccurrences(
    parsed.rows.map((r, i) => ({
      ...r,
      accountId: rowAccounts[i]?.id ?? `new:${r.accountName ?? ''}`,
    })),
  );
  const accountIds = [
    ...new Set(rowAccounts.filter((a): a is Account => a !== null).map((a) => a.id)),
  ];
  const existing: Transaction[] = [];
  for (const accId of accountIds) {
    const dates = parsed.rows.map((r) => r.date).sort();
    existing.push(
      ...(await selectAll(
        db,
        transactionsTable,
        "account_id = ? AND date >= date(?, '-5 days') AND date <= date(?, '+5 days')",
        [accId, dates[0] ?? '1900-01-01', dates[dates.length - 1] ?? '2200-01-01'],
      )),
    );
  }
  const byFingerprint = new Map(
    existing
      .filter((t) => t.importFingerprint)
      .map((t) => [`${t.accountId}|${t.importFingerprint}`, t]),
  );
  const byExternal = new Map(
    existing.filter((t) => t.externalId).map((t) => [`${t.accountId}|${t.externalId}`, t]),
  );
  const claimed = new Set<Id>();
  const categoryFor = categoryMatcher(await selectAll(db, categoriesTable));

  const rows: ImportPreviewRow[] = parsed.rows.map((r, i) => {
    const account = rowAccounts[i] ?? null;
    const fingerprint = account && !r.externalId ? importFingerprint(account.id, r, occ[i]!) : null;
    const base: ImportPreviewRow = {
      ...r,
      accountId: account?.id ?? null,
      fingerprint,
      occurrence: occ[i]!,
      categoryId: categoryFor(r.categoryName),
      decision: 'new',
      matchedTransactionId: null,
    };
    if (!account) return { ...base, decision: 'needs_account' };
    const sameId =
      (r.externalId && byExternal.get(`${account.id}|${r.externalId}`)) ||
      (fingerprint && byFingerprint.get(`${account.id}|${fingerprint}`));
    if (sameId) {
      claimed.add(sameId.id);
      return { ...base, decision: 'already_imported', matchedTransactionId: sameId.id };
    }
    return base;
  });
  // Reconcile against rows that came from a sync or were typed in: same account,
  // same amount, date within 3 days, oldest first, each existing row used once.
  for (const row of rows) {
    if (row.decision !== 'new' || !row.accountId) continue;
    const match = existing
      .filter(
        (t) =>
          !claimed.has(t.id) &&
          t.source !== 'import' &&
          t.accountId === row.accountId &&
          t.amount === row.amount &&
          !t.splitParentId &&
          Math.abs(daysBetween(t.date, row.date)) <= 3,
      )
      .sort(
        (a, b) =>
          Math.abs(daysBetween(a.date, row.date)) - Math.abs(daysBetween(b.date, row.date)) ||
          a.createdAt.localeCompare(b.createdAt),
      )[0];
    if (match) {
      claimed.add(match.id);
      row.decision = 'existing';
      row.matchedTransactionId = match.id;
    }
  }

  const preview: ImportPreview = {
    importId: id,
    format,
    status:
      needsMapping && needsMapping.missing.length > 0 && !mapping ? 'needs_mapping' : 'preview',
    fileName: input.fileName,
    accountId: chosen?.id ?? null,
    rows,
    accountsToCreate: toCreate,
    errors: parsed.errors,
    warnings: [
      ...parsed.warnings,
      ...(earlier
        ? [
            `This exact file was imported before (${earlier.committed_at.slice(0, 10)}); matching rows will be skipped.`,
          ]
        : []),
    ],
    counts: {
      total: rows.length,
      new: rows.filter((r) => r.decision === 'new').length,
      alreadyImported: rows.filter((r) => r.decision === 'already_imported').length,
      existing: rows.filter((r) => r.decision === 'existing').length,
      needsAccount: rows.filter((r) => r.decision === 'needs_account').length,
    },
    csv: needsMapping,
    mapping,
    statementCheck,
    periodStart: period.start,
    periodEnd: period.end,
  };
  await db
    .prepare(
      'INSERT INTO imports (id, format, status, account_id, file_name, content_type, size, sha256, r2_key, rows_total, preview, period_start, period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      id,
      format,
      preview.status === 'needs_mapping' ? 'needs_mapping' : 'preview',
      chosen?.id ?? null,
      input.fileName,
      contentType,
      input.bytes.byteLength,
      sha256,
      r2Key,
      rows.length,
      JSON.stringify(preview),
      period.start,
      period.end,
      now,
      now,
    )
    .run();
  return preview;
}

export interface CommitOptions {
  /** Row line numbers the user unticked in the preview. */
  skipLines?: number[];
  /** Create accounts named in the file that don't exist yet (default true). */
  createAccounts?: boolean;
}

function newAccount(info: ParsedAccount, fallbackCurrency: string, now: string): Account {
  return {
    id: newId('acc'),
    name: info.name,
    institutionName: null,
    type: info.type ?? 'checking',
    subtype: null,
    currency: info.currency ?? fallbackCurrency,
    balance: info.balance ?? 0,
    balanceAsOf: now,
    availableBalance: null,
    creditLimit: null,
    mask: info.mask,
    connectionId: null,
    externalId: null,
    includeInNetWorth: true,
    hidden: false,
    isDefaultCash: false,
    interestRate: null,
    openedOn: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Step 2: writes the rows the preview marked new. Unique indexes on
 * (account, provider id) and (account, fingerprint) make a double commit or
 * a repeat import add nothing (check 2).
 */
export async function commitImport(
  env: Env,
  importId: Id,
  options: CommitOptions = {},
): Promise<ImportCommitResult> {
  const db = env.DB;
  const record = await loadRecord(db, importId);
  if (record.status === 'committed') throw conflict('This import was already saved.');
  if (record.status !== 'preview' || !record.preview)
    throw badRequest('This import has no preview to save.');
  const now = nowIso();
  // Lock: only one commit of an import can run.
  const lock = await db
    .prepare(
      "UPDATE imports SET status = 'committing', updated_at = ? WHERE id = ? AND status = 'preview'",
    )
    .bind(now, importId)
    .run();
  if ((lock.meta.changes ?? 0) !== 1) throw conflict('This import is already being saved.');
  try {
    return await commitLocked(env, importId, record.preview, options, now);
  } catch (e) {
    await db
      .prepare(
        "UPDATE imports SET status = 'preview', updated_at = ? WHERE id = ? AND status = 'committing'",
      )
      .bind(now, importId)
      .run();
    throw e;
  }
}

async function commitLocked(
  env: Env,
  importId: Id,
  preview: ImportPreview,
  options: CommitOptions,
  now: string,
): Promise<ImportCommitResult> {
  const db = env.DB;
  const skip = new Set(options.skipLines ?? []);

  // Accounts named in the file that don't exist yet.
  const created: Account[] = [];
  if (preview.accountsToCreate.length > 0 && options.createAccounts !== false) {
    const byName = new Map<string, Account>();
    for (const info of preview.accountsToCreate) {
      const acc = newAccount(info, 'USD', now);
      byName.set(info.name, acc);
      created.push(acc);
    }
    for (const row of preview.rows) {
      const acc =
        row.decision === 'needs_account' && row.accountName
          ? byName.get(row.accountName)
          : undefined;
      if (!acc) continue;
      row.accountId = acc.id;
      row.decision = 'new';
    }
    const occ = assignOccurrences(
      preview.rows.map((r) => ({ ...r, accountId: r.accountId ?? '' })),
    );
    preview.rows.forEach((r, i) => {
      if (r.accountId && !r.externalId && !r.fingerprint)
        r.fingerprint = importFingerprint(r.accountId, r, occ[i]!);
    });
  }
  const [tags, existingAccounts, categories] = await Promise.all([
    selectAll(db, tagsTable),
    selectAll(db, accountsTable),
    selectAll(db, categoriesTable),
  ]);
  const tagByName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const accounts = new Map([...existingAccounts, ...created].map((a) => [a.id, a]));
  const categoryFor = categoryMatcher(categories);

  if (created.length > 0) await runSpecs(db, bulkInsertSpecs(accountsTable, created));

  // Rules run in memory before the rows are written (one query for the rules, none per row).
  const rules = await selectAll(db, rulesTable, 'enabled = 1');
  const parents: Transaction[] = [];
  const childrenOf = new Map<Id, Transaction[]>();
  let skipped = 0;
  for (const row of preview.rows) {
    if (row.decision !== 'new' || !row.accountId || skip.has(row.line)) {
      if (row.decision === 'new' || row.decision === 'needs_account') skipped += 1;
      continue;
    }
    const account = accounts.get(row.accountId);
    if (!account) {
      skipped += 1;
      continue;
    }
    let txn = toTransaction(row, account, importId, tagByName, now);
    if (row.splits.length >= 2) {
      const built = buildSplitChildren(
        txn,
        row.splits.map((s) => ({
          amount: s.amount,
          categoryId: categoryFor(s.categoryName),
          notes: s.memo ?? undefined,
        })),
        () => newId('txn'),
        now,
      );
      txn = built.parent;
      childrenOf.set(txn.id, built.children);
    } else if (rules.length > 0) {
      txn = applyRules(txn, rules).transaction;
    }
    parents.push(txn);
  }

  // Multi-row writes (Free plan: about 50 D1 queries per invocation). The unique
  // fingerprint and provider-id indexes skip rows stored before; the new ids that
  // exist afterwards are the rows this commit added, and only their split
  // children are written.
  await runSpecs(db, bulkInsertSpecs(transactionsTable, parents, 'ignore'));
  const addedIds = new Set<string>();
  for (let i = 0; i < parents.length; i += 2000) {
    const res = await db
      .prepare('SELECT id FROM transactions WHERE id IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(parents.slice(i, i + 2000).map((t) => t.id)))
      .all<{ id: string }>();
    for (const r of res.results) addedIds.add(r.id);
  }
  const addedTxns = parents.filter((t) => addedIds.has(t.id));
  await runSpecs(
    db,
    bulkInsertSpecs(
      transactionsTable,
      addedTxns.flatMap((t) => childrenOf.get(t.id) ?? []),
    ),
  );
  const groups = parents;

  const added = addedTxns.length;
  const matched =
    preview.rows.filter((r) => r.decision === 'already_imported' || r.decision === 'existing')
      .length +
    (groups.length - added);
  await db
    .prepare(
      "UPDATE imports SET status = 'committed', rows_added = ?, rows_matched = ?, rows_skipped = ?, preview = ?, updated_at = ?, committed_at = ? WHERE id = ?",
    )
    .bind(added, matched, skipped, JSON.stringify(preview), now, now, importId)
    .run();
  if (preview.format === 'csv' && preview.mapping && preview.csv) {
    await db
      .prepare(
        'INSERT INTO import_mappings (signature, name, account_id, mapping, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (signature) DO UPDATE SET mapping = excluded.mapping, account_id = excluded.account_id, updated_at = excluded.updated_at',
      )
      .bind(
        preview.csv.signature,
        preview.fileName,
        preview.accountId,
        JSON.stringify(preview.mapping),
        now,
        now,
      )
      .run();
  }
  const ids = addedTxns.map((t) => t.id);
  const atm = await recordAtmWithdrawals(db, addedTxns);
  const match = await runTransferMatcher(db);
  return {
    importId,
    added,
    matched,
    skipped,
    accountsCreated: created.map((a) => a.id),
    transactionIds: ids,
    linked: match.linked + atm,
    suggested: match.suggested,
  };
}

function toTransaction(
  row: ImportPreviewRow,
  account: Account,
  importId: Id,
  tagByName: Map<string, Id>,
  now: string,
): Transaction {
  return makeTransaction(
    {
      accountId: account.id,
      date: row.date,
      amount: row.amount,
      currency: account.currency,
      originalAmount: row.amount,
      originalCurrency: row.currency ?? account.currency,
      rawName: row.rawName,
      notes: row.notes,
      categoryId: row.categoryId,
      categorySource: row.categoryId ? 'import' : null,
      kind: row.kindHint ?? 'regular',
      pending: row.pending,
      tagIds: row.tags
        .map((t) => tagByName.get(t.toLowerCase()))
        .filter((t): t is Id => Boolean(t)),
      source: 'import',
      importId,
      externalId: row.externalId,
      importFingerprint: row.externalId ? null : row.fingerprint,
    },
    now,
  );
}

export async function discardImport(db: D1Database, importId: Id): Promise<void> {
  const record = await loadRecord(db, importId);
  if (record.status === 'committed')
    throw conflict('Saved imports can be undone with DELETE /v1/imports/:id/transactions.');
  await db
    .prepare("UPDATE imports SET status = 'discarded', updated_at = ? WHERE id = ?")
    .bind(nowIso(), importId)
    .run();
}

/** Removes the transactions an import added (the original file stays in the vault). */
export async function undoImport(db: D1Database, importId: Id): Promise<number> {
  await loadRecord(db, importId);
  const now = nowIso();
  const res = await db.batch([
    db
      .prepare(
        "UPDATE transfer_links SET status = 'rejected', updated_at = ? WHERE out_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?) OR in_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)",
      )
      .bind(now, importId, importId),
    db
      .prepare(
        "UPDATE transactions SET transfer_link_id = NULL WHERE transfer_link_id IN (SELECT id FROM transfer_links WHERE status = 'rejected' AND (out_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?) OR in_transaction_id IN (SELECT id FROM transactions WHERE import_id = ?)))",
      )
      .bind(importId, importId),
    db.prepare('DELETE FROM transactions WHERE import_id = ?').bind(importId),
    db
      .prepare("UPDATE imports SET status = 'undone', updated_at = ? WHERE id = ?")
      .bind(now, importId),
  ]);
  return res[2]?.meta.changes ?? 0;
}

export type { ParsedImportRow };
