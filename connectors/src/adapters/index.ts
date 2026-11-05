import type { ConnectorAdapter } from '@manaclaude/shared';
import { akahuAdapter } from './akahu';
import { binanceAdapter } from './binance';
import { coinbaseAdapter } from './coinbase';
import { coinspotAdapter } from './coinspot';
import { coinstatsAdapter } from './coinstats';
import { enableBankingAdapter } from './enable_banking';
import { eodhdAdapter, eodhdProvider } from './eodhd';
import { fioAdapter } from './fio';
import { ibkrFlexAdapter } from './ibkr_flex';
import { indexaAdapter } from './indexa';
import { krakenAdapter } from './kraken';
import { lunchFlowAdapter } from './lunch_flow';
import { monobankAdapter } from './monobank';
import { onchainAdapter } from './onchain';
import { plaidAdapter } from './plaid';
import { questradeAdapter } from './questrade';
import { simplefinAdapter } from './simplefin';
import { realieAdapter } from './realie';
import { redbarkAdapter } from './redbark';
import { rentcastAdapter } from './rentcast';
import { snaptradeAdapter } from './snaptrade';
import { sophtronAdapter } from './sophtron';
import { tellerAdapter } from './teller';
import { trading212Adapter } from './trading212';
import { tiingoAdapter, tiingoProvider } from './tiingo';
import { twelveDataAdapter, twelveDataProvider } from './twelve_data';
import { upAdapter } from './up';
import { wiseAdapter } from './wise';
import { yahooFinanceAdapter, yahooFinanceProvider } from './yahoo_finance';
import type { MarketDataProvider } from '../market/types';
import { wazirxAdapter } from './wazirx';
import { zerodhaKiteAdapter } from './zerodha_kite';

/**
 * Adapter lookup by connector id. Session D adds one file per adapter under
 * src/adapters/<id>/ and registers it here.
 */
const list: ConnectorAdapter[] = [
  tellerAdapter,
  sophtronAdapter,
  plaidAdapter,
  snaptradeAdapter,
  zerodhaKiteAdapter,
  coinbaseAdapter,
  wazirxAdapter,
  simplefinAdapter,
  lunchFlowAdapter,
  upAdapter,
  akahuAdapter,
  monobankAdapter,
  fioAdapter,
  krakenAdapter,
  binanceAdapter,
  coinspotAdapter,
  coinstatsAdapter,
  onchainAdapter,
  ibkrFlexAdapter,
  trading212Adapter,
  questradeAdapter,
  indexaAdapter,
  wiseAdapter,
  enableBankingAdapter,
  redbarkAdapter,
  rentcastAdapter,
  realieAdapter,
  yahooFinanceAdapter,
  twelveDataAdapter,
  tiingoAdapter,
  eodhdAdapter,
];

/** Market-data providers in the order to try them: Yahoo Finance, Twelve Data, Tiingo, EODHD. */
export const MARKET_DATA_PROVIDERS: readonly MarketDataProvider[] = [
  yahooFinanceProvider,
  twelveDataProvider,
  tiingoProvider,
  eodhdProvider,
];

export const ADAPTERS: Readonly<Record<string, ConnectorAdapter>> = Object.fromEntries(
  list.map((a) => [a.id, a]),
);

export function getAdapter(connectorId: string): ConnectorAdapter | undefined {
  return ADAPTERS[connectorId];
}
