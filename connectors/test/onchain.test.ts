import { describe, expect, it } from 'vitest';
import { fromBaseUnits, onchainAdapter } from '../src/adapters/onchain';
import { fakeFetch, fixture, makeConnection, makeCtx } from './helpers/fakeFetch';
import { expectRepeatSyncIsQuiet, expectSyncShape } from './helpers/contract';

const GECKO = 'GET api.coingecko.com/api/v3/simple/price';
const BTC = 'bc1qdemoaddress00000000000000000000000000';
const EVM = '0x00000000000000000000000000000000000000aa';

const btcCtx = () =>
  makeCtx(
    { ONCHAIN_CHAIN: 'bitcoin', ONCHAIN_ADDRESS: BTC, ONCHAIN_NAME: 'Cold storage' },
    fakeFetch({
      [`GET mempool.space/api/address/${BTC}`]: { json: fixture('onchain', 'btc_address.json') },
      [`GET mempool.space/api/address/${BTC}/txs`]: { json: fixture('onchain', 'btc_txs.json') },
      [GECKO]: { json: fixture('onchain', 'gecko.json') },
    }),
  );
const evmCtx = () =>
  makeCtx(
    { ONCHAIN_CHAIN: 'evm', ONCHAIN_ADDRESS: EVM },
    fakeFetch({
      [`GET eth.blockscout.com/api/v2/addresses/${EVM}`]: {
        json: fixture('onchain', 'evm_address.json'),
      },
      [`GET eth.blockscout.com/api/v2/addresses/${EVM}/token-balances`]: {
        json: fixture('onchain', 'evm_tokens.json'),
      },
      [`GET eth.blockscout.com/api/v2/addresses/${EVM}/transactions`]: {
        json: fixture('onchain', 'evm_txs.json'),
      },
    }),
  );

describe('on-chain wallets', () => {
  it('converts base units exactly', () => {
    expect(fromBaseUnits('1500000000000000000', 18)).toBe('1.5');
    expect(fromBaseUnits(5_000_000, 8)).toBe('0.05');
    expect(fromBaseUnits('1', 8)).toBe('0.00000001');
    expect(fromBaseUnits('0', 18)).toBe('0');
  });

  it('Bitcoin: balance from funded minus spent, transfers in and out, lots from the transfers', async () => {
    const { store, first } = await expectRepeatSyncIsQuiet(onchainAdapter, btcCtx);
    await expectSyncShape(first);
    expect(first.accounts[0]).toMatchObject({
      name: 'Cold storage',
      type: 'crypto',
      currency: 'USD',
      balance: 340_001,
    });
    expect(first.holdings[0]).toMatchObject({ symbol: 'BTC', quantity: '0.05', price: '68000.1' });
    expect(first.activities.map((a) => [a.externalId, a.type, a.quantity])).toEqual([
      ['btctx2', 'transfer_out', '0.02'],
      ['btctx1', 'transfer_in', '0.07'],
    ]);
    const lots = store.taxLots;
    expect(lots.reduce((n, l) => n + Number(l.quantity), 0)).toBeCloseTo(0.05, 8);
    expect(lots[0]?.acquiredOn).toBe('2026-02-02');
  });

  it('EVM: native coin and priced ERC-20 tokens, failed transactions and unpriced spam skipped', async () => {
    const first = await onchainAdapter.sync(evmCtx(), makeConnection('onchain'));
    await expectSyncShape(first);
    expect(first.holdings.map((h) => [h.symbol, h.quantity, h.price])).toEqual([
      ['ETH', '1.5', '2450.25'],
      ['USDC', '250.5', '1'],
    ]);
    expect(first.accounts[0]?.balance).toBe(367_538 + 25_050);
    expect(first.activities.map((a) => [a.externalId, a.type, a.quantity])).toEqual([
      ['0xevmtx2', 'transfer_out', '0.1'],
      ['0xevmtx1', 'transfer_in', '1.6'],
    ]);
  });

  it('Solana, Polkadot and Cosmos balances', async () => {
    const sol = makeCtx(
      { ONCHAIN_CHAIN: 'solana', ONCHAIN_ADDRESS: 'SoLdemoAddress1111111111111111111111111111111' },
      fakeFetch({
        'POST api.mainnet-beta.solana.com/': { json: fixture('onchain', 'sol_balance.json') },
        [GECKO]: { json: fixture('onchain', 'gecko.json') },
      }),
    );
    expect((await onchainAdapter.sync(sol, makeConnection('onchain'))).accounts[0]?.balance).toBe(
      45_125,
    ); // 2.5 SOL x 180.50

    const dot = makeCtx(
      { ONCHAIN_CHAIN: 'polkadot', ONCHAIN_ADDRESS: '15demoPolkadotAddress' },
      fakeFetch({
        'GET polkadot-asset-hub-public-sidecar.parity-chains.parity.io/accounts/15demoPolkadotAddress/balance-info':
          { json: fixture('onchain', 'dot_balance.json') },
        [GECKO]: { json: fixture('onchain', 'gecko.json') },
      }),
    );
    const dotResult = await onchainAdapter.sync(dot, makeConnection('onchain'));
    expect(dotResult.holdings[0]?.quantity).toBe('12'); // free 10 + reserved 2
    expect(dotResult.accounts[0]?.balance).toBe(8_700);

    const cosmos = makeCtx(
      { ONCHAIN_CHAIN: 'cosmos', ONCHAIN_ADDRESS: 'cosmos1demoaddress' },
      fakeFetch({
        'GET cosmos-rest.publicnode.com/cosmos/bank/v1beta1/balances/cosmos1demoaddress/by_denom': {
          json: fixture('onchain', 'cosmos_bank.json'),
        },
        'GET cosmos-rest.publicnode.com/cosmos/staking/v1beta1/delegations/cosmos1demoaddress': {
          json: fixture('onchain', 'cosmos_delegations.json'),
        },
        'GET cosmos-rest.publicnode.com/cosmos/staking/v1beta1/delegators/cosmos1demoaddress/unbonding_delegations':
          { json: fixture('onchain', 'cosmos_unbonding.json') },
        [GECKO]: { json: fixture('onchain', 'gecko.json') },
      }),
    );
    const cosmosResult = await onchainAdapter.sync(cosmos, makeConnection('onchain'));
    expect(cosmosResult.holdings[0]?.quantity).toBe('16'); // 5 liquid + 10 delegated + 1 unbonding
    expect(cosmosResult.accounts[0]?.balance).toBe(14_560);
  });

  it('rejects an unknown chain and never asks for repair', async () => {
    const ctx = makeCtx({ ONCHAIN_CHAIN: 'dogechain', ONCHAIN_ADDRESS: 'x' }, fakeFetch({}));
    await expect(onchainAdapter.sync(ctx, makeConnection('onchain'))).rejects.toThrow(
      /unknown chain/,
    );
  });
});
