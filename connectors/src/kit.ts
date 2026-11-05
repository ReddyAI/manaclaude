import type {
  Connection,
  ConnectionStatus,
  ConnectorAdapter,
  ConnectorContext,
  ProviderAccount,
  ProviderTransaction,
  SyncResult,
  SecurityType,
  ExchangeCode,
} from '@manaclaude/shared';
import { ConnectorConfigError, ConnectorRepairNeededError, repairNeeded } from './errors';
import { utf8, toBase64 } from './util/crypto';

/** Helpers every adapter uses. */

export function emptyResult(): SyncResult {
  return {
    accounts: [],
    transactions: [],
    removedTransactionExternalIds: [],
    holdings: [],
    activities: [],
    nextCursor: null,
  };
}

/** A key the Worker owns (client id, API secret). A missing one is a setup problem, not a login problem. */
export function appSecret(ctx: ConnectorContext, name: string, provider: string): string {
  const value = ctx.secrets[name];
  if (!value)
    throw new ConnectorConfigError(`${provider} is not set up: missing Worker secret ${name}`);
  return value;
}

/** A credential that belongs to one login (access token, API key). A missing one means the login must be repaired. */
export function connectionSecret(ctx: ConnectorContext, name: string, provider: string): string {
  const value = ctx.secrets[name];
  if (!value) throw repairNeeded(provider, `credential ${name} is missing`);
  return value;
}

export function optionalSecret(ctx: ConnectorContext, name: string): string | undefined {
  const value = ctx.secrets[name];
  return value ? value : undefined;
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${toBase64(utf8(`${user}:${password}`))}`;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

/** Fill the boring fields of a ProviderAccount. */
export function providerAccount(
  a: Pick<ProviderAccount, 'externalId' | 'name' | 'type' | 'currency' | 'balance'> &
    Partial<ProviderAccount>,
): ProviderAccount {
  return {
    institutionName: null,
    subtype: null,
    availableBalance: null,
    creditLimit: null,
    mask: null,
    ...a,
  };
}

/** Fill the boring fields of a ProviderTransaction. `amount` must already follow the sign rule. */
export function providerTransaction(
  t: Pick<
    ProviderTransaction,
    'externalId' | 'accountExternalId' | 'date' | 'amount' | 'currency' | 'rawName'
  > &
    Partial<ProviderTransaction>,
): ProviderTransaction {
  return {
    originalAmount: null,
    originalCurrency: null,
    merchantName: null,
    pending: false,
    pendingExternalId: null,
    categoryHint: null,
    ...t,
  };
}

/** Deterministic non-cryptographic hash (cyrb53) for ids of rows that have no provider id. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Id for a transaction the provider gave no id for. Two identical rows (same
 * account, date, amount and text) get occurrence 1 and 2, so both survive and
 * a repeated sync produces the same ids again.
 */
export function syntheticId(
  prefix: string,
  parts: readonly (string | number | null)[],
  seen: Map<string, number>,
): string {
  const key = parts.map((p) => String(p ?? '')).join('|');
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return `${prefix}_${hashString(key)}_${n}`;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Tidy a bank description for display: collapse spaces, drop trailing reference numbers. */
export function cleanName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? 'Unknown' : collapsed;
}

export function guessSecurityType(symbol: string, hint?: string | null): SecurityType {
  const h = (hint ?? '').toLowerCase();
  if (/crypto|coin|digital/.test(h)) return 'crypto';
  if (/etf|exchange traded/.test(h)) return 'etf';
  if (/mutual|fund|mf/.test(h)) return 'mutual_fund';
  if (/bond|fixed income|debt/.test(h)) return 'bond';
  if (/option|derivative/.test(h)) return 'option';
  if (/cash|currency|money market/.test(h)) return 'cash';
  if (/equity|stock|common|share/.test(h)) return 'equity';
  return symbol.length > 0 ? 'equity' : 'other';
}

/** NSE and BSE codes as Kite, Yahoo and others spell them. */
export function toExchangeCode(raw: string | null | undefined): ExchangeCode | null {
  if (!raw) return null;
  const x = raw.toUpperCase();
  if (x === 'NSE' || x === 'NSI' || x === 'XNSE' || x === 'NS') return 'NSE';
  if (x === 'BSE' || x === 'BOM' || x === 'XBOM' || x === 'BO') return 'BSE';
  if (x === 'NASDAQ' || x === 'XNAS' || x === 'NMS' || x === 'NGM' || x === 'NCM') return 'NASDAQ';
  if (x === 'NYSE' || x === 'XNYS') return 'NYSE';
  if (x === 'ARCA' || x === 'ARCX' || x === 'PCX' || x === 'NYSEARCA') return 'ARCA';
  if (x === 'BATS' || x === 'BATX' || x === 'XBATS' || x === 'BTS') return 'BATS';
  return x;
}

export interface AdapterSpec {
  id: string;
  sync: ConnectorAdapter['sync'];
  /** Cheap call that proves the credentials still work. Throws like sync does. */
  probe?: (ctx: ConnectorContext, connection: Connection) => Promise<void>;
}

/** Build a ConnectorAdapter whose checkHealth maps probe errors to a ConnectionStatus. */
export function defineAdapter(spec: AdapterSpec): ConnectorAdapter {
  const adapter: ConnectorAdapter = { id: spec.id, sync: spec.sync };
  const probe = spec.probe;
  if (probe) {
    adapter.checkHealth = async (ctx, connection): Promise<ConnectionStatus> => {
      try {
        await probe(ctx, connection);
        return 'healthy';
      } catch (error) {
        return error instanceof ConnectorRepairNeededError ? 'needs_repair' : 'error';
      }
    };
  }
  return adapter;
}
