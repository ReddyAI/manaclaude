import type { Connection, ConnectorContext, SyncResult } from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc } from '../../util/dates';
import { toMinor } from '../../util/decimal';
import { connectionSecret, defineAdapter, emptyResult, providerAccount } from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * RentCast property value (https://developers.rentcast.io), free plan with 50
 * calls a month. Follows Sure: app/models/provider/rentcast.rb (GET /v1/avm/value
 * with an address, X-Api-Key, the price field, subjectProperty details).
 *
 * - Secrets: RENTCAST_API_KEY (app), RENTCAST_ADDRESS (per property, one line:
 *   "5500 Grand Lake Dr, San Antonio, TX 78244").
 * - One property account in USD whose balance is the estimate. Each sync costs
 *   one call of the 50 a month, so the backend should refresh a property at
 *   most monthly (see shouldRefreshValuation).
 * - Repair: 401/403 (key revoked). A 429 or a plan-limit answer is try-later.
 */

export const RENTCAST_API = 'https://api.rentcast.io';

/** A property value moves slowly; spend the monthly calls sparingly. */
export function shouldRefreshValuation(
  lastSuccessfulSyncAt: string | null,
  now: Date,
  minDays = 30,
): boolean {
  return (
    !lastSuccessfulSyncAt ||
    now.getTime() - Date.parse(lastSuccessfulSyncAt) >= minDays * 86_400_000
  );
}

interface Avm {
  price?: number;
  priceRangeLow?: number;
  priceRangeHigh?: number;
  subjectProperty?: {
    formattedAddress?: string;
    propertyType?: string;
    yearBuilt?: number;
    squareFootage?: number;
  };
}

export async function syncRentCast(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const http = new HttpClient(ctx, {
    provider: 'RentCast',
    baseUrl: RENTCAST_API,
    headers: { 'X-Api-Key': connectionSecret(ctx, 'RENTCAST_API_KEY', 'RentCast') },
  });
  const address = connectionSecret(ctx, 'RENTCAST_ADDRESS', 'RentCast');
  const today = todayUtc(ctx.now());
  const avm = await http.get<Avm>('/v1/avm/value', { address, lookupSubjectAttributes: 'true' });
  if (!avm?.price) throw new ProviderDataError('RentCast', 'no valuation');
  const result = emptyResult();
  result.accounts.push(
    providerAccount({
      externalId: `rentcast_${address}`,
      name: avm.subjectProperty?.formattedAddress ?? address,
      institutionName: 'RentCast estimate',
      type: 'property',
      currency: 'USD',
      balance: toMinor(avm.price, 'USD'),
    }),
  );
  result.nextCursor = sinceCursor(today);
  return result;
}

export const rentcastAdapter = defineAdapter({ id: 'rentcast', sync: syncRentCast });
