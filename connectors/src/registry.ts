import type { ConnectorDefinition } from '@manaclaude/shared';

/**
 * Every connector from docs/project-brief.md, personal access only.
 * Session D owns this file: it adds adapters, corrects costs and limits at
 * sign-up time, and keeps reasons current. The app reads it (pure data, no
 * network code) to show status and free slots on the Accounts screen.
 *
 * freeSlotsUsed is 0 here; the live count comes from FinanceDataset.connectorSlotsUsed.
 */

type Def = Omit<ConnectorDefinition, 'freeSlotsUsed'> & { freeSlotsUsed?: number };

const defs: Def[] = [
  // Banks and cards (US)
  { id: 'teller', name: 'Teller', kinds: ['bank', 'card'], availability: 'available', reason: null, cost: 'Free, 100 lifetime logins', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'link_widget', freeSlotsTotal: 100, slotsAreLifetime: true, inSure: false },
  { id: 'sophtron', name: 'Sophtron', kinds: ['bank', 'card', 'brokerage', 'crypto'], availability: 'available', reason: 'Free for personal, non-commercial use; 10,000 requests a month', cost: 'Free (personal)', regions: ['US', 'CA'], dataTypes: ['transactions', 'balances', 'holdings'], auth: 'credentials', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'plaid', name: 'Plaid Trial', kinds: ['bank', 'card', 'brokerage'], availability: 'available', reason: 'Keep the 10 lifetime logins for banks Teller and Sophtron cannot reach', cost: 'Free, 10 lifetime logins', regions: ['US', 'CA'], dataTypes: ['transactions', 'balances', 'liabilities', 'holdings', 'lots'], auth: 'link_widget', freeSlotsTotal: 10, slotsAreLifetime: true, inSure: true },
  { id: 'simplefin', name: 'SimpleFIN', kinds: ['bank', 'card'], availability: 'paid', reason: 'Paid fallback if the free connectors run out', cost: '$15/yr, 25 institutions', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: 0, slotsAreLifetime: false, inSure: true },
  { id: 'lunch_flow', name: 'Lunch Flow', kinds: ['aggregator', 'bank', 'card', 'brokerage'], availability: 'paid', reason: 'Only personal route to MX, Finicity and Stripe Financial Connections; also GoCardless and SnapTrade', cost: 'Paid per connection (check current US price)', regions: ['US', 'EU', 'UK'], dataTypes: ['transactions', 'balances', 'holdings'], auth: 'api_key', freeSlotsTotal: 0, slotsAreLifetime: false, inSure: true },

  // Banks in other countries (personal tokens)
  { id: 'enable_banking', name: 'Enable Banking', kinds: ['bank'], availability: 'available', reason: 'Free restricted production for your own linked accounts', cost: 'Free (restricted production)', regions: ['EU', 'UK'], dataTypes: ['transactions', 'balances'], auth: 'oauth', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'wise', name: 'Wise', kinds: ['bank'], availability: 'available', reason: 'Check that your personal account offers API tokens', cost: 'Free (personal token)', regions: ['US', 'EU', 'UK', 'IN'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'akahu', name: 'Akahu', kinds: ['bank'], availability: 'available', reason: null, cost: 'Free for your own data', regions: ['NZ'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'up', name: 'Up', kinds: ['bank'], availability: 'available', reason: null, cost: 'Free (personal token)', regions: ['AU'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'redbark', name: 'Redbark', kinds: ['bank'], availability: 'available', reason: 'Check pricing at sign-up', cost: 'Unknown', regions: ['AU'], dataTypes: ['transactions', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'monobank', name: 'Monobank', kinds: ['bank'], availability: 'available', reason: null, cost: 'Free (personal token)', regions: ['UA'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'fio', name: 'Fio banka', kinds: ['bank'], availability: 'available', reason: null, cost: 'Free (personal token)', regions: ['CZ'], dataTypes: ['transactions', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },

  // Brokerages
  { id: 'snaptrade', name: 'SnapTrade Personal', kinds: ['brokerage'], availability: 'available', reason: 'Tax lots are a paid add-on, so lots are derived from activities', cost: 'Free, 20 connections', regions: ['US', 'CA', 'IN'], dataTypes: ['holdings', 'balances', 'activities'], auth: 'link_widget', freeSlotsTotal: 20, slotsAreLifetime: false, inSure: true },
  { id: 'ibkr_flex', name: 'Interactive Brokers Flex', kinds: ['brokerage'], availability: 'available', reason: 'Personal token valid up to 1 year', cost: 'Free (personal token)', regions: ['US', 'IN', 'EU'], dataTypes: ['holdings', 'activities', 'lots', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'zerodha_kite', name: 'Zerodha Kite Connect Personal', kinds: ['brokerage'], availability: 'available', reason: 'Access token expires daily; sign in again each morning', cost: 'Free (personal)', regions: ['IN'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'oauth', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'trading212', name: 'Trading 212', kinds: ['brokerage'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['EU', 'UK'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'questrade', name: 'Questrade', kinds: ['brokerage'], availability: 'available', reason: null, cost: 'Free (personal token)', regions: ['CA'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'trade_republic', name: 'Trade Republic', kinds: ['brokerage'], availability: 'available', reason: null, cost: 'Free (personal login)', regions: ['EU'], dataTypes: ['holdings', 'activities'], auth: 'credentials', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'indexa', name: 'Indexa Capital', kinds: ['brokerage'], availability: 'available', reason: null, cost: 'Free (personal token)', regions: ['ES'], dataTypes: ['holdings', 'balances'], auth: 'personal_token', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },

  // Crypto
  { id: 'coinbase', name: 'Coinbase', kinds: ['crypto'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['US', 'EU', 'UK'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'kraken', name: 'Kraken', kinds: ['crypto'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['US', 'EU'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'binance', name: 'Binance', kinds: ['crypto'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['Global'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'coinspot', name: 'CoinSpot', kinds: ['crypto'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['AU'], dataTypes: ['holdings', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'wazirx', name: 'WazirX', kinds: ['crypto'], availability: 'available', reason: null, cost: 'Free (personal API key)', regions: ['IN'], dataTypes: ['holdings', 'activities', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'onchain', name: 'On-chain wallets', kinds: ['crypto'], availability: 'available', reason: 'Bitcoin, EVM chains, Solana, Polkadot, Cosmos from public blockchain data', cost: 'Free', regions: ['Global'], dataTypes: ['holdings', 'balances'], auth: 'public_address', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'coinstats', name: 'CoinStats', kinds: ['crypto'], availability: 'available', reason: 'Check the free plan at sign-up', cost: 'Free plan (check limits)', regions: ['Global'], dataTypes: ['holdings', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },

  // Property and vehicles
  { id: 'rentcast', name: 'RentCast', kinds: ['property'], availability: 'available', reason: '50 calls a month on the free plan', cost: 'Free, 50 calls a month', regions: ['US'], dataTypes: ['valuations'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'realie', name: 'Realie', kinds: ['property'], availability: 'available', reason: 'Check the free plan at sign-up', cost: 'Free plan (check limits)', regions: ['US'], dataTypes: ['valuations'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'manual_vehicle', name: 'Vehicle (manual value)', kinds: ['vehicle'], availability: 'available', reason: null, cost: 'Free', regions: ['Global'], dataTypes: ['valuations'], auth: 'none', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },

  // Market data and FX
  { id: 'yahoo_finance', name: 'Yahoo Finance', kinds: ['market_data'], availability: 'available', reason: 'First choice for prices, including NSE and BSE', cost: 'Free', regions: ['Global'], dataTypes: ['prices'], auth: 'none', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'twelve_data', name: 'Twelve Data', kinds: ['market_data'], availability: 'available', reason: 'Fallback price source', cost: 'Free plan', regions: ['Global'], dataTypes: ['prices'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'tiingo', name: 'Tiingo', kinds: ['market_data'], availability: 'available', reason: 'Fallback price source', cost: 'Free plan', regions: ['US'], dataTypes: ['prices'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'eodhd', name: 'EODHD', kinds: ['market_data'], availability: 'available', reason: 'Fallback price source', cost: 'Free plan', regions: ['Global'], dataTypes: ['prices'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'open_exchange_rates', name: 'Open Exchange Rates', kinds: ['fx'], availability: 'available', reason: 'Hourly latest rates, USD base', cost: 'Free plan', regions: ['Global'], dataTypes: ['fx_rates'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'frankfurter', name: 'Frankfurter (ECB)', kinds: ['fx'], availability: 'available', reason: 'Daily ECB rates: fallback and history', cost: 'Free', regions: ['Global'], dataTypes: ['fx_rates'], auth: 'none', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },

  // Not usable: needs a business account or contract
  { id: 'mercury', name: 'Mercury', kinds: ['bank'], availability: 'unavailable', reason: 'Business bank accounts only', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'brex', name: 'Brex', kinds: ['bank', 'card'], availability: 'unavailable', reason: 'Business accounts only', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'mx', name: 'MX', kinds: ['aggregator'], availability: 'unavailable', reason: 'Business contract only; reach MX through Lunch Flow instead', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'link_widget', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'finicity', name: 'Mastercard Data Connect (Finicity)', kinds: ['aggregator'], availability: 'unavailable', reason: 'Business contract only; reach Finicity through Lunch Flow instead', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'link_widget', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'akoya', name: 'Akoya', kinds: ['aggregator'], availability: 'unavailable', reason: 'Business contract only', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'oauth', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'apple_financekit', name: 'Apple FinanceKit', kinds: ['bank', 'card'], availability: 'unavailable', reason: 'Needs an organization-level Apple Developer account; iOS only', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'none', freeSlotsTotal: null, slotsAreLifetime: false, inSure: true },
  { id: 'zillow', name: 'Zillow API', kinds: ['property'], availability: 'unavailable', reason: 'Partners only', cost: 'n/a', regions: ['US'], dataTypes: ['valuations'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'vinaudit', name: 'VinAudit', kinds: ['vehicle'], availability: 'unavailable', reason: 'Business API only', cost: 'n/a', regions: ['US'], dataTypes: ['valuations'], auth: 'api_key', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'capital_one_direct', name: 'Capital One direct link', kinds: ['bank', 'card'], availability: 'unavailable', reason: 'Not offered to personal developers; use Teller, Sophtron or Plaid', cost: 'n/a', regions: ['US'], dataTypes: ['transactions', 'balances'], auth: 'oauth', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
  { id: 'public_direct', name: 'Public direct link', kinds: ['brokerage'], availability: 'unavailable', reason: 'Not offered to personal developers; use SnapTrade', cost: 'n/a', regions: ['US'], dataTypes: ['holdings'], auth: 'oauth', freeSlotsTotal: null, slotsAreLifetime: false, inSure: false },
];

export const CONNECTOR_REGISTRY: readonly ConnectorDefinition[] = defs.map((d) => ({
  freeSlotsUsed: 0,
  ...d,
}));

/** Order to try when linking a new account (docs/project-brief.md "Connector order"). */
export const LINK_ORDER = {
  bank: ['teller', 'sophtron', 'plaid'],
  brokerage: ['snaptrade', 'ibkr_flex', 'zerodha_kite', 'trading212', 'questrade', 'trade_republic', 'indexa', 'sophtron', 'plaid'],
  crypto: ['coinbase', 'kraken', 'binance', 'coinspot', 'wazirx', 'onchain', 'coinstats'],
  paidFallback: ['simplefin', 'lunch_flow'],
} as const;

export function getConnector(id: string): ConnectorDefinition | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.id === id);
}

/** Registry entries with live slot counts from the dataset. */
export function withSlotUsage(
  used: Readonly<Record<string, number>>,
  registry: readonly ConnectorDefinition[] = CONNECTOR_REGISTRY,
): ConnectorDefinition[] {
  return registry.map((c) => ({ ...c, freeSlotsUsed: used[c.id] ?? 0 }));
}

/** Free slots left, or null for no cap. */
export function freeSlotsLeft(c: ConnectorDefinition): number | null {
  return c.freeSlotsTotal === null ? null : Math.max(0, c.freeSlotsTotal - c.freeSlotsUsed);
}
