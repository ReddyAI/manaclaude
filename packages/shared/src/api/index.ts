/**
 * Request and response types for the Worker API (/v1). The app imports these
 * so both sides agree. Every amount is integer minor units plus a currency.
 * Every request needs `Authorization: Bearer <APP_API_TOKEN>`.
 */
import type { AiProvider, Settings, MoneyPolicies } from '../model/settings';
import type { CurrencyCode, Id, IsoDateTime, LocalDate, MinorUnits } from '../model/common';
import type { FinanceDataset } from '../model/dataset';
import type { FxRate } from '../model/fx';
import type { Receipt } from '../model/receipt';
import type { Recap } from '../model/recap';
import type { RecurringItem } from '../model/recurring';
import type { Rule } from '../model/rule';
import type {
  SplitLineInput,
  Transaction,
  TransactionKind,
  TransferLink,
} from '../model/transaction';
import type { Account } from '../model/account';
import type { Category } from '../model/category';
import type { CsvMapping } from '../import/csv';
import type { StatementCheck } from '../import/statement';
import type {
  DateFormat,
  ImportFormat,
  ParseIssue,
  ParsedAccount,
  ParsedImportRow,
} from '../import/types';

/** Error body for every non-2xx response. */
export interface ApiErrorBody {
  error: string;
  message: string;
}

/** GET /v1/dataset */
export type DatasetResponse = FinanceDataset;

/** GET /v1/transactions?from&to&accountId&categoryId&q&limit&offset */
export interface TransactionListResponse {
  transactions: Transaction[];
}

/** PATCH /v1/transactions/:id. Each field sent is marked as edited by the user. */
export interface TransactionPatchRequest {
  name?: string;
  date?: LocalDate;
  amount?: MinorUnits;
  categoryId?: Id | null;
  merchantId?: Id | null;
  kind?: TransactionKind;
  notes?: string | null;
  tagIds?: Id[];
  excluded?: boolean;
  reviewed?: boolean;
}

/** PATCH /v1/transactions/:id, POST /v1/transactions/:id/review and /category */
export interface TransactionResponse {
  transaction: Transaction;
}

/** POST /v1/transactions/:id/review */
export interface ReviewRequest {
  reviewed: boolean;
}

/** POST /v1/transactions/:id/split */
export interface SplitRequestBody {
  lines: SplitLineInput[];
  /** Same key on a retry or double tap returns the first result. */
  idempotencyKey: string;
}

/** POST /v1/transactions/:id/split and DELETE (undo) */
export interface SplitResponse {
  parent: Transaction;
  children: Transaction[];
  replayed: boolean;
}

/** POST /v1/transactions/:id/link */
export interface LinkRequest {
  otherTransactionId: Id;
}

export interface LinkResponse {
  link: TransferLink;
}

/** GET /v1/transfer-links?status=suggested */
export interface LinkListResponse {
  links: TransferLink[];
}

/** POST /v1/cash: fast cash entry. Negative amount = spending. */
export interface CashRequest {
  amount: MinorUnits;
  currency: CurrencyCode;
  categoryId?: Id | null;
  name?: string;
  date?: LocalDate;
  notes?: string | null;
  accountId?: Id;
}

export interface CashResponse {
  transaction: Transaction;
}

/** POST /v1/accounts/cash */
export interface CreateCashAccountRequest {
  name: string;
  currency: CurrencyCode;
  balance?: MinorUnits;
  isDefault?: boolean;
}

export interface AccountResponse {
  account: Account;
}

/** POST /v1/categories */
export type CreateCategoryRequest = Omit<Category, 'id' | 'order' | 'archived'> & {
  order?: number;
};

/** GET /v1/categories: every category, archived ones included, by `order`. */
export interface CategoriesResponse {
  categories: Category[];
}

/** POST /v1/categories (201) and PATCH /v1/categories/:id */
export interface CategoryResponse {
  category: Category;
}

/** PATCH /v1/categories/:id. Only these keys are accepted; any other key is refused. */
export interface CategoryPatchRequest {
  name?: string;
  archived?: boolean;
  excludeFromBudget?: boolean;
  order?: number;
}

/** POST /v1/rules, PUT /v1/rules/:id */
export type RuleInput = Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'source'>;

export interface RuleResponse {
  rule: Rule;
  /** Transactions changed when the rule was applied to existing rows. */
  applied: number;
}

/** GET /v1/rules, by priority. */
export interface RulesResponse {
  rules: Rule[];
}

/** POST /v1/rules/run: every enabled rule applied to every stored transaction. */
export interface RuleRunResponse {
  /** Transactions changed. */
  changed: number;
}

// ---------------------------------------------------------------------------
// Imports and the statement vault
// ---------------------------------------------------------------------------

export type ImportStatus =
  'needs_mapping' | 'preview' | 'committing' | 'committed' | 'discarded' | 'failed' | 'undone';

/**
 * - new: will be added on confirm
 * - already_imported: same provider id or fingerprint is already stored
 * - existing: reconciled with a synced or hand-entered transaction (same amount, date within 3 days)
 * - needs_account: the file names an account that doesn't exist yet
 */
export type ImportRowDecision = 'new' | 'already_imported' | 'existing' | 'needs_account';

export interface ImportPreviewRow extends ParsedImportRow {
  accountId: Id | null;
  fingerprint: string | null;
  occurrence: number;
  categoryId: Id | null;
  decision: ImportRowDecision;
  matchedTransactionId: Id | null;
}

/**
 * A row the file wants to add that looks like a transaction already in the
 * same account (same currency and signed amount, dates within three days).
 * It is only a candidate: the app shows both sides and the user chooses to
 * keep the file's row as a separate transaction or to skip it.
 */
export interface ImportDuplicateCandidate {
  /** The preview row's `line`. */
  line: number;
  /** Stored transactions it resembles. */
  transactionIds: Id[];
}

/** The inclusive dates a preview was limited to, and how many readable rows fell outside them. */
export interface ImportDateRange {
  from: LocalDate | null;
  to: LocalDate | null;
  excluded: number;
}

/**
 * Extra multipart fields of POST /v1/imports, all optional text fields.
 * `accountMappings` is sent as JSON text, `preferDayFirst` as "true" or "false".
 */
export interface ImportPreviewOptions {
  /** One destination for a file that holds a single account. */
  accountId?: Id;
  /** Source account label in the file -> existing account id, for files with several accounts. */
  accountMappings?: Record<string, Id>;
  /** Inclusive bounds on transaction dates. Neither means all rows. */
  fromDate?: LocalDate;
  toDate?: LocalDate;
  /** Three-letter code for formats that carry no currency, when no destination is selected. */
  currency?: CurrencyCode;
  /** How to read ambiguous dates such as 03/04/2026. */
  preferDayFirst?: boolean;
  /** CSV: use these columns. */
  mapping?: CsvMapping;
  /** CSV: lines of bank preamble before the header. */
  skipRows?: number;
}

export interface CsvPreviewInfo {
  headers: string[];
  /** Saved mappings are stored under this key. */
  signature: string;
  suggestedMapping: CsvMapping;
  missing: ('date' | 'amount' | 'description')[];
  dateFormatAmbiguous: boolean;
  dateFormatCandidates: DateFormat[];
  usedSavedMapping: boolean;
}

/**
 * POST /v1/imports (multipart: file, accountId?, format?, mapping? JSON,
 * skipRows?, preferDayFirst?, commit?) returns this. Nothing is saved until
 * POST /v1/imports/:id/commit, unless commit=true was sent (not allowed for PDF).
 */
export interface ImportPreview {
  importId: Id;
  format: ImportFormat;
  status: 'needs_mapping' | 'preview';
  fileName: string;
  accountId: Id | null;
  rows: ImportPreviewRow[];
  accountsToCreate: ParsedAccount[];
  errors: ParseIssue[];
  warnings: string[];
  counts: {
    total: number;
    new: number;
    alreadyImported: number;
    existing: number;
    needsAccount: number;
  };
  csv: CsvPreviewInfo | null;
  mapping: CsvMapping | null;
  /** PDF statements: opening + rows = closing? */
  statementCheck: StatementCheck | null;
  periodStart: LocalDate | null;
  periodEnd: LocalDate | null;
  /** 'monefy' when the dedicated Monefy reader recognised the file. */
  sourceFormat?: 'monefy';
  /** Rows that need an explicit keep or skip before saving. They stay `decision: 'new'`. */
  duplicateCandidates?: ImportDuplicateCandidate[];
  dateRange?: ImportDateRange;
  /** The date order must be confirmed with a new preview (preferDayFirst) before saving. */
  requiresDateConfirmation?: boolean;
}

/** POST /v1/imports/:id/commit */
export interface ImportCommitRequest {
  /** Lines left out: unticked rows, skipped duplicates, and unreadable lines the user acknowledged. */
  skipLines?: number[];
  /** Possible duplicates the user confirmed as separate transactions. A line cannot be in both lists. */
  keepLines?: number[];
  createAccounts?: boolean;
}

export interface ImportCommitResult {
  importId: Id;
  added: number;
  matched: number;
  skipped: number;
  accountsCreated: Id[];
  transactionIds: Id[];
  linked: number;
  suggested: number;
  /** The rows were saved, but something after the save needs attention (for example transfer matching). */
  warnings?: string[];
}

/**
 * Error codes of the import routes (the `error` field of the JSON error body).
 * `import_preview_changed` comes with HTTP 409; the others with 400.
 */
export type ImportErrorCode =
  | 'import_parse_errors'
  | 'import_account_required'
  | 'import_duplicates_require_review'
  | 'import_currency_mismatch'
  | 'import_preview_changed';

/** POST /v1/imports with commit=true */
export interface ImportResponse {
  preview: ImportPreview;
  result: ImportCommitResult | null;
}

/** One stored file in the statement vault (GET /v1/vault). Download: GET /v1/vault/:id/file. */
export interface ImportRecord {
  id: Id;
  format: ImportFormat;
  status: ImportStatus;
  accountId: Id | null;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  r2Key: string;
  rowsTotal: number;
  rowsAdded: number;
  rowsMatched: number;
  rowsSkipped: number;
  error: string | null;
  periodStart: LocalDate | null;
  periodEnd: LocalDate | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  committedAt: IsoDateTime | null;
}

export interface VaultListResponse {
  files: ImportRecord[];
}

/** GET /v1/imports: the newest 200 import records, newest first. */
export interface ImportListResponse {
  imports: ImportRecord[];
}

/** GET /v1/imports/:id: the record with its stored preview. */
export interface ImportDetail extends ImportRecord {
  preview: ImportPreview | null;
}

/** DELETE /v1/imports/:id/transactions (undo): how many transactions were removed. */
export interface ImportUndoResult {
  removed: number;
}

// ---------------------------------------------------------------------------
// Manual accounts (POST /v1/accounts/manual)
// ---------------------------------------------------------------------------

/** Every type the route accepts. Cash has its own route, POST /v1/accounts/cash. */
export const MANUAL_ACCOUNT_TYPES = [
  'checking',
  'savings',
  'credit_card',
  'brokerage',
  'retirement',
  'crypto',
  'loan',
  'mortgage',
  'property',
  'vehicle',
  'other_asset',
  'other_liability',
] as const satisfies readonly Account['type'][];

export type ManualAccountType = (typeof MANUAL_ACCOUNT_TYPES)[number];

/** A balance someone read off a statement in the past. Never a transaction. */
export interface ManualOpeningBalance {
  amount: MinorUnits;
  date: LocalDate;
}

/** The balance now, with the moment it was true. */
export interface ManualCurrentBalance {
  amount: MinorUnits;
  /** ISO UTC timestamp ending in Z. */
  asOf: IsoDateTime;
}

/**
 * POST /v1/accounts/manual: an account with no connection, kept by hand and
 * by statement imports. Unknown keys are refused.
 *
 * Amounts are signed minor units in the account's currency, with the
 * `Account.balance` signs: what is held for an asset, what is owed (as a
 * positive number) for a liability.
 */
export interface ManualAccountRequest {
  /**
   * 1 to 200 letters, digits, underscores or hyphens. Made once per account
   * being created and kept with the request until the outcome is known: a
   * retry sends the same key and the same body, and gets the same account.
   */
  idempotencyKey: string;
  /** 1 to 100 characters after trimming. A name is a label; it never identifies an account. */
  name: string;
  type: ManualAccountType;
  currency: CurrencyCode;
  /** For example 'nre', 'nro', 'demat', '401k'. Null or left out for none. */
  subtype?: string | null;
  openingBalance?: ManualOpeningBalance | null;
  /** Required. Null means the balance is not known, which is different from zero. */
  currentBalance: ManualCurrentBalance | null;
  /** Defaults to true with a current balance, false without. True without one is refused. */
  includeInNetWorth?: boolean;
}

/** Where a hand-made account's balance came from. */
export interface ManualBalanceInfo {
  /**
   * False: nobody has said what the balance is. `Account.balance` and
   * `balanceAsOf` then hold placeholders (0 and the creation time) and must
   * be shown as unknown, never as zero.
   */
  currentKnown: boolean;
  openingBalance: ManualOpeningBalance | null;
}

/** An account as GET /v1/accounts and GET /v1/dataset return it. */
export interface AccountWithManualBalance extends Account {
  /** Only on accounts made through POST /v1/accounts/manual. */
  manualBalance?: ManualBalanceInfo;
}

/**
 * 201 for a new account, 200 with `replayed: true` when the same key and
 * body were sent before. 409 `idempotency_conflict` when the key was used
 * with other details; 409 `account_missing` when the key's account is gone.
 */
export interface ManualAccountResponse {
  account: AccountWithManualBalance;
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** POST /v1/receipts (multipart: file, transactionId?) */
export interface ReceiptResponse {
  receipt: Receipt;
  /** Best transaction match, when one was found. */
  match: ReceiptMatch | null;
  /** Other close candidates the user can pick. */
  candidates: ReceiptMatch[];
}

export interface ReceiptMatch {
  transactionId: Id;
  score: number;
  /** Plain-language reason ("same amount, 1 day apart, merchant matches"). */
  reason: string;
}

/** POST /v1/receipts/:id/attach */
export interface ReceiptAttachRequest {
  transactionId: Id;
}

/** POST /v1/receipts/:id/split: split the matched transaction by line items. */
export interface ReceiptSplitRequest {
  idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// FX, AI, settings
// ---------------------------------------------------------------------------

/** GET /v1/fx/latest?base=USD&quote=INR */
export interface FxLatestResponse {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: number | null;
  /** When the provider published it. Show next to converted totals. */
  asOf: IsoDateTime | null;
  source: FxRate['source'] | null;
}

/**
 * POST /v1/fx/refresh: fetches the latest rates now. Each number is how many
 * rates that source stored (written again if already there). 0 when the
 * source has no key, could not be reached or answered with an error; the
 * Worker does not say which.
 */
export interface FxRefreshResponse {
  openExchangeRates: number;
  frankfurter: number;
}

/** GET /v1/fx/rates?from&to */
export interface FxRatesResponse {
  rates: FxRate[];
}

/** GET /v1/settings, PATCH /v1/settings */
export type SettingsResponse = Settings;

export type SettingsPatchRequest = Partial<Omit<Settings, 'moneyPolicies'>> & {
  moneyPolicies?: Partial<MoneyPolicies>;
};

/** GET /v1/ai/status */
export interface AiStatusResponse {
  enabled: boolean;
  provider: AiProvider;
  /** Which providers have their key or binding set up on the Worker. */
  configured: Record<AiProvider, boolean>;
  workersAiCallsToday: number;
  workersAiDailyLimit: number;
}

/** POST /v1/ai/jobs/:job (categorize, merchants, recurring, alerts, recap) */
export interface AiJobResponse {
  job: string;
  /** Rows changed or items created. */
  changed: number;
  /** True when the job used the AI provider (false: rules and heuristics only). */
  usedAi: boolean;
  note: string | null;
}

/** POST /v1/ai/ask */
export interface AskRequest {
  question: string;
}

export interface AskResponse {
  answer: string;
}

export type AlertType = 'duplicate' | 'unusual' | 'price_increase';

export interface Alert {
  id: Id;
  type: AlertType;
  transactionId: Id | null;
  recurringId: Id | null;
  message: string;
  amount: MinorUnits | null;
  currency: CurrencyCode | null;
  createdAt: IsoDateTime;
  dismissedAt: IsoDateTime | null;
}

/** GET /v1/alerts */
export interface AlertsResponse {
  alerts: Alert[];
}

/** GET /v1/recaps?kind=weekly|monthly (newest first). Session C's recap screens read these. */
export interface RecapsResponse {
  recaps: Recap[];
}

/** GET /v1/recurring */
export interface RecurringResponse {
  recurring: RecurringItem[];
}

/** POST /v1/transfer-links/run */
export interface MatchRunResponse {
  linked: number;
  suggested: number;
}

export * from './link';
