import type { FxLatestResponse, FxRefreshResponse, FxRateSource } from '@manaclaude/shared';
import { api } from '../../data/backend/client';
import { createScopedStore } from '../../data/backend/scopedStore';

/** GET /v1/fx/latest: the newest stored rate for one pair. */
export function getLatestRate(base: string, quote: string): Promise<FxLatestResponse> {
  return api<FxLatestResponse>(
    'GET',
    `/v1/fx/latest?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}`,
  );
}

/** POST /v1/fx/refresh: asks both rate sources now. Each can take a while. */
export function refreshRates(): Promise<FxRefreshResponse> {
  return api<FxRefreshResponse>('POST', '/v1/fx/refresh', {}, { timeoutMs: 60_000 });
}

/** The USD to INR rate the Worker has now, in memory only, dropped when the backend changes. */
export const usdInrStore = createScopedStore(() => getLatestRate('USD', 'INR'));

export const SOURCE_LABEL: Record<FxRateSource, string> = {
  openexchangerates: 'Open Exchange Rates',
  frankfurter_ecb: 'European Central Bank (through Frankfurter)',
  transfer_implied: "one of your own transfers' rate",
  manual: 'entered by hand',
  sample: 'sample data',
};

/** "2026-11-13 14:00 UTC" */
export function utcText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const plural = (n: number) => `${n} ${n === 1 ? 'rate' : 'rates'}`;

/** What a refresh did, in plain words. The Worker does not say why a source gave nothing. */
export function refreshText(r: FxRefreshResponse): string {
  const why =
    'either its key is not set on the Worker or it could not be reached; the Worker does not say which';
  if (r.openExchangeRates > 0 && r.frankfurter > 0)
    return `Open Exchange Rates gave ${plural(r.openExchangeRates)} and the European Central Bank ${plural(r.frankfurter)}.`;
  if (r.openExchangeRates > 0)
    return `Open Exchange Rates gave ${plural(r.openExchangeRates)}. The European Central Bank gave none: it could not be reached.`;
  if (r.frankfurter > 0)
    return `The European Central Bank gave ${plural(r.frankfurter)}. Open Exchange Rates gave none: ${why}.`;
  return 'No rates came back from either source, so the rates you have are unchanged. Open Exchange Rates needs its key on the Worker; both need the internet. The Worker does not say which one failed.';
}
