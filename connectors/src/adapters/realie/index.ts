import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * Realie (US parcel data), https://docs.realie.ai. Check the free plan's
 * monthly cap at sign-up (Sure assumes 25 calls a month).
 * Follows Sure: app/models/provider/realie.rb (GET /api/public/property/address/
 * with address and state, API key in the Authorization header, city or ZIP
 * must match, modelValue then totalMarketValue).
 *
 * - Secrets: REALIE_API_KEY (app); per property REALIE_ADDRESS (street line),
 *   REALIE_STATE (two letters), optional REALIE_CITY and REALIE_ZIP to guard
 *   against a wrong match.
 * - One property account in USD at the model value, falling back to the
 *   assessor's total market value.
 * - Repair: 401/403.
 */

export const REALIE_API = 'https://app.realie.ai';

interface RealieRecord {
  modelValue?: number | string | null;
  totalMarketValue?: number | string | null;
  realieValuation?: { ml?: { value?: number | string | null } } | null;
  valuationInformation?: { totalMarketValue?: number | string | null } | null;
  city?: string | null;
  propertyLocation?: { city?: string | null } | null;
  zipCode?: string | null;
  formattedAddress?: string | null;
  addressFull?: string | null;
}

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function syncRealie(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = new HttpClient(ctx, {
    provider: 'Realie',
    baseUrl: REALIE_API,
    headers: { Authorization: connectionSecret(ctx, 'REALIE_API_KEY', 'Realie') },
  });
  const address = connectionSecret(ctx, 'REALIE_ADDRESS', 'Realie');
  const state = connectionSecret(ctx, 'REALIE_STATE', 'Realie').toUpperCase();
  const city = ctx.secrets.REALIE_CITY?.trim();
  const zip = ctx.secrets.REALIE_ZIP?.trim().slice(0, 5);
  const today = todayUtc(ctx.now());

  const resp = await http.get<{ property?: RealieRecord | RealieRecord[] | null }>(
    '/api/public/property/address/',
    { address, state },
  );
  const list = ([] as (RealieRecord | null | undefined)[])
    .concat(resp?.property ?? [])
    .filter((r): r is RealieRecord => !!r);
  if (list.length === 0) throw new ProviderDataError('Realie', 'no property');
  const record = list.find((r) => {
    const returnedCity = (r.city ?? r.propertyLocation?.city ?? '').trim();
    const returnedZip = (r.zipCode ?? '').trim().slice(0, 5);
    const cityBad = returnedCity && city && returnedCity.toLowerCase() !== city.toLowerCase();
    const zipBad = returnedZip && zip && returnedZip !== zip;
    return !(cityBad || zipBad);
  });
  if (!record) throw new ProviderDataError('Realie', 'location mismatch');
  const value =
    positive(record.modelValue ?? record.realieValuation?.ml?.value) ??
    positive(record.totalMarketValue ?? record.valuationInformation?.totalMarketValue);
  if (value === null) throw new ProviderDataError('Realie', 'no valuation');

  const result = emptyResult();
  result.accounts.push(
    providerAccount({
      externalId: `realie_${address}_${state}`,
      name: record.formattedAddress ?? record.addressFull ?? address,
      institutionName: 'Realie estimate',
      type: 'property',
      currency: 'USD',
      balance: toMinor(value, 'USD'),
    }),
  );
  result.nextCursor = sinceCursor(today);
  return result;
}

export const realieAdapter = defineAdapter({ id: 'realie', sync: syncRealie });
