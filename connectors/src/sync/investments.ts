import type {
  CurrencyCode,
  Holding,
  Id,
  InvestmentActivity,
  IsoDateTime,
  LocalDate,
  ProviderActivity,
  ProviderHolding,
  ProviderTaxLot,
  Security,
  SyncResult,
  TaxLot,
} from '@manaclaude/shared';
import {
  addDec,
  cmpDec,
  deriveLotsFifo,
  isZeroDec,
  proRateMinor,
  subDec,
  valueInMinor,
} from '@manaclaude/shared';
import { defaultIdFactory, type IdFactory, type Update } from './types';

/**
 * Holdings, lots and activities part of a sync.
 *
 * Lots come from the broker when the provider sends them (Plaid tax_lots).
 * Otherwise they are derived from buy and sell activities with deriveLotsFifo
 * (SnapTrade, IBKR Flex, Trading 212, Questrade, Coinbase, and so on). When the
 * activity history is shorter than the position (a broker that only returns a
 * year of activity, or Zerodha's holdings with no purchase dates), an
 * "opening balance" lot covers the rest at the broker's own cost basis.
 *
 * Follows Sure's holdings and trades processors (snaptrade_account/
 * holdings_processor.rb, activities_processor.rb, plaid_account/investments/*).
 */

export const OPENING_LOT_ID = 'opening_balance';

export interface InvestmentSyncInput {
  connectionId: Id;
  /** Provider account id to our Account id. */
  accounts: ReadonlyMap<string, Id>;
  securities: readonly Security[];
  holdings: readonly Holding[];
  taxLots: readonly TaxLot[];
  activities: readonly InvestmentActivity[];
  result: Pick<SyncResult, 'holdings' | 'activities'>;
  /**
   * Provider account ids whose holdings list is complete in this result, so a
   * holding that is missing from it was sold. Default: every account that has
   * a holding or activity in the result plus `completeAccounts` below.
   */
  completeAccounts?: ReadonlySet<string>;
  now: IsoDateTime;
  newId?: IdFactory;
}

export interface InvestmentSyncOutput {
  securityInserts: Security[];
  holdingInserts: Holding[];
  holdingUpdates: Update<Holding>[];
  /** Holdings the broker no longer reports (sold out). */
  holdingRemovals: Id[];
  lotInserts: TaxLot[];
  lotUpdates: Update<TaxLot>[];
  lotRemovals: Id[];
  activityInserts: InvestmentActivity[];
  activityUpdates: Update<InvestmentActivity>[];
  warnings: string[];
}

function securityKey(symbol: string, exchange: string | null): string {
  return `${symbol.toUpperCase()}|${exchange ?? ''}`;
}

function assetClassOf(
  h: Pick<ProviderHolding, 'securityType' | 'exchange' | 'currency'>,
): Security['assetClass'] {
  if (h.securityType === 'crypto') return 'crypto';
  if (h.securityType === 'bond') return 'bonds';
  if (h.securityType === 'cash') return 'cash';
  if (h.exchange === 'NSE' || h.exchange === 'BSE') return 'india_stocks';
  if (h.currency === 'USD') return 'us_stocks';
  return 'intl_stocks';
}

function lotMatches(existing: TaxLot, wanted: ProviderTaxLot): boolean {
  if (wanted.externalId && existing.externalId) return existing.externalId === wanted.externalId;
  return (
    existing.acquiredOn === wanted.acquiredOn && cmpDec(existing.quantity, wanted.quantity) === 0
  );
}

export function planInvestmentSync(input: InvestmentSyncInput): InvestmentSyncOutput {
  const newId = input.newId ?? defaultIdFactory;
  const out: InvestmentSyncOutput = {
    securityInserts: [],
    holdingInserts: [],
    holdingUpdates: [],
    holdingRemovals: [],
    lotInserts: [],
    lotUpdates: [],
    lotRemovals: [],
    activityInserts: [],
    activityUpdates: [],
    warnings: [],
  };
  const today: LocalDate = input.now.slice(0, 10);

  // -- securities ----------------------------------------------------------
  const securities = [...input.securities];
  const bySymbolExchange = new Map(securities.map((s) => [securityKey(s.symbol, s.exchange), s]));
  const bySymbol = new Map<string, Security[]>();
  for (const s of securities) {
    const list = bySymbol.get(s.symbol.toUpperCase()) ?? [];
    list.push(s);
    bySymbol.set(s.symbol.toUpperCase(), list);
  }
  function addSecurity(s: Security): void {
    securities.push(s);
    out.securityInserts.push(s);
    bySymbolExchange.set(securityKey(s.symbol, s.exchange), s);
    const list = bySymbol.get(s.symbol.toUpperCase()) ?? [];
    list.push(s);
    bySymbol.set(s.symbol.toUpperCase(), list);
  }
  function findSecurity(symbol: string, exchange: string | null): Security | undefined {
    const exact = bySymbolExchange.get(securityKey(symbol, exchange));
    if (exact) return exact;
    const sameSymbol = bySymbol.get(symbol.toUpperCase()) ?? [];
    return sameSymbol.length === 1 && (exchange === null || sameSymbol[0]?.exchange === null)
      ? sameSymbol[0]
      : undefined;
  }
  function ensureSecurity(h: ProviderHolding): Security {
    const found = findSecurity(h.symbol, h.exchange);
    if (found) return found;
    const created: Security = {
      id: newId('sec'),
      symbol: h.symbol,
      name: h.name,
      type: h.securityType,
      exchange: h.exchange,
      currency: h.currency,
      isin: null,
      assetClass: assetClassOf(h),
      isBenchmark: false,
    };
    addSecurity(created);
    return created;
  }
  function ensureSecurityForActivity(a: ProviderActivity): Security | null {
    if (!a.symbol) return null;
    const found = findSecurity(a.symbol, null);
    if (found) return found;
    const created: Security = {
      id: newId('sec'),
      symbol: a.symbol,
      name: a.symbol,
      type: 'equity',
      exchange: null,
      currency: a.currency,
      isin: null,
      assetClass: a.currency === 'USD' ? 'us_stocks' : 'intl_stocks',
      isBenchmark: false,
    };
    addSecurity(created);
    return created;
  }

  // -- activities ----------------------------------------------------------
  // Work on copies so the caller's rows stay untouched.
  const allActivities: InvestmentActivity[] = input.activities.map((a) => ({ ...a }));
  const knownActivity = new Map<string, InvestmentActivity>();
  for (const a of allActivities) {
    if (a.externalId) knownActivity.set(`${a.accountId}\u0000${a.externalId}`, a);
  }
  const incomingActivityIds = new Set<string>();
  for (const pa of input.result.activities) {
    const accountId = input.accounts.get(pa.accountExternalId);
    if (!accountId) continue;
    const k = `${accountId}\u0000${pa.externalId}`;
    if (incomingActivityIds.has(k)) continue;
    incomingActivityIds.add(k);
    const security = ensureSecurityForActivity(pa);
    const found = knownActivity.get(k);
    if (found) {
      const changes: Partial<InvestmentActivity> = {};
      if (found.amount !== pa.amount) changes.amount = pa.amount;
      if (found.fees !== pa.fees) changes.fees = pa.fees;
      if (found.quantity !== pa.quantity) changes.quantity = pa.quantity;
      if (found.price !== pa.price) changes.price = pa.price;
      if (found.date !== pa.date) changes.date = pa.date;
      if (found.splitRatio !== pa.splitRatio) changes.splitRatio = pa.splitRatio;
      if (Object.keys(changes).length > 0) {
        out.activityUpdates.push({ id: found.id, changes, reason: 'refresh' });
        Object.assign(found, changes);
      }
      continue;
    }
    const row: InvestmentActivity = {
      id: newId('act'),
      accountId,
      securityId: security?.id ?? null,
      type: pa.type,
      date: pa.date,
      quantity: pa.quantity,
      price: pa.price,
      amount: pa.amount,
      fees: pa.fees,
      currency: pa.currency,
      splitRatio: pa.splitRatio,
      externalId: pa.externalId,
      source: 'connector',
    };
    out.activityInserts.push(row);
    allActivities.push(row);
    knownActivity.set(k, row);
  }

  // -- holdings and lots ---------------------------------------------------
  const complete = new Set<string>(input.completeAccounts ?? []);
  for (const h of input.result.holdings) complete.add(h.accountExternalId);
  for (const a of input.result.activities) complete.add(a.accountExternalId);

  const holdingByAccountSecurity = new Map<string, Holding>();
  for (const h of input.holdings)
    holdingByAccountSecurity.set(`${h.accountId}\u0000${h.securityId}`, h);
  const seenHoldingIds = new Set<Id>();

  for (const ph of input.result.holdings) {
    const accountId = input.accounts.get(ph.accountExternalId);
    if (!accountId) continue;
    const security = ensureSecurity(ph);
    const existing = holdingByAccountSecurity.get(`${accountId}\u0000${security.id}`);
    const marketValue = valueInMinor(ph.quantity, ph.price, ph.currency);
    let holdingId: Id;
    let costBasis: number | null = ph.costBasis;

    // Lots first, because a broker's lot costs are a better position cost than its own summary.
    const holdingIdForLots = existing?.id ?? newId('hold');
    const existingLots = input.taxLots.filter((l) => l.holdingId === holdingIdForLots);
    let lotPlan: LotPlan;
    if (ph.lots !== null) {
      lotPlan = brokerLots(holdingIdForLots, ph.lots, existingLots, ph.currency);
    } else {
      const relevant = allActivities.filter(
        (a) =>
          a.accountId === accountId &&
          a.securityId === security.id &&
          ['buy', 'sell', 'reinvest', 'split', 'transfer_in', 'transfer_out', 'dividend'].includes(
            a.type,
          ),
      );
      lotPlan = derivedLots(
        holdingIdForLots,
        accountId,
        security.id,
        ph,
        relevant,
        existingLots,
        today,
        out.warnings,
      );
    }
    if (lotPlan.lots.length > 0 && ph.lots !== null) {
      costBasis = lotPlan.lots.reduce((n, l) => n + l.costBasis, 0);
    }

    if (existing) {
      holdingId = existing.id;
      const changes: Partial<Holding> = {};
      if (existing.quantity !== ph.quantity) changes.quantity = ph.quantity;
      if (existing.price !== ph.price) changes.price = ph.price;
      if (existing.marketValue !== marketValue) changes.marketValue = marketValue;
      if (existing.costBasis !== costBasis) changes.costBasis = costBasis;
      if (existing.currency !== ph.currency) changes.currency = ph.currency;
      changes.priceAsOf = input.now;
      out.holdingUpdates.push({ id: existing.id, changes, reason: 'refresh' });
    } else {
      holdingId = holdingIdForLots;
      out.holdingInserts.push({
        id: holdingId,
        accountId,
        securityId: security.id,
        quantity: ph.quantity,
        price: ph.price,
        priceAsOf: input.now,
        marketValue,
        costBasis,
        currency: ph.currency,
        source: 'connector',
      });
    }
    seenHoldingIds.add(holdingId);

    for (const lot of lotPlan.lots) {
      const prior = existingLots.find((l) => l.id === lot.id);
      if (!prior) {
        out.lotInserts.push(lot);
        continue;
      }
      const changes: Partial<TaxLot> = {};
      if (prior.quantity !== lot.quantity) changes.quantity = lot.quantity;
      if (prior.costBasis !== lot.costBasis) changes.costBasis = lot.costBasis;
      if (prior.acquiredOn !== lot.acquiredOn) changes.acquiredOn = lot.acquiredOn;
      if (Object.keys(changes).length > 0) {
        out.lotUpdates.push({ id: lot.id, changes, reason: 'refresh' });
      }
    }
    const keep = new Set(lotPlan.lots.map((l) => l.id));
    for (const prior of existingLots) {
      if (!keep.has(prior.id)) out.lotRemovals.push(prior.id);
    }
  }

  // Holdings that disappeared from a complete account were sold.
  const accountsComplete = new Set<Id>();
  for (const ext of complete) {
    const id = input.accounts.get(ext);
    if (id) accountsComplete.add(id);
  }
  for (const h of input.holdings) {
    if (!accountsComplete.has(h.accountId) || seenHoldingIds.has(h.id)) continue;
    if (h.source !== 'connector') continue;
    out.holdingRemovals.push(h.id);
    for (const lot of input.taxLots) if (lot.holdingId === h.id) out.lotRemovals.push(lot.id);
  }
  return out;
}

interface LotPlan {
  lots: TaxLot[];
}

function brokerLots(
  holdingId: Id,
  wanted: readonly ProviderTaxLot[],
  existing: readonly TaxLot[],
  currency: CurrencyCode,
): LotPlan {
  const lots: TaxLot[] = wanted.map((w, i) => {
    const prior = existing.find((l) => l.source === 'broker' && lotMatches(l, w));
    return {
      id: prior?.id ?? `${holdingId}_blot${i + 1}`,
      holdingId,
      acquiredOn: w.acquiredOn,
      quantity: w.quantity,
      costBasis: w.costBasis,
      currency: w.currency || currency,
      source: 'broker',
      externalId: w.externalId,
    };
  });
  // A broker lot id must stay unique even when two lots share date and size.
  const used = new Set<string>();
  return {
    lots: lots.map((l, i) => {
      if (!used.has(l.id)) {
        used.add(l.id);
        return l;
      }
      const fresh = `${holdingId}_blot${i + 1}_${used.size}`;
      used.add(fresh);
      return { ...l, id: fresh };
    }),
  };
}

function derivedLots(
  holdingId: Id,
  accountId: Id,
  securityId: Id,
  ph: ProviderHolding,
  activities: readonly InvestmentActivity[],
  existing: readonly TaxLot[],
  today: LocalDate,
  warnings: string[],
): LotPlan {
  const derived = deriveLotsFifo({
    activities,
    holdingId,
    accountId,
    securityId,
    currency: ph.currency,
  });
  for (const w of derived.warnings) warnings.push(`${ph.symbol}: ${w}`);

  let lots = derived.lots.map((l) => ({ ...l, externalId: null as string | null }));
  const held = ph.quantity;
  let derivedQty = lots.reduce((n, l) => addDec(n, l.quantity), '0');

  // The broker holds fewer units than the history says: the rest left outside the feed. Trim oldest first.
  if (cmpDec(derivedQty, held) > 0) {
    let excess = subDec(derivedQty, held);
    const trimmed: TaxLot[] = [];
    for (const lot of lots) {
      if (isZeroDec(excess)) {
        trimmed.push(lot);
        continue;
      }
      if (cmpDec(lot.quantity, excess) <= 0) {
        excess = subDec(excess, lot.quantity);
        continue;
      }
      const left = subDec(lot.quantity, excess);
      trimmed.push({
        ...lot,
        quantity: left,
        costBasis: proRateMinor(lot.costBasis, left, lot.quantity),
      });
      excess = '0';
    }
    warnings.push(
      `${ph.symbol}: activity history holds more units than the broker reports; trimmed oldest lots`,
    );
    lots = trimmed;
    derivedQty = lots.reduce((n, l) => addDec(n, l.quantity), '0');
  }

  // The broker holds more than the history explains: cover the rest with an opening lot.
  if (cmpDec(derivedQty, held) < 0) {
    const missing = subDec(held, derivedQty);
    const lotsCost = lots.reduce((n, l) => n + l.costBasis, 0);
    const cost = ph.costBasis !== null ? Math.max(0, ph.costBasis - lotsCost) : 0;
    if (ph.costBasis === null)
      warnings.push(`${ph.symbol}: no cost basis from the broker; opening lot uses 0`);
    const prior = existing.find((l) => l.externalId === OPENING_LOT_ID);
    const earliest = activities.map((a) => a.date).sort()[0];
    lots.push({
      id: prior?.id ?? `${holdingId}_open`,
      holdingId,
      // Keep the first date we ever saw; it must not creep forward on every sync.
      acquiredOn: prior?.acquiredOn ?? earliest ?? today,
      quantity: missing,
      costBasis: cost,
      currency: ph.currency,
      source: 'derived',
      externalId: OPENING_LOT_ID,
    });
  }
  return { lots };
}
