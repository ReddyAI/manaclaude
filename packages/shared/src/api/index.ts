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

/** POST /v1/rules, PUT /v1/rules/:id */
export type RuleInput = Omit<Rule, 'id' | 'createdAt' | 'updatedAt' | 'source'>;

export interface RuleResponse {
  rule: Rule;
  /** Transactions changed when the rule was applied to existing rows. */
  applied: number;
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
}

/** POST /v1/imports/:id/commit */
export interface ImportCommitRequest {
  /** Lines unticked in the preview. */
  skipLines?: number[];
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
}

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
