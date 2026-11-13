import type { ImportRecord, VaultListResponse } from '@manaclaude/shared';
import { api, BackendError, http, supersededError } from '../../data/backend/client';
import { getBackendConfig, isBackendReady } from '../../data/backend/config';

/** The Worker lists at most this many records, newest first. */
export const VAULT_LISTED = 200;

/** GET /v1/vault: one record per stored copy of a file, newest first (at most 200). */
export async function listVault(): Promise<ImportRecord[]> {
  return (await api<VaultListResponse>('GET', '/v1/vault')).files;
}

/** Where GET /v1/vault/:id/file is, and the header it needs, for the backend selected now. */
export function vaultFileRequest(id: string): { url: string; headers: Record<string, string> } {
  const cfg = getBackendConfig();
  if (!isBackendReady(cfg))
    throw new BackendError(0, 'not_set', 'Set the backend URL and API token in Settings, Backend.');
  return {
    url: `${cfg.url.replace(/\/+$/, '')}/v1/vault/${encodeURIComponent(id)}/file`,
    headers: { authorization: `Bearer ${cfg.token}` },
  };
}

/** The sentence for a file request the Worker refused. */
export function fileErrorText(status: number, message: string): string {
  if (status === 401) return 'The API token is wrong. Check it in Settings, Backend.';
  if (status === 404) return message || 'The original file is missing from the vault.';
  return message || `The backend answered with an error (HTTP ${status}).`;
}

const TIMEOUT_MS = 120_000;

/**
 * GET /v1/vault/:id/file: the stored original, exactly as it was uploaded.
 * The Worker sends the bytes, not JSON, so this does not go through `api()`;
 * like `api()` it drops an answer that arrives after the backend changed.
 */
async function fetchFile<T>(id: string, read: (res: Response) => Promise<T>): Promise<T> {
  const scope = getBackendConfig().scope;
  const stale = () => getBackendConfig().scope !== scope;
  const { url, headers } = vaultFileRequest(id);
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  let res: Response;
  let body: T | null = null;
  let refusal = '';
  try {
    res = await http.fetch(url, { method: 'GET', headers, signal: controller?.signal });
    if (res.ok) body = await read(res);
    else refusal = await res.text().catch(() => '');
  } catch {
    if (stale()) throw supersededError();
    throw new BackendError(
      0,
      'offline',
      "The backend can't be reached. Check your connection and the URL in Settings, Backend.",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (stale()) throw supersededError();
  if (!res.ok) {
    let err: { error?: string; message?: string } = {};
    try {
      err = JSON.parse(refusal) as typeof err;
    } catch {
      err = {};
    }
    throw new BackendError(
      res.status,
      err.error ?? 'error',
      fileErrorText(res.status, err.message ?? ''),
    );
  }
  return body as T;
}

/** The stored file as text (CSV, OFX and QIF are text). */
export function vaultFileText(id: string): Promise<string> {
  return fetchFile(id, (res) => res.text());
}

/** The stored file as a blob, for the browser to save. */
export function vaultFileBlob(id: string): Promise<Blob> {
  return fetchFile(id, (res) => res.blob());
}
