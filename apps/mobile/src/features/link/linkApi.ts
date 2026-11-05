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
): Promise<ConnectionSyncResponse> {
  let inserted = 0;
  let last: ConnectionSyncResponse | null = null;
  const max = opts.maxCalls ?? 25;
  for (let calls = 1; calls <= max; calls += 1) {
    last = await api<ConnectionSyncResponse>(
      'POST',
      `/v1/connections/${connectionId}/sync${opts.force ? '?force=true' : ''}`,
      undefined,
      { timeoutMs: 120_000, acceptStatus: [502] },
    );
    inserted += last.summary?.inserted ?? 0;
    onProgress({ inserted, remaining: last.summary?.remaining ?? 0, calls });
    if (!last.more) return last;
  }
  return last!;
}
