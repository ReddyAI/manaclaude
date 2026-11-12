import {
  applyRules,
  assignOccurrences,
  buildSplitChildren,
  csvHeaderSignature,
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
import { bulkInsertSpecs, runSpecs, type StatementSpec } from '../db/bulk';
import { selectAll } from '../db/table';
import {
  accountsTable,
  categoriesTable,
  categoryGroupsTable,
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
import { categoryMatcher, monefyCategories } from './categories';
import { extractStatement } from './pdf';
import { isMonefyCsv, parseMonefyCsv } from './monefy';
import {
  duplicateCandidates,
  existingForRows,
  requireCurrency,
  sameImportIdentity,
  validateDateRange,
  type SafeImportPreview,
} from './safety';

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
  /** Inclusive transaction dates; no change to automatic bank sync schedules. */
  fromDate?: string;
  toDate?: string;
  /** Explicit destinations for names in multi-account exports. */
  accountMappings?: Record<string, Id>;
  /** Currency for formats that do not carry it, when no destination is selected. */
  currency?: string;
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
    if (byMask.length > 1)
      throw badRequest(
        'More than one account matches the statement mask. Select a destination explicitly.',
      );
  }
  if (parsed.name) {
    const n = parsed.name.trim().toLowerCase();
    const byName = accounts.filter((a) => a.name.trim().toLowerCase() === n);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1)
      throw badRequest(
        'More than one account matches the file name. Select a destination explicitly.',
      );
  }
  return null;
}

async function loadRecord(
  db: D1Database,
  id: Id,
): Promise<ImportRecord & { preview: SafeImportPreview | null }> {
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
    preview: row.preview ? (JSON.parse(String(row.preview)) as SafeImportPreview) : null,
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
  const currency = account?.currency ?? input.currency ?? 'USD';
  const preferDayFirst = input.preferDayFirst ?? currency === 'INR';
  const none = { start: null, end: null };
  switch (format) {
    case 'csv': {
      if (isMonefyCsv(text)) {
        if (input.mapping || input.skipRows)
          throw badRequest('Monefy columns are fixed; remove the custom CSV mapping or preamble.');
        return {
          parsed: await parseMonefyCsv(text, input.preferDayFirst),
          mapping: null,
          needsMapping: null,
          period: none,
          statementCheck: null,
        };
      }
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
      if (!account && !input.currency)
        throw badRequest('QIF does not specify currency. Select an account or provide a currency.');
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
): Promise<SafeImportPreview> {
  const db = env.DB;
  validateDateRange(input.fromDate, input.toDate);
  if (input.currency && !/^[A-Z]{3}$/.test(input.currency))
    throw badRequest('Currency must be a three-letter uppercase code.');
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
  const saveOriginal = () =>
    env.FILES.put(r2Key, input.bytes, {
      httpMetadata: { contentType },
      customMetadata: { importId: id, sha256, fileName: input.fileName.slice(0, 200) },
    });
  const removeUnlistedOriginal = async (error: unknown): Promise<never> => {
    await env.FILES.delete(r2Key);
    throw error;
  };
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
    await saveOriginal();
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
      .run()
      .catch(removeUnlistedOriginal);
    throw badRequest(
      message,
      e instanceof Error && e.name === 'AiDisabledError' ? 'ai_disabled' : 'unreadable_file',
    );
  }
  const { parsed, mapping, needsMapping, period, statementCheck } = parsedResult;
  const monefy = format === 'csv' && isMonefyCsv(text);
  const sourceNames = new Set(parsed.rows.map((r) => r.accountName));
  if (chosen && sourceNames.size > 1)
    throw badRequest(
      'This file contains multiple accounts. Map each account separately instead of selecting one destination.',
    );
  const totalParsed = parsed.rows.length;
  parsed.rows = parsed.rows.filter(
    (r) =>
      (!input.fromDate || r.date >= input.fromDate) && (!input.toDate || r.date <= input.toDate),
  );

  // Resolve the account of each row.
  const accountFor = new Map<string, Account | null>();
  const toCreate: ParsedAccount[] = [];
  const resolve = (name: string | null): Account | null => {
    if (!name) return chosen;
    if (accountFor.has(name)) return accountFor.get(name)!;
    const info = parsed.accounts.find((a) => a.name === name);
    const mappedId = input.accountMappings?.[name];
    const mapped = mappedId ? accounts.find((a) => a.id === mappedId) : undefined;
    if (mappedId && !mapped) throw badRequest('An account mapping points to a missing account.');
    const found = chosen ?? mapped ?? matchAccount(accounts, { name, mask: info?.mask });
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
  const categoryFor = categoryMatcher(await selectAll(db, categoriesTable));

  const rows: ImportPreviewRow[] = parsed.rows.map((r, i) => {
    const account = rowAccounts[i] ?? null;
    const fingerprint = account && !r.externalId ? importFingerprint(account.id, r, occ[i]!) : null;
    const base: ImportPreviewRow = {
      ...r,
      currency:
        r.currency ??
        account?.currency ??
        parsed.accounts.find((a) => a.name === r.accountName)?.currency ??
        null,
      accountId: account?.id ?? null,
      fingerprint,
      occurrence: occ[i]!,
      categoryId: monefy ? null : categoryFor(r.categoryName),
      decision: 'new',
      matchedTransactionId: null,
    };
    if (!account) return { ...base, decision: 'needs_account' };
    requireCurrency(base, account);
    return base;
  });
  const existing = await existingForRows(db, rows);
  for (const row of rows) {
    const match = existing.find((t) => sameImportIdentity(row, t));
    if (match) {
      row.decision = 'already_imported';
      row.matchedTransactionId = match.id;
    }
  }
  const candidates = duplicateCandidates(rows, existing, new Map(accounts.map((a) => [a.id, a])));

  const preview: SafeImportPreview = {
    ...(monefy ? { sourceFormat: 'monefy' as const } : {}),
    requiresDateConfirmation:
      monefy && parsed.dateFormatAmbiguous && input.preferDayFirst === undefined,
    duplicateCandidates: candidates,
    dateRange: {
      from: input.fromDate ?? null,
      to: input.toDate ?? null,
      excluded: totalParsed - parsed.rows.length,
    },
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
      ...(candidates.length
        ? [
            'Possible duplicates need review before saving. Similar amounts and dates do not prove that transactions are the same.',
          ]
        : []),
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
  // Only keep an upload when it has a corresponding preview/failed record.
  // Rejected account/currency selections must not leave an unlisted vault file.
  await saveOriginal();
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
    .run()
    .catch(removeUnlistedOriginal);
  return preview;
}

export interface CommitOptions {
  /** Row line numbers the user unticked in the preview. */
  skipLines?: number[];
  /** Create accounts named in the file that don't exist yet (default true). */
  createAccounts?: boolean;
  /** Possible duplicates explicitly confirmed as distinct transactions. */
  keepLines?: number[];
}

export interface ImportSaveResult extends ImportCommitResult {
  warnings: string[];
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
  clock: () => Date = () => new Date(),
): Promise<ImportSaveResult> {
  const db = env.DB;
  const record = await loadRecord(db, importId);
  if (record.status === 'committed') throw conflict('This import was already saved.');
  if (!['preview', 'committing'].includes(record.status) || !record.preview)
    throw badRequest('This import has no preview to save.');
  const now = clock().toISOString();
  const staleBefore = new Date(Date.parse(now) - 5 * 60_000).toISOString();
  // Lock: only one commit of an import can run.
  const lock = await db
    .prepare(
      "UPDATE imports SET status = 'committing', updated_at = ? WHERE id = ? AND (status = 'preview' OR (status = 'committing' AND updated_at < ?))",
    )
    .bind(now, importId, staleBefore)
    .run();
  if ((lock.meta.changes ?? 0) !== 1) throw conflict('This import is already being saved.');
  try {
    return await commitLocked(env, importId, record.preview, options, now);
  } catch (e) {
    await db
      .prepare(
        "UPDATE imports SET status = 'preview', updated_at = ? WHERE id = ? AND status = 'committing' AND updated_at = ?",
      )
      .bind(now, importId, now)
      .run();
    throw e;
  }
}

async function commitLocked(
  env: Env,
  importId: Id,
  preview: SafeImportPreview,
  options: CommitOptions,
  now: string,
): Promise<ImportSaveResult> {
  const db = env.DB;
  const skip = new Set(options.skipLines ?? []);
  const keep = new Set(options.keepLines ?? []);
  if ([...skip].some((line) => keep.has(line)))
    throw badRequest('A row cannot be both kept and skipped.');
  if (preview.requiresDateConfirmation)
    throw badRequest(
      'Confirm Monefy date order by previewing again with preferDayFirst set to true or false.',
    );
  if (preview.errors.some((error) => !skip.has(error.line)))
    throw badRequest(
      'Some rows could not be read. Correct the file or explicitly skip those lines before saving.',
      'import_parse_errors',
    );
  if (preview.rows.length === 0)
    throw badRequest('No transactions are available in the selected import period.');

  const [tags, existingAccounts, categories] = await Promise.all([
    selectAll(db, tagsTable),
    selectAll(db, accountsTable),
    selectAll(db, categoriesTable),
  ]);

  // Accounts named in the file that don't exist yet.
  const created: Account[] = [];
  if (preview.accountsToCreate.length > 0 && options.createAccounts !== false) {
    const byName = new Map<string, Account>();
    for (const info of preview.accountsToCreate) {
      if (!preview.rows.some((r) => r.accountName === info.name && !skip.has(r.line))) continue;
      // Another preview may have created the same account since this one was shown.
      const current = matchAccount(existingAccounts, info);
      const acc = current ?? newAccount(info, 'USD', now);
      if (!current) {
        const identity = JSON.stringify([
          preview.format,
          info.name.trim().toLowerCase(),
          acc.currency,
        ]);
        acc.id = `acc_import_${await sha256Hex(new TextEncoder().encode(identity))}`;
      }
      if (!current && preview.sourceFormat === 'monefy') acc.includeInNetWorth = false;
      byName.set(info.name, acc);
      if (!current) created.push(acc);
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
  const tagByName = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const accounts = new Map([...existingAccounts, ...created].map((a) => [a.id, a]));
  const categoryFor = categoryMatcher(categories);
  for (const row of preview.rows) {
    if (skip.has(row.line)) continue;
    const account = row.accountId ? accounts.get(row.accountId) : null;
    if (!account)
      throw badRequest(
        `Line ${row.line} has no destination account. Select an account and preview again.`,
        'import_account_required',
      );
    requireCurrency(row, account);
  }
  const existing = await existingForRows(db, preview.rows);
  for (const row of preview.rows) {
    if (skip.has(row.line)) continue;
    const same = existing.find((t) => sameImportIdentity(row, t));
    if (same) {
      row.decision = 'already_imported';
      row.matchedTransactionId = same.id;
    } else if (row.decision === 'already_imported' || row.decision === 'existing') {
      throw conflict('Transactions changed since this preview. Preview the file again.');
    }
  }
  const candidates = duplicateCandidates(preview.rows, existing, accounts);
  const unresolved = candidates.filter(
    (candidate) => !skip.has(candidate.line) && !keep.has(candidate.line),
  );
  if (unresolved.length)
    throw badRequest(
      `Review possible duplicates on lines ${unresolved.map((c) => c.line).join(', ')}. Explicitly keep or skip each row before saving.`,
      'import_duplicates_require_review',
    );
  const newRows = preview.rows.filter((r) => r.decision === 'new' && !skip.has(r.line));
  const custom =
    preview.sourceFormat === 'monefy'
      ? monefyCategories(newRows, categories)
      : { groups: [], categories: [] };

  // Rules run in memory before the rows are written (one query for the rules, none per row).
  const rules = await selectAll(db, rulesTable, 'enabled = 1');
  const parents: Transaction[] = [];
  const childrenOf = new Map<Id, Transaction[]>();
  let skipped = preview.errors.filter((error) => skip.has(error.line)).length;
  for (const row of preview.rows) {
    if (skip.has(row.line)) {
      skipped += 1;
      continue;
    }
    if (row.decision !== 'new') continue;
    const account = accounts.get(row.accountId!)!;
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
    } else if (rules.length > 0 && preview.sourceFormat !== 'monefy') {
      txn = applyRules(txn, rules).transaction;
    }
    parents.push(txn);
  }

  // Accounts, categories, parents, children, mapping and completion are ONE D1
  // transaction. A failure rolls back every write, so retry cannot lose splits
  // or create a second set of accounts.
  const parentIndex = Object.keys(transactionsTable.columns).indexOf('splitParentId');
  const children = bulkInsertSpecs(transactionsTable, [...childrenOf.values()].flat()).map((s) => ({
    ...s,
    sql: `${s.sql} AND json_extract(value, '$[${parentIndex}]') IN (SELECT id FROM transactions WHERE import_id = ?)`,
    params: [...s.params, importId],
  }));
  const matchedBefore = preview.rows.filter(
    (r) => !skip.has(r.line) && r.decision === 'already_imported',
  ).length;
  const countParents =
    '(SELECT count(*) FROM transactions WHERE import_id = ? AND split_parent_id IS NULL)';
  const unreviewed = newRows
    .filter((r) => !keep.has(r.line))
    .map((r) => ({
      accountId: r.accountId,
      date: r.date,
      amount: r.amount,
      currency: r.currency ?? accounts.get(r.accountId!)!.currency,
      externalId: r.externalId,
      fingerprint: r.fingerprint,
    }));
  const specs: StatementSpec[] = [
    {
      // Fail the whole batch if a concurrent save/sync invalidated our review,
      // or another invocation reclaimed the lease. status is NOT NULL.
      sql: `UPDATE imports SET status = CASE WHEN status = 'committing' AND updated_at = ? AND NOT EXISTS (
        SELECT 1 FROM json_each(?) j JOIN transactions t
        ON t.account_id = json_extract(j.value, '$.accountId')
        AND t.currency = json_extract(j.value, '$.currency')
        AND t.amount = json_extract(j.value, '$.amount')
        AND abs(julianday(t.date) - julianday(json_extract(j.value, '$.date'))) <= 3
        WHERE t.split_parent_id IS NULL AND NOT (
          coalesce(t.source = 'import' AND t.external_id = json_extract(j.value, '$.externalId'), 0)
          OR coalesce(t.import_fingerprint = json_extract(j.value, '$.fingerprint'), 0)
        )
      ) THEN status ELSE NULL END WHERE id = ?`,
      params: [now, JSON.stringify(unreviewed), importId],
      rows: 1,
    },
    ...bulkInsertSpecs(accountsTable, created),
    ...bulkInsertSpecs(categoryGroupsTable, custom.groups),
    ...bulkInsertSpecs(categoriesTable, custom.categories),
    ...bulkInsertSpecs(transactionsTable, parents, 'ignore'),
    ...children,
    {
      sql: `UPDATE imports SET status = 'committed', rows_added = ${countParents}, rows_matched = ? - ${countParents}, rows_skipped = ?, preview = ?, updated_at = ?, committed_at = ? WHERE id = ? AND status = 'committing'`,
      params: [
        importId,
        matchedBefore + parents.length,
        importId,
        skipped,
        JSON.stringify(preview),
        now,
        now,
        importId,
      ],
      rows: 1,
    },
  ];
  if (preview.format === 'csv' && preview.mapping && preview.csv) {
    specs.push({
      sql: 'INSERT INTO import_mappings (signature, name, account_id, mapping, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (signature) DO UPDATE SET mapping = excluded.mapping, account_id = excluded.account_id, updated_at = excluded.updated_at',
      params: [
        preview.csv.signature,
        preview.fileName,
        preview.accountId,
        JSON.stringify(preview.mapping),
        now,
        now,
      ],
      rows: 1,
    });
  }
  // Leave room for reads and post-processing on Workers Free. Do not split the
  // transaction into independently committed batches to fit an oversized file.
  if (specs.length > 20)
    throw badRequest(
      'This import is too large to save safely in one request. Choose a shorter date period.',
    );
  try {
    await runSpecs(db, specs);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('NOT NULL constraint failed: imports.status')
    )
      throw conflict(
        'Transactions or import state changed while saving. Preview the file again.',
        'import_preview_changed',
      );
    throw error;
  }
  const addedTxns = await selectAll(
    db,
    transactionsTable,
    'import_id = ? AND split_parent_id IS NULL',
    [importId],
  );
  const added = addedTxns.length;
  const matched = matchedBefore + parents.length - added;
  const ids = addedTxns.map((t) => t.id);
  let atm = 0;
  let match = { linked: 0, suggested: 0 };
  const warnings: string[] = [];
  try {
    if (preview.sourceFormat !== 'monefy') {
      atm = await recordAtmWithdrawals(db, addedTxns);
      match = await runTransferMatcher(db);
    }
  } catch {
    // The import is already durably saved. Do not report it as failed or invite
    // a retry just because optional transfer processing failed.
    const message = 'Transactions saved; automatic transfer processing needs to be retried.';
    warnings.push(message);
    await db
      .prepare('UPDATE imports SET error = ? WHERE id = ?')
      .bind(message, importId)
      .run()
      .catch(() => {
        /* A warning-write failure must not turn a saved import into a reported failure. */
      });
  }
  return {
    importId,
    added,
    matched,
    skipped,
    accountsCreated: created.map((a) => a.id),
    transactionIds: ids,
    linked: match.linked + atm,
    suggested: match.suggested,
    warnings,
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
      userEditedFields:
        row.externalId?.startsWith('monefy:') && row.categoryId ? ['categoryId', 'notes'] : [],
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
  if (record.status === 'committing') throw conflict('This import is being saved.');
  const changed = await db
    .prepare(
      "UPDATE imports SET status = 'discarded', updated_at = ? WHERE id = ? AND status NOT IN ('committed', 'committing')",
    )
    .bind(nowIso(), importId)
    .run();
  if (!changed.meta.changes) throw conflict('This import changed. Refresh before discarding it.');
}

/** Removes the transactions an import added (the original file stays in the vault). */
export async function undoImport(db: D1Database, importId: Id): Promise<number> {
  const record = await loadRecord(db, importId);
  if (record.status === 'undone') return 0;
  if (record.status !== 'committed') throw conflict('Only a saved import can be undone.');
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
