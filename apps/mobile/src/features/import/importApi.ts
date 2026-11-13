import type {
  ImportCommitRequest,
  ImportCommitResult,
  ImportDetail,
  ImportListResponse,
  ImportPreview,
  ImportPreviewOptions,
  ImportRecord,
  ImportResponse,
  ImportUndoResult,
  ManualAccountRequest,
  ManualAccountResponse,
} from '@manaclaude/shared';
import { api, BackendError } from '../../data/backend/client';
import { getBackendConfig } from '../../data/backend/config';
import { fileForm } from '../../data/backend/upload';

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
}

const TYPES: Record<string, string> = {
  csv: 'text/csv',
  ofx: 'application/x-ofx',
  qfx: 'application/x-ofx',
  qif: 'application/qif',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

export function mimeFor(name: string, given?: string | null): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TYPES[ext] ?? given ?? 'application/octet-stream';
}

/**
 * POST /v1/imports: the backend keeps the original in the statement vault and
 * returns a preview. Nothing is saved to your transactions yet. Every call
 * makes a new preview with its own id; the caller discards the one it replaces.
 */
export async function previewImport(
  file: PickedFile,
  opts: ImportPreviewOptions = {},
): Promise<ImportPreview> {
  const form = await fileForm(file.uri, file.name, file.mimeType, {
    accountId: opts.accountId,
    accountMappings:
      opts.accountMappings && Object.keys(opts.accountMappings).length > 0
        ? JSON.stringify(opts.accountMappings)
        : undefined,
    fromDate: opts.fromDate,
    toDate: opts.toDate,
    currency: opts.currency,
    preferDayFirst: opts.preferDayFirst === undefined ? undefined : String(opts.preferDayFirst),
    mapping: opts.mapping ? JSON.stringify(opts.mapping) : undefined,
    skipRows: opts.skipRows ? String(opts.skipRows) : undefined,
  });
  const res = await api<ImportResponse>('POST', '/v1/imports', form, { timeoutMs: 120_000 });
  return res.preview;
}

/** POST /v1/imports/:id/commit: saves the rows, leaving out `skipLines` and keeping `keepLines` as separate transactions. */
export function commitImport(
  importId: string,
  lines: Pick<ImportCommitRequest, 'skipLines' | 'keepLines'> = {},
): Promise<ImportCommitResult> {
  const body: ImportCommitRequest = { createAccounts: true };
  if (lines.skipLines?.length) body.skipLines = lines.skipLines;
  if (lines.keepLines?.length) body.keepLines = lines.keepLines;
  return api<ImportCommitResult>('POST', `/v1/imports/${importId}/commit`, body, {
    timeoutMs: 120_000,
  });
}

export function discardImport(importId: string): Promise<unknown> {
  return api('POST', `/v1/imports/${importId}/discard`, {});
}

/** GET /v1/imports/:id: where an import stands (preview, committing, committed, undone...). */
export function getImport(importId: string): Promise<ImportDetail> {
  return api<ImportDetail>('GET', `/v1/imports/${importId}`);
}

/** GET /v1/imports: the newest import records. */
export async function listImports(): Promise<ImportRecord[]> {
  return (await api<ImportListResponse>('GET', '/v1/imports')).imports;
}

/** DELETE /v1/imports/:id/transactions: removes what a saved import added. The file stays in the vault. */
export async function undoImport(importId: string): Promise<number> {
  return (await api<ImportUndoResult>('DELETE', `/v1/imports/${importId}/transactions`)).removed;
}

/** The backend's error code ("import_preview_changed", "conflict"...), or '' for anything else. */
export function errorCode(e: unknown): string {
  return e instanceof BackendError ? e.code : '';
}

export function errorStatus(e: unknown): number {
  return e instanceof BackendError ? e.status : -1;
}

// -- manual accounts ---------------------------------------------------------------------
// POST /v1/accounts/manual (shared ManualAccountRequest). A Worker from before
// that route does not have it, so the app asks first and offers "New account"
// only when it is there.

const supported = new Map<string, boolean>();

/**
 * Does this Worker have the manual-account route? Asked once per backend with
 * an empty body, which can never create anything: a Worker without the route
 * answers 404 not_found, one with it answers 400 because the body is not valid.
 */
export async function manualAccountsSupported(): Promise<boolean> {
  const { scope } = getBackendConfig();
  const known = supported.get(scope);
  if (known !== undefined) return known;
  try {
    const res = await api<{ error?: string } | null>(
      'POST',
      '/v1/accounts/manual',
      {},
      { acceptStatus: [400, 404, 405, 409, 422], timeoutMs: 15_000 },
    );
    const yes = res?.error !== undefined && res.error !== 'not_found';
    supported.set(scope, yes);
    return yes;
  } catch {
    // Unknown (offline, server error): do not offer it now, ask again next time.
    return false;
  }
}

/**
 * Makes the account, or returns the one an earlier send of the same request
 * made (`replayed: true`). Always send a request again unchanged, with its
 * original key: that is what makes a retry safe.
 */
export function createManualAccount(request: ManualAccountRequest): Promise<ManualAccountResponse> {
  return api<ManualAccountResponse>('POST', '/v1/accounts/manual', request);
}

/** Tests: forget what was learned about the Worker. */
export function resetManualAccountSupportForTests(): void {
  supported.clear();
}
