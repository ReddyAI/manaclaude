import type {
  BrowserLinkResponse,
  ConnectionSyncResponse,
  KeyLinkRequest,
  LinkDoneResponse,
  LinkOptionsResponse,
  PlaidLinkTokenResponse,
  SophtronAnswerRequest,
  SophtronInstitutionsResponse,
  SophtronLinkStatus,
  SophtronStartRequest,
  SyncHistoryPolicySummary,
} from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** The app's side of /v1/link (session E2). Credentials are sent once and never come back. */
export const linkApi = {
  options: () => api<LinkOptionsResponse>('GET', '/v1/link/options'),
  sophtronSearch: (query: string) =>
    api<SophtronInstitutionsResponse>('POST', '/v1/link/sophtron/institutions', { query }),
  sophtronStart: (body: SophtronStartRequest) =>
    api<SophtronLinkStatus>('POST', '/v1/link/sophtron/start', body, { timeoutMs: 60_000 }),
  sophtronStatus: (linkId: string) =>
    api<SophtronLinkStatus>('GET', `/v1/link/sophtron/${linkId}`, undefined, { timeoutMs: 60_000 }),
  sophtronAnswer: (linkId: string, answer: SophtronAnswerRequest) =>
    api<SophtronLinkStatus>('POST', `/v1/link/sophtron/${linkId}/answer`, answer),
  simplefin: (setupToken: string, connectionId?: string) =>
    api<LinkDoneResponse>('POST', '/v1/link/simplefin', { setupToken, connectionId }),
  snaptradeStart: (connectionId?: string, returnUrl?: string) =>
    api<BrowserLinkResponse>('POST', '/v1/link/snaptrade/start', { connectionId, returnUrl }),
  snaptradeComplete: (linkId: string) =>
    api<LinkDoneResponse>('POST', `/v1/link/snaptrade/${linkId}/complete`),
  kiteStart: (connectionId?: string, returnUrl?: string) =>
    api<BrowserLinkResponse>('POST', '/v1/link/zerodha_kite/start', { connectionId, returnUrl }),
  plaidToken: (platform: 'android' | 'ios' | 'web', connectionId?: string) =>
    api<PlaidLinkTokenResponse>('POST', '/v1/link/plaid/link-token', { platform, connectionId }),
  plaidExchange: (body: {
    publicToken?: string;
    institutionName?: string;
    connectionId?: string;
  }) => api<LinkDoneResponse>('POST', '/v1/link/plaid/exchange', body),
  keys: (body: KeyLinkRequest) => api<LinkDoneResponse>('POST', '/v1/link/keys', body),
};

export interface SyncProgress {
  inserted: number;
  remaining: number;
  calls: number;
}

/**
 * Syncs one connection until it is done. A first sync with years of history
 * comes back in parts (`more: true`); each call is its own Worker invocation,
 * so each stays inside the Free plan's limits. Returns the last report.
 */
export async function syncUntilDone(
  connectionId: string,
  onProgress: (p: SyncProgress) => void = () => {},
  opts: { force?: boolean; maxCalls?: number } = {},
): Promise<SyncReport> {
  let inserted = 0;
  let excluded = 0;
  let pendingReview: number | null = null;
  let last: SyncAnswer | null = null;
  const max = opts.maxCalls ?? 25;
  const report = (): SyncReport => ({
    ...last!,
    history:
      pendingReview === null && excluded === 0
        ? null
        : { excluded, pendingReview: pendingReview ?? 0 },
  });
  for (let calls = 1; calls <= max; calls += 1) {
    last = await api<SyncAnswer>(
      'POST',
      `/v1/connections/${connectionId}/sync${opts.force ? '?force=true' : ''}`,
      undefined,
      { timeoutMs: 120_000, acceptStatus: [502] },
    );
    inserted += last.summary?.inserted ?? 0;
    const history = last.summary?.historyPolicy;
    if (history) {
      excluded += history.excluded;
      pendingReview = history.pendingReview;
    }
    onProgress({ inserted, remaining: last.summary?.remaining ?? 0, calls });
    if (!last.more) return report();
  }
  return report();
}

/** The sync answer with the history-source counts a Worker with Codex's #35 adds. */
type SyncAnswer = ConnectionSyncResponse & {
  summary:
    | (NonNullable<ConnectionSyncResponse['summary']> & {
        historyPolicy?: SyncHistoryPolicySummary;
      })
    | null;
};

/** The last answer, plus the history-source counts over every part of the sync. */
export type SyncReport = ConnectionSyncResponse & {
  history: null | {
    /** Bank rows left out because Monefy owns their dates, over all parts. */
    excluded: number;
    /** Bank rows waiting for review after the last part. */
    pendingReview: number;
  };
};

/** One line about what History sources did in a sync, or null when nothing. */
export function syncHistoryText(report: SyncReport): string | null {
  const h = report.history;
  if (!h) return null;
  const parts: string[] = [];
  if (h.excluded > 0)
    parts.push(
      `${h.excluded} bank ${h.excluded === 1 ? 'transaction was' : 'transactions were'} left out because Monefy owns ${h.excluded === 1 ? 'its date' : 'those dates'} (History sources).`,
    );
  if (h.pendingReview > 0)
    parts.push(
      `${h.pendingReview} bank ${h.pendingReview === 1 ? 'transaction looks' : 'transactions look'} like a Monefy entry you have and ${h.pendingReview === 1 ? 'waits' : 'wait'} for your review; ${h.pendingReview === 1 ? 'it is' : 'they are'} not saved until you decide.`,
    );
  return parts.length ? parts.join(' ') : null;
}
