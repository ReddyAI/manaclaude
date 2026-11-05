import type {
  Connection,
  ConnectorContext,
  ProviderActivity,
  ProviderHolding,
  SyncResult,
} from '@manaclaude/shared';
import { HttpClient } from '../../http';
import { sinceCursor } from '../../util/cursor';
import { todayUtc, toLocalDate } from '../../util/dates';
import { mulDec } from '@manaclaude/shared';
import { toDecimalString, toMinor } from '../../util/decimal';
import {
  connectionSecret,
  defineAdapter,
  emptyResult,
  optionalSecret,
  providerAccount,
} from '../../kit';
import { ProviderDataError } from '../../errors';

/**
 * On-chain wallets from public blockchain data, no keys: Bitcoin, EVM chains,
 * Solana, Polkadot and Cosmos. Follows Sure's onchain_wallet_adapter.rb with
 * its providers mempool_space.rb, blockscout.rb, solana_rpc.rb,
 * polkadot_sidecar.rb and cosmos_rest.rb (same public endpoints).
 *
 * - Settings per login (read from ctx.secrets, they are not secret): ONCHAIN_CHAIN
 *   ("bitcoin", "evm", "solana", "polkadot" or "cosmos"), ONCHAIN_ADDRESS,
 *   optional ONCHAIN_NAME. EVM only: ONCHAIN_EVM_BASE_URL (a Blockscout site,
 *   default eth.blockscout.com) and ONCHAIN_EVM_SYMBOL (ETH). Optional URL
 *   overrides: ONCHAIN_BTC_BASE_URL, ONCHAIN_SOLANA_RPC_URL, ONCHAIN_POLKADOT_BASE_URL,
 *   ONCHAIN_COSMOS_BASE_URL.
 * - One USD crypto account per address with the native coin (and ERC-20 tokens
 *   that Blockscout prices) as holdings. Native prices come from Blockscout's
 *   exchange_rate, otherwise from CoinGecko's free simple/price.
 * - Bitcoin and EVM add transfers in and out as activities with no cash effect;
 *   the first balance is covered by an opening lot (no one can know the cost
 *   of coins that arrived from elsewhere).
 * - Nothing here needs repair: a public address cannot log out.
 */

type Chain = 'bitcoin' | 'evm' | 'solana' | 'polkadot' | 'cosmos';

const COINGECKO = 'https://api.coingecko.com/api/v3';
const COINS: Record<
  Exclude<Chain, 'evm'>,
  { symbol: string; name: string; gecko: string; decimals: number }
> = {
  bitcoin: { symbol: 'BTC', name: 'Bitcoin', gecko: 'bitcoin', decimals: 8 },
  solana: { symbol: 'SOL', name: 'Solana', gecko: 'solana', decimals: 9 },
  polkadot: { symbol: 'DOT', name: 'Polkadot', gecko: 'polkadot', decimals: 10 },
  cosmos: { symbol: 'ATOM', name: 'Cosmos Hub', gecko: 'cosmos', decimals: 6 },
};

/** Integer base units ("1500000000000000000") to a decimal string at `decimals` places. */
export function fromBaseUnits(raw: string | number, decimals: number): string {
  const s = String(raw).replace(/^-/, '').replace(/\D/g, '') || '0';
  const padded = s.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

async function geckoPrice(http: HttpClient, id: string): Promise<string | null> {
  const r = await http.get<Record<string, { usd?: number }>>(`${COINGECKO}/simple/price`, {
    ids: id,
    vs_currencies: 'usd',
  });
  return toDecimalString(r?.[id]?.usd ?? null);
}

function native(
  accountId: string,
  symbol: string,
  name: string,
  quantity: string,
  price: string | null,
): ProviderHolding | null {
  if (quantity === '0') return null;
  return {
    accountExternalId: accountId,
    symbol,
    name,
    securityType: 'crypto',
    exchange: 'CRYPTO',
    quantity,
    price: price ?? '0',
    currency: 'USD',
    costBasis: null,
    lots: null,
  };
}

interface BtcTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}
interface EvmTx {
  hash: string;
  timestamp: string;
  from: { hash: string };
  to: { hash: string } | null;
  value: string;
  status?: string;
}

export async function syncOnchain(
  ctx: ConnectorContext,
  _connection: Connection,
): Promise<SyncResult> {
  void _connection;
  const chain = connectionSecret(ctx, 'ONCHAIN_CHAIN', 'On-chain wallet') as Chain;
  const address = connectionSecret(ctx, 'ONCHAIN_ADDRESS', 'On-chain wallet');
  const name = optionalSecret(ctx, 'ONCHAIN_NAME') ?? `${chain} wallet`;
  const http = new HttpClient(ctx, {
    provider: 'On-chain',
    baseUrl: 'https://invalid.local',
    repairStatuses: [],
  });
  const today = todayUtc(ctx.now());
  const accountId = `onchain_${chain}_${address}`;
  const result = emptyResult();
  const holdings: ProviderHolding[] = [];
  const enc = encodeURIComponent(address);

  if (chain === 'bitcoin') {
    const base = optionalSecret(ctx, 'ONCHAIN_BTC_BASE_URL') ?? 'https://mempool.space/api';
    const a = await http.get<{
      chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
      mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
    }>(`${base}/address/${enc}`);
    if (!a?.chain_stats) throw new ProviderDataError('mempool.space', 'address');
    const sats =
      a.chain_stats.funded_txo_sum -
      a.chain_stats.spent_txo_sum +
      a.mempool_stats.funded_txo_sum -
      a.mempool_stats.spent_txo_sum;
    const coin = COINS.bitcoin;
    const h = native(
      accountId,
      coin.symbol,
      coin.name,
      fromBaseUnits(sats, coin.decimals),
      await geckoPrice(http, coin.gecko),
    );
    if (h) holdings.push(h);
    const txs = await http.get<BtcTx[]>(`${base}/address/${enc}/txs`);
    for (const t of Array.isArray(txs) ? txs : []) {
      const date = toLocalDate(t.status.block_time ?? Math.floor(ctx.now().getTime() / 1000));
      const received = t.vout
        .filter((o) => o.scriptpubkey_address === address)
        .reduce((n, o) => n + o.value, 0);
      const sent = t.vin
        .filter((i) => i.prevout?.scriptpubkey_address === address)
        .reduce((n, i) => n + (i.prevout?.value ?? 0), 0);
      const net = received - sent;
      if (!date || net === 0) continue;
      result.activities.push({
        externalId: t.txid,
        accountExternalId: accountId,
        symbol: 'BTC',
        type: net > 0 ? 'transfer_in' : 'transfer_out',
        date,
        quantity: fromBaseUnits(Math.abs(net), 8),
        price: null,
        amount: 0,
        fees: 0,
        currency: 'USD',
        splitRatio: null,
      } satisfies ProviderActivity);
    }
  } else if (chain === 'evm') {
    const base = optionalSecret(ctx, 'ONCHAIN_EVM_BASE_URL') ?? 'https://eth.blockscout.com';
    const symbol = optionalSecret(ctx, 'ONCHAIN_EVM_SYMBOL') ?? 'ETH';
    const a = await http.get<{ coin_balance: string | null; exchange_rate: string | null }>(
      `${base}/api/v2/addresses/${enc}`,
    );
    if (!a) throw new ProviderDataError('Blockscout', 'address');
    const h = native(
      accountId,
      symbol,
      symbol,
      fromBaseUnits(a.coin_balance ?? '0', 18),
      toDecimalString(a.exchange_rate),
    );
    if (h) holdings.push(h);
    const tokens = await http.get<
      {
        token: {
          symbol: string | null;
          name: string | null;
          decimals: string | null;
          exchange_rate: string | null;
          type: string;
        };
        value: string;
      }[]
    >(`${base}/api/v2/addresses/${enc}/token-balances`);
    for (const t of Array.isArray(tokens) ? tokens : []) {
      if (t.token.type !== 'ERC-20' || !t.token.symbol) continue;
      const price = toDecimalString(t.token.exchange_rate);
      const qty = fromBaseUnits(t.value, Number(t.token.decimals ?? 18));
      if (!price || qty === '0') continue; // unpriced tokens are usually spam
      holdings.push({
        accountExternalId: accountId,
        symbol: t.token.symbol,
        name: t.token.name ?? t.token.symbol,
        securityType: 'crypto',
        exchange: 'CRYPTO',
        quantity: qty,
        price,
        currency: 'USD',
        costBasis: null,
        lots: null,
      });
    }
    const txs = await http.get<{ items: EvmTx[] }>(`${base}/api/v2/addresses/${enc}/transactions`);
    for (const t of txs?.items ?? []) {
      const date = toLocalDate(t.timestamp);
      const incoming = t.to?.hash?.toLowerCase() === address.toLowerCase();
      if (!date || t.value === '0' || (t.status && t.status !== 'ok')) continue;
      result.activities.push({
        externalId: t.hash,
        accountExternalId: accountId,
        symbol,
        type: incoming ? 'transfer_in' : 'transfer_out',
        date,
        quantity: fromBaseUnits(t.value, 18),
        price: null,
        amount: 0,
        fees: 0,
        currency: 'USD',
        splitRatio: null,
      });
    }
  } else if (chain === 'solana') {
    const url =
      optionalSecret(ctx, 'ONCHAIN_SOLANA_RPC_URL') ?? 'https://api.mainnet-beta.solana.com';
    const r = await http.post<{ result?: { value: number } }>(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    });
    if (r?.result?.value === undefined) throw new ProviderDataError('Solana RPC', 'getBalance');
    const coin = COINS.solana;
    const h = native(
      accountId,
      coin.symbol,
      coin.name,
      fromBaseUnits(r.result.value, coin.decimals),
      await geckoPrice(http, coin.gecko),
    );
    if (h) holdings.push(h);
  } else if (chain === 'polkadot') {
    const base =
      optionalSecret(ctx, 'ONCHAIN_POLKADOT_BASE_URL') ??
      'https://polkadot-asset-hub-public-sidecar.parity-chains.parity.io';
    const r = await http.get<{ free: string; reserved?: string }>(
      `${base}/accounts/${enc}/balance-info`,
    );
    if (!r || r.free === undefined) throw new ProviderDataError('Polkadot sidecar', 'balance-info');
    const coin = COINS.polkadot;
    const total = BigInt(r.free) + BigInt(r.reserved ?? '0');
    const h = native(
      accountId,
      coin.symbol,
      coin.name,
      fromBaseUnits(total.toString(), coin.decimals),
      await geckoPrice(http, coin.gecko),
    );
    if (h) holdings.push(h);
  } else if (chain === 'cosmos') {
    const base =
      optionalSecret(ctx, 'ONCHAIN_COSMOS_BASE_URL') ?? 'https://cosmos-rest.publicnode.com';
    const bal = await http.get<{ balance?: { amount: string } }>(
      `${base}/cosmos/bank/v1beta1/balances/${enc}/by_denom`,
      { denom: 'uatom' },
    );
    const del = await http.get<{ delegation_responses?: { balance: { amount: string } }[] }>(
      `${base}/cosmos/staking/v1beta1/delegations/${enc}`,
    );
    const unb = await http.get<{ unbonding_responses?: { entries: { balance: string }[] }[] }>(
      `${base}/cosmos/staking/v1beta1/delegators/${enc}/unbonding_delegations`,
    );
    let total = BigInt(bal?.balance?.amount ?? '0');
    for (const d of del?.delegation_responses ?? [])
      total += BigInt(d.balance.amount.split('.')[0] ?? '0');
    for (const u of unb?.unbonding_responses ?? [])
      for (const e of u.entries) total += BigInt(e.balance.split('.')[0] ?? '0');
    const coin = COINS.cosmos;
    const h = native(
      accountId,
      coin.symbol,
      coin.name,
      fromBaseUnits(total.toString(), coin.decimals),
      await geckoPrice(http, coin.gecko),
    );
    if (h) holdings.push(h);
  } else {
    throw new ProviderDataError('On-chain', `unknown chain ${String(chain)}`);
  }

  const value = holdings.reduce((n, h) => n + toMinor(mulDec(h.quantity, h.price), 'USD'), 0);
  result.accounts.push(
    providerAccount({
      externalId: accountId,
      name,
      institutionName: chain,
      type: 'crypto',
      currency: 'USD',
      balance: value,
      mask: address.slice(-4),
    }),
  );
  result.holdings = holdings;
  result.nextCursor = sinceCursor(today);
  return result;
}

export const onchainAdapter = defineAdapter({ id: 'onchain', sync: syncOnchain });
