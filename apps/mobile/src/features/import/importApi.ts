import type {
  CsvMapping,
  ImportCommitResult,
  ImportPreview,
  ImportResponse,
} from '@manaclaude/shared';
import { api } from '../../data/backend/client';
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

/** POST /v1/imports: the backend keeps the original in the statement vault and returns a preview. Nothing is saved yet. */
export async function previewImport(
  file: PickedFile,
  opts: { accountId?: string; mapping?: CsvMapping },
): Promise<ImportPreview> {
  const form = await fileForm(file.uri, file.name, file.mimeType, {
    accountId: opts.accountId,
    mapping: opts.mapping ? JSON.stringify(opts.mapping) : undefined,
  });
  const res = await api<ImportResponse>('POST', '/v1/imports', form, { timeoutMs: 120_000 });
  return res.preview;
}

export function commitImport(importId: string, createAccounts = true): Promise<ImportCommitResult> {
  return api<ImportCommitResult>(
    'POST',
    `/v1/imports/${importId}/commit`,
    { createAccounts },
    { timeoutMs: 120_000 },
  );
}

export function discardImport(importId: string): Promise<unknown> {
  return api('POST', `/v1/imports/${importId}/discard`, {});
}
