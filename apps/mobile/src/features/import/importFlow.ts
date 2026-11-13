import {
  parseDateWithFormat,
  type Account,
  type CsvMapping,
  type CurrencyCode,
  type Id,
  type ImportCommitResult,
  type ImportDuplicateCandidate,
  type ImportPreview,
  type ImportPreviewOptions,
  type ImportPreviewRow,
  type ImportRecord,
  type ParsedAccount,
} from '@manaclaude/shared';

/**
 * The rules of the import screen, with no screen in them: what is sent for a
 * preview, which rows a save would add or leave out, what still stops a
 * save, and the totals to compare against the source. Everything here is a
 * pure function of the preview and the choices made.
 */

/** Where the rows of one account named in the file go. */
export type SourceChoice =
  /** Let the file decide: an existing account with that name or number, else a new account. */
  | { kind: 'file' }
  | { kind: 'account'; accountId: Id }
  /** Leave every row of this source out of the import. */
  | { kind: 'skip' };

/** The choices on screen. A preview is made from them; changing most of them needs a new preview. */
export interface ImportOptions {
  /** Inclusive, "YYYY-MM-DD"; '' means no limit. */
  fromDate: string;
  toDate: string;
  /** The destination of a file that does not name its account. */
  accountId: Id | null;
  /** Per account named in the file. A missing entry means { kind: 'file' }. */
  sources: Record<string, SourceChoice>;
  /** How ambiguous dates are read (Monefy, QIF); null lets the backend decide. */
  dayFirst: boolean | null;
  /** For files with no currency of their own; null lets the destination decide. */
  currency: CurrencyCode | null;
  /** CSV columns chosen by hand; null uses the saved or suggested ones. */
  mapping: CsvMapping | null;
  /** CSV: lines above the header. Only used while `mapping` is null. */
  skipRows: number | null;
}

export const EMPTY_OPTIONS: ImportOptions = {
  fromDate: '',
  toDate: '',
  accountId: null,
  sources: {},
  dayFirst: null,
  currency: null,
  mapping: null,
  skipRows: null,
};

export function isLocalDate(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && parseDateWithFormat(text, 'YYYY-MM-DD') !== null;
}

/** A plain sentence when the dates cannot be used; null when they are fine. */
export function dateProblem(options: Pick<ImportOptions, 'fromDate' | 'toDate'>): string | null {
  const { fromDate, toDate } = options;
  if (fromDate && !isLocalDate(fromDate)) return 'Write the first date as YYYY-MM-DD.';
  if (toDate && !isLocalDate(toDate)) return 'Write the last date as YYYY-MM-DD.';
  if (fromDate && toDate && fromDate > toDate) return 'The first date is after the last date.';
  return null;
}

/** What POST /v1/imports is sent for these choices. */
export function toRequest(options: ImportOptions): ImportPreviewOptions {
  const req: ImportPreviewOptions = {};
  const mappings: Record<string, Id> = {};
  for (const [name, choice] of Object.entries(options.sources))
    if (choice.kind === 'account') mappings[name] = choice.accountId;
  if (Object.keys(mappings).length > 0) req.accountMappings = mappings;
  else if (options.accountId) req.accountId = options.accountId;
  if (options.fromDate) req.fromDate = options.fromDate;
  if (options.toDate) req.toDate = options.toDate;
  if (options.currency) req.currency = options.currency;
  if (options.dayFirst !== null) req.preferDayFirst = options.dayFirst;
  if (options.mapping) {
    req.mapping = options.mapping;
    if (options.mapping.skipRows > 0) req.skipRows = options.mapping.skipRows;
  } else if (options.skipRows) req.skipRows = options.skipRows;
  return req;
}

/** Two sets of choices with the same key give the same preview. ("Leave out" needs no new preview.) */
export function requestKey(options: ImportOptions): string {
  const req = toRequest(options);
  return JSON.stringify(
    Object.keys(req)
      .sort()
      .map((k) => [k, (req as Record<string, unknown>)[k]]),
  );
}

/** One account named in the file, and what the backend would do with it by itself. */
export interface SourceInfo {
  name: string;
  rows: number;
  /** The existing account its rows resolved to (by mapping, name or number). */
  resolvedAccountId: Id | null;
  /** The account the save would make for it; null when it resolved or cannot be made. */
  create: ParsedAccount | null;
}

export function sourcesOf(preview: ImportPreview): SourceInfo[] {
  const byName = new Map<string, SourceInfo>();
  for (const row of preview.rows) {
    if (!row.accountName) continue;
    const info = byName.get(row.accountName);
    if (info) info.rows += 1;
    else
      byName.set(row.accountName, {
        name: row.accountName,
        rows: 1,
        resolvedAccountId: row.accountId,
        create: preview.accountsToCreate.find((a) => a.name === row.accountName) ?? null,
      });
  }
  return [...byName.values()];
}

/** The choices made while looking at one preview. */
export interface Review {
  /** Possible duplicates, by the file row's line. */
  decisions: Record<number, 'keep' | 'skip'>;
  /** The lines that could not be read are knowingly left out. */
  skipErrors: boolean;
}

export const EMPTY_REVIEW: Review = { decisions: {}, skipErrors: false };

function leftOutBySource(row: ImportPreviewRow, options: ImportOptions): boolean {
  return row.accountName !== null && options.sources[row.accountName]?.kind === 'skip';
}

/** The skipLines and keepLines of the commit request. */
export function commitLines(
  preview: ImportPreview,
  options: ImportOptions,
  review: Review,
): { skipLines: number[]; keepLines: number[] } {
  const skip = new Set<number>();
  for (const row of preview.rows) if (leftOutBySource(row, options)) skip.add(row.line);
  if (review.skipErrors) for (const e of preview.errors) skip.add(e.line);
  const keep = new Set<number>();
  for (const c of preview.duplicateCandidates ?? []) {
    const decision = review.decisions[c.line];
    if (decision === 'skip') skip.add(c.line);
    else if (decision === 'keep' && !skip.has(c.line)) keep.add(c.line);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { skipLines: sorted(skip), keepLines: sorted(keep) };
}

/** Does the date order still need an explicit answer before this preview may be saved? */
export function needsDateConfirmation(preview: ImportPreview, used: ImportOptions): boolean {
  if (preview.requiresDateConfirmation) return true;
  const csv = preview.csv;
  return Boolean(csv && csv.dateFormatAmbiguous && !csv.usedSavedMapping && !used.mapping);
}

/** Money in and out for one destination and currency, straight from the file's rows. */
export interface TotalLine {
  key: string;
  label: string;
  /** The save makes this account. */
  isNew: boolean;
  currency: CurrencyCode;
  count: number;
  /** Sum of positive amounts, in minor units. */
  moneyIn: number;
  /** Sum of negative amounts as a positive number, in minor units. */
  moneyOut: number;
}

export interface ImportPlan {
  /** Rows a save would add. */
  importing: ImportPreviewRow[];
  /** Rows already stored from an earlier import of the same file rows. */
  alreadyThere: number;
  /** Rows left out by choice: a source left out, or a duplicate skipped. */
  leftOut: number;
  /** Rows with no destination and none that can be made. */
  unplaced: number;
  /** Possible duplicates with no keep or skip yet. */
  undecided: ImportDuplicateCandidate[];
  /** Unreadable lines not yet acknowledged. */
  unreadable: number;
  /** Plain sentences, each one a reason the save is not allowed yet. Empty means ready. */
  blockers: string[];
  totals: TotalLine[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Everything the screen needs to know about what a save would do right now. */
export function planImport(
  preview: ImportPreview,
  options: ImportOptions,
  used: ImportOptions,
  review: Review,
  accounts: readonly Account[],
): ImportPlan {
  const { skipLines } = commitLines(preview, options, review);
  const skip = new Set(skipLines);
  const creatable = new Set(preview.accountsToCreate.map((a) => a.name));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const importing: ImportPreviewRow[] = [];
  let alreadyThere = 0;
  let leftOut = 0;
  let unplaced = 0;
  for (const row of preview.rows) {
    if (skip.has(row.line)) leftOut += 1;
    else if (row.decision === 'already_imported' || row.decision === 'existing') alreadyThere += 1;
    else if (
      row.decision === 'needs_account' &&
      !(row.accountName && creatable.has(row.accountName))
    )
      unplaced += 1;
    else importing.push(row);
  }
  const undecided = (preview.duplicateCandidates ?? []).filter(
    (c) => !skip.has(c.line) && review.decisions[c.line] === undefined,
  );
  const unreadable = review.skipErrors ? 0 : preview.errors.length;

  const lines = new Map<string, TotalLine>();
  for (const row of importing) {
    const account = row.accountId ? byId.get(row.accountId) : undefined;
    const create = preview.accountsToCreate.find((a) => a.name === row.accountName);
    const currency = row.currency ?? account?.currency ?? create?.currency ?? 'USD';
    const label = account?.name ?? row.accountName ?? 'Account';
    const key = `${row.accountId ?? `new:${row.accountName ?? ''}`}|${currency}`;
    const line = lines.get(key) ?? {
      key,
      label,
      isNew: !row.accountId,
      currency,
      count: 0,
      moneyIn: 0,
      moneyOut: 0,
    };
    line.count += 1;
    if (row.amount >= 0) line.moneyIn += row.amount;
    else line.moneyOut -= row.amount;
    lines.set(key, line);
  }

  const blockers: string[] = [];
  if (requestKey(options) !== requestKey(used))
    blockers.push('You changed the choices above. Update the preview before importing.');
  if (preview.status === 'needs_mapping') blockers.push('Choose the columns first.');
  else {
    if (needsDateConfirmation(preview, used))
      blockers.push('Confirm how the dates in the file are written.');
    if (unplaced > 0)
      blockers.push(
        `${plural(unplaced, 'row has', 'rows have')} no account yet. Choose where they go.`,
      );
    if (undecided.length > 0)
      blockers.push(
        `${plural(undecided.length, 'possible duplicate needs', 'possible duplicates need')} a choice: keep or skip.`,
      );
    if (unreadable > 0)
      blockers.push(
        `${plural(unreadable, 'line', 'lines')} could not be read. Fix the file, or choose to leave ${unreadable === 1 ? 'it' : 'them'} out.`,
      );
    if (importing.length === 0 && blockers.length === 0) blockers.push('Nothing new to import.');
  }
  return {
    importing,
    alreadyThere,
    leftOut,
    unplaced,
    undecided,
    unreadable,
    blockers,
    totals: [...lines.values()],
  };
}

const sameRow = (a: ImportPreviewRow | undefined, b: ImportPreviewRow | undefined) =>
  Boolean(
    a &&
    b &&
    a.date === b.date &&
    a.amount === b.amount &&
    a.rawName === b.rawName &&
    a.accountName === b.accountName,
  );

/**
 * After a new preview of the same file: keeps a keep/skip answer only when
 * the same file row is still compared against exactly the same stored
 * transactions. Anything that changed has to be looked at again.
 */
export function carryDecisions(
  before: ImportPreview | null,
  after: ImportPreview,
  decisions: Review['decisions'],
): Review['decisions'] {
  if (!before) return {};
  const kept: Review['decisions'] = {};
  for (const candidate of after.duplicateCandidates ?? []) {
    const decision = decisions[candidate.line];
    const old = (before.duplicateCandidates ?? []).find((c) => c.line === candidate.line);
    if (!decision || !old) continue;
    const ids = (c: ImportDuplicateCandidate) => [...c.transactionIds].sort().join('|');
    const row = (p: ImportPreview) => p.rows.find((r) => r.line === candidate.line);
    if (ids(old) === ids(candidate) && sameRow(row(before), row(after)))
      kept[candidate.line] = decision;
  }
  return kept;
}

/** The counts of a saved import, read back from its record (used when the answer to the save was lost). */
export function resultFromRecord(record: ImportRecord): ImportCommitResult {
  return {
    importId: record.id,
    added: record.rowsAdded,
    matched: record.rowsMatched,
    skipped: record.rowsSkipped,
    accountsCreated: [],
    transactionIds: [],
    linked: 0,
    suggested: 0,
    warnings: record.error ? [record.error] : [],
  };
}

/** First and last transaction date among the rows; null for an empty preview. */
export function rowSpan(rows: readonly { date: string }[]): { first: string; last: string } | null {
  if (rows.length === 0) return null;
  let first = rows[0]!.date;
  let last = first;
  for (const r of rows) {
    if (r.date < first) first = r.date;
    if (r.date > last) last = r.date;
  }
  return { first, last };
}
