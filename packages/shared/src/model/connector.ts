import type {
  CurrencyCode,
  DecimalString,
  Id,
  IsoDateTime,
  LocalDate,
  MinorUnits,
  Timestamps,
} from './common';
import type { AccountSubtype, AccountType } from './account';
import type { InvestmentActivityType, SecurityType, ExchangeCode } from './investment';

export type ConnectorKind =
  | 'bank'
  | 'card'
  | 'brokerage'
  | 'crypto'
  | 'property'
  | 'vehicle'
  | 'market_data'
  | 'fx'
  | 'aggregator';

/** available = free for personal use; paid = works but costs money; unavailable = needs a business account or contract. */
export type ConnectorAvailability = 'available' | 'paid' | 'unavailable';

export type ConnectorDataType =
  | 'transactions'
  | 'balances'
  | 'holdings'
  | 'lots'
  | 'activities'
  | 'liabilities'
  | 'valuations'
  | 'prices'
  | 'fx_rates';

export type ConnectorAuth =
  | 'link_widget'
  | 'oauth'
  | 'api_key'
  | 'personal_token'
  | 'credentials'
  | 'public_address'
  | 'none';

/** One entry in the connector registry (connectors/src/registry.ts). */
export interface ConnectorDefinition {
  id: string;
  name: string;
  kinds: ConnectorKind[];
  availability: ConnectorAvailability;
  /** Why it is paid or unavailable, or a short note on limits. */
  reason: string | null;
  /** Plain-language cost ("Free, 100 lifetime logins", "$15/yr"). */
  cost: string;
  /** ISO country codes or region names ("US", "IN", "EU"). */
  regions: string[];
  dataTypes: ConnectorDataType[];
  auth: ConnectorAuth;
  /** null = no cap on free connections. */
  freeSlotsTotal: number | null;
  /** Connections used so far. Lifetime caps never give a slot back. */
  freeSlotsUsed: number;
  /** True when the free slots are lifetime logins (Teller, Plaid Trial). */
  slotsAreLifetime: boolean;
  /** Sure has an adapter we can port. */
  inSure: boolean;
}

export type ConnectionStatus = 'healthy' | 'syncing' | 'needs_repair' | 'error' | 'disconnected';

/** A login at one institution through one connector. One connector per account. */
export interface Connection extends Timestamps {
  id: Id;
  connectorId: string;
  institutionName: string;
  status: ConnectionStatus;
  lastSyncAt: IsoDateTime | null;
  lastSuccessfulSyncAt: IsoDateTime | null;
  /** Short message for the UI, never a raw provider payload. */
  lastError: string | null;
  /** Provider cursor for incremental sync. */
  syncCursor: string | null;
  accountIds: Id[];
}

// ---------------------------------------------------------------------------
// Adapter contract: every connector adapter returns data in these shapes, with
// amounts already converted to the model's sign rule (negative = money out).
// ---------------------------------------------------------------------------

export interface ProviderAccount {
  externalId: string;
  name: string;
  institutionName: string | null;
  type: AccountType;
  subtype: AccountSubtype | null;
  currency: CurrencyCode;
  /** Same sign rule as Account.balance (liabilities positive = owed). */
  balance: MinorUnits;
  availableBalance: MinorUnits | null;
  creditLimit: MinorUnits | null;
  mask: string | null;
}

export interface ProviderTransaction {
  externalId: string;
  accountExternalId: string;
  date: LocalDate;
  /** Negative = money out of the account. */
  amount: MinorUnits;
  currency: CurrencyCode;
  originalAmount: MinorUnits | null;
  originalCurrency: CurrencyCode | null;
  rawName: string;
  merchantName: string | null;
  pending: boolean;
  /** For a posted transaction: the id it had while pending. */
  pendingExternalId: string | null;
  /** Provider's category label, used as a hint only. */
  categoryHint: string | null;
}

export interface ProviderTaxLot {
  externalId: string | null;
  acquiredOn: LocalDate;
  quantity: DecimalString;
  costBasis: MinorUnits;
  currency: CurrencyCode;
}

export interface ProviderHolding {
  accountExternalId: string;
  symbol: string;
  name: string;
  securityType: SecurityType;
  exchange: ExchangeCode | null;
  quantity: DecimalString;
  price: DecimalString;
  currency: CurrencyCode;
  costBasis: MinorUnits | null;
  /** Present when the broker provides lots (Plaid tax_lots). */
  lots: ProviderTaxLot[] | null;
}

export interface ProviderActivity {
  externalId: string;
  accountExternalId: string;
  symbol: string | null;
  type: InvestmentActivityType;
  date: LocalDate;
  quantity: DecimalString | null;
  price: DecimalString | null;
  amount: MinorUnits;
  fees: MinorUnits;
  currency: CurrencyCode;
  splitRatio: DecimalString | null;
}

export interface SyncResult {
  accounts: ProviderAccount[];
  transactions: ProviderTransaction[];
  /** Provider ids of transactions the provider removed (for example a pending charge that dropped). */
  removedTransactionExternalIds: string[];
  holdings: ProviderHolding[];
  activities: ProviderActivity[];
  /** Store and pass back on the next sync. */
  nextCursor: string | null;
}

/** Minimal fetch shape so adapters run the same in the Worker and in tests. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ConnectorContext {
  /** Secrets for this connector, read from Worker secrets. Never logged. */
  secrets: Record<string, string>;
  fetch: FetchLike;
  now(): Date;
}

/** Thrown by adapters when the login needs the user (expired token, MFA). The app shows "Repair". */
export class ConnectorRepairNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorRepairNeededError';
  }
}

export interface ConnectorAdapter {
  id: string;
  /** Pull everything new since `cursor`. Must be safe to call repeatedly. */
  sync(ctx: ConnectorContext, connection: Connection): Promise<SyncResult>;
  /** Cheap check used for the health badge. */
  checkHealth?(ctx: ConnectorContext, connection: Connection): Promise<ConnectionStatus>;
}
