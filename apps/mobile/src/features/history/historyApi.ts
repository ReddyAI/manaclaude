import type {
  BankHistoryDecisionRequest,
  BankHistoryDecisionResponse,
  BankHistoryReviewResponse,
  BankHistoryReviewsResponse,
  HistoryPolicy,
  HistoryPolicySaveRequest,
  HistoryPolicySaveResponse,
  HistoryRead,
  PolicyPreview,
} from '@manaclaude/shared';
import { api, BackendError } from '../../data/backend/client';
import { createScopedStore } from '../../data/backend/scopedStore';

/**
 * History sources (Codex's PRs #35 and #36): which of Monefy and the bank
 * owns each connected bank account before and after a cutoff date, and the
 * bank rows held for review because they look like a saved Monefy entry.
 */

/** GET /v1/history-policy */
export function getHistoryPolicy(): Promise<HistoryRead> {
  return api<HistoryRead>('GET', '/v1/history-policy');
}

/** POST /v1/history-policy/preview: no writes, 200 even when not allowed. */
export function previewHistoryPolicy(policy: HistoryPolicy): Promise<PolicyPreview> {
  return api<PolicyPreview>('POST', '/v1/history-policy/preview', { policy });
}

/** PUT /v1/history-policy with the exact preview's version and token. */
export function saveHistoryPolicy(
  request: HistoryPolicySaveRequest,
): Promise<HistoryPolicySaveResponse> {
  return api<HistoryPolicySaveResponse>('PUT', '/v1/history-policy', request);
}

/** GET /v1/history-policy/bank-reviews: pending only. */
export function listBankReviews(): Promise<BankHistoryReviewsResponse> {
  return api<BankHistoryReviewsResponse>('GET', '/v1/history-policy/bank-reviews');
}

/** GET /v1/history-policy/bank-reviews/:id, resolved and obsolete ones included. */
export function getBankReview(id: string): Promise<BankHistoryReviewResponse> {
  return api<BankHistoryReviewResponse>(
    'GET',
    `/v1/history-policy/bank-reviews/${encodeURIComponent(id)}`,
  );
}

/** POST /v1/history-policy/bank-reviews/:id */
export function decideBankReview(
  id: string,
  request: BankHistoryDecisionRequest,
): Promise<BankHistoryDecisionResponse> {
  return api<BankHistoryDecisionResponse>(
    'POST',
    `/v1/history-policy/bank-reviews/${encodeURIComponent(id)}`,
    request,
  );
}

/** The policy and per-account periods, in memory, dropped when the backend changes. */
export const historyStore = createScopedStore(getHistoryPolicy);

/** Pending bank reviews, in memory, dropped when the backend changes. */
export const bankReviewsStore = createScopedStore(async () => (await listBankReviews()).reviews);

export function errorCodeOf(e: unknown): string {
  return e instanceof BackendError ? e.code : '';
}

export function errorStatusOf(e: unknown): number {
  return e instanceof BackendError ? e.status : -1;
}

/** No answer, a timeout or a server error: the request may or may not have been applied. */
export function isUncertain(e: unknown): boolean {
  const status = errorStatusOf(e);
  return status === 0 || status >= 500 || status === -1;
}
