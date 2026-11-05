# @manaclaude/connectors

The connector registry, one adapter per provider, and the pure functions that turn a provider sync into database changes. Session D owns this folder. Nothing here touches a database or calls a real service: adapters get a `fetch` from the Worker, and every test runs against invented responses saved in `fixtures/`.

```
src/registry.ts        every connector: availability, cost, regions, data types, free slots, reasons
src/adapters/<id>/     one adapter per connector (implements ConnectorAdapter); index.ts lists them
src/sync/              pure planners: transactions, accounts, holdings, lots, activities; runConnectionSync
src/slots.ts           free-slot tracking and "which connector for a new login"
src/health.ts          health badge text, sync success/failure, the repair plan
src/overview.ts        describeConnectors(): one call for the Accounts screen
src/market/            market-data types and the Yahoo → Twelve Data → Tiingo → EODHD fallback
src/http.ts, kit.ts    the small HTTP client and helpers every adapter shares
fixtures/<id>/         saved sample responses (invented, shaped like each provider's documented replies)
test/                  Vitest; test/helpers has the fake fetch and the shared bank test suite
```

## How the backend uses it

```ts
import {
  getAdapter,
  runConnectionSync,
  planAccountSync,
  planTransactionSync,
  planInvestmentSync,
} from '@manaclaude/connectors';

const adapter = getAdapter(connection.connectorId);
// ctx.secrets = the connector's Worker secrets + this connection's own credentials (see the table below)
const outcome = await runConnectionSync(
  adapter,
  { secrets, fetch, now: () => new Date() },
  connection,
);
// outcome.connection is the updated Connection (status, lastSyncAt, lastError, syncCursor): save it.
if (outcome.result) {
  const accounts = planAccountSync({
    connectionId: connection.id,
    existing: allAccounts,
    result: outcome.result,
    now,
    newId,
  });
  const txns = planTransactionSync({
    connectionId: connection.id,
    accounts: accounts.accountIds,
    existing: rows,
    result: outcome.result,
    now,
    newId,
  });
  const inv = planInvestmentSync({
    connectionId: connection.id,
    accounts: accounts.accountIds,
    securities,
    holdings,
    taxLots,
    activities,
    result: outcome.result,
    now,
    newId,
  });
  // apply accounts, txns and inv in one D1 batch, then run the transfer matcher
}
if (outcome.result?.updatedSecrets) {
  // Questrade rotates its refresh token on every use: store these under the same names before the next sync.
}
```

- `runConnectionSync` never throws. An expired login becomes status `needs_repair` (and the next scheduled run skips it, so a dead token is not called again); anything else becomes `error` with a short message that never contains a provider payload.
- The planners return plain `inserts`, `updates` (only the changed fields), and `removals`. Removals say whether the row has user edits (`hadUserEdits`), so the backend can mark it excluded instead of deleting the user's work.
- `ctx.fetch` for Teller must be the fetch of the Worker's mTLS binding that holds the Teller client certificate. Trade Republic also needs `ctx.connectSocket`.

## Rules every adapter follows

- **Sign rule.** `amount` is negative when money leaves the account, positive when it arrives, for every account type including cards. Balances of cards and loans are what is owed, as a positive number. Each adapter header says how its provider signs things and what it flips.
- **Money** is integer minor units plus a currency code. Quantities and prices are exact decimal strings. No floats are stored.
- **Pending to posted.** Where the provider links the two (Plaid `pending_transaction_id`), the adapter sets `pendingExternalId`. Where it does not (Teller, SimpleFIN, Up, Akahu, Lunch Flow, Redbark, Enable Banking, Monobank), `planTransactionSync` matches a posted row to one pending row with the same amount and currency within 8 days before the posted date, preferring the same name. The row keeps its id and any user edits.
- **Dedupe.** By `(account, source, externalId)`. Two identical coffees with different provider ids stay two rows. Providers that give no id get one built from the row's content plus its occurrence number, so identical rows still stay separate and a repeat sync gives the same ids.
- **User edits.** Fields in `userEditedFields` are never overwritten. Category, notes, tags, kind and excluded are never touched by a sync at all (the provider's category label comes back as a hint in `categoryHints`, not as a category).
- **Lots.** If the broker sends lots (Plaid, IBKR Flex, Indexa), they are stored as `source: 'broker'`. Otherwise `planInvestmentSync` derives them with `deriveLotsFifo` from the buy and sell activities, then adds one "opening balance" lot for any units the history does not explain, at the broker's own cost basis, and keeps that lot's date from moving on later syncs.
- **Cursors** are small JSON strings in `Connection.syncCursor` (most hold `{"since":"YYYY-MM-DD"}`; Plaid also holds its sync cursor). Each sync re-reads a few days before the cursor, because pending rows change.
- **Repair, never delete.** An auth failure throws `ConnectorRepairNeededError`. Teller and Plaid Trial count every login for life, so `planRepair()` keeps the connection, its accounts and its cursor and never uses a new slot. `deletionImpact(id)` tells the app what a delete would cost.

## Secrets each adapter reads

"Worker" secrets belong to the app (one set for all logins). "Per login" values are saved with each connection when the user links the account, and the Worker puts them into `ctx.secrets` for that sync. Names in brackets are optional.

| Connector      | Worker secrets                                                    | Per login                                                                                                                   | Follows (Sure, `app/models/`)                                                                                                 |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| teller         |                                                                   | `TELLER_ACCESS_TOKEN`                                                                                                       | not in Sure; Teller's docs                                                                                                    |
| sophtron       | `SOPHTRON_USER_ID`, `SOPHTRON_ACCESS_KEY`                         | `SOPHTRON_USER_INSTITUTION_ID`, [`SOPHTRON_CARD_BALANCE_SIGN`]                                                              | `provider/sophtron.rb`, `sophtron_item/importer.rb`, `sophtron_account/processor.rb`, `sophtron_entry/processor.rb`           |
| plaid          | `PLAID_CLIENT_ID`, `PLAID_SECRET`, [`PLAID_ENV`]                  | `PLAID_ACCESS_TOKEN`                                                                                                        | `provider/plaid.rb`, `plaid_item/importer.rb`, `plaid_account/*` (processor, type_mappable, investments, liabilities)         |
| snaptrade      | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`                   | `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`, `SNAPTRADE_AUTHORIZATION_ID`                                                  | `provider/snaptrade.rb`, `snaptrade_account/{holdings,activities}_processor.rb`                                               |
| zerodha_kite   | `KITE_API_KEY`, `KITE_API_SECRET`                                 | `KITE_ACCESS_TOKEN` (new every morning)                                                                                     | not in Sure; Kite Connect v3 docs                                                                                             |
| coinbase       |                                                                   | `COINBASE_API_KEY`, `COINBASE_API_SECRET`                                                                                   | `provider/coinbase.rb`, `coinbase_account/{processor,holdings_processor}.rb`                                                  |
| wazirx         |                                                                   | `WAZIRX_API_KEY`, `WAZIRX_API_SECRET`                                                                                       | not in Sure; WazirX REST docs                                                                                                 |
| simplefin      |                                                                   | `SIMPLEFIN_ACCESS_URL`, [`SIMPLEFIN_CARD_BALANCE_SIGN`]                                                                     | `provider/simplefin.rb`, `simplefin_account/processor.rb`, `simplefin_entry/processor.rb`, `simplefin/account_type_mapper.rb` |
| lunch_flow     |                                                                   | `LUNCHFLOW_API_KEY`, [`LUNCHFLOW_BASE_URL`]                                                                                 | `provider/lunchflow.rb`, `lunchflow_account/*`, `lunchflow_entry/processor.rb`                                                |
| enable_banking | `ENABLEBANKING_APPLICATION_ID`, `ENABLEBANKING_PRIVATE_KEY` (PEM) | `ENABLEBANKING_SESSION_ID`                                                                                                  | `provider/enable_banking.rb`, `enable_banking_account/processor.rb`, `enable_banking_item/importer.rb`                        |
| wise           |                                                                   | `WISE_API_TOKEN`, [`WISE_SCA_PRIVATE_KEY`, `WISE_BASE_URL`]                                                                 | `provider/wise.rb`, `wise_account/*`                                                                                          |
| akahu          | `AKAHU_APP_TOKEN`                                                 | `AKAHU_USER_TOKEN`                                                                                                          | `provider/akahu.rb`, `akahu_entry/processor.rb`                                                                               |
| up             |                                                                   | `UP_ACCESS_TOKEN`                                                                                                           | `provider/up.rb`, `up_account/processor.rb`, `up_entry/processor.rb`                                                          |
| redbark        |                                                                   | `REDBARK_API_KEY`                                                                                                           | `provider/redbark.rb`, `redbark_account/*`                                                                                    |
| monobank       |                                                                   | `MONOBANK_TOKEN`                                                                                                            | `provider/monobank.rb`, `monobank_entry/processor.rb`                                                                         |
| fio            |                                                                   | `FIO_TOKEN`                                                                                                                 | `provider/fio.rb`, `fio_entry/processor.rb`                                                                                   |
| ibkr_flex      |                                                                   | `IBKR_FLEX_TOKEN`, `IBKR_FLEX_QUERY_ID`                                                                                     | `provider/ibkr_flex.rb`, `ibkr_item/report_parser.rb`, `ibkr_account/*`                                                       |
| trading212     |                                                                   | `T212_API_KEY`, `T212_API_SECRET`, [`T212_ENV`]                                                                             | `provider/trading212.rb`, `trading212_account/*`                                                                              |
| questrade      |                                                                   | `QUESTRADE_REFRESH_TOKEN` (rotates; read `updatedSecrets`)                                                                  | `provider/questrade.rb`, `questrade_account/*`                                                                                |
| trade_republic |                                                                   | `TRADEREPUBLIC_SESSION` (cookie)                                                                                            | `provider/trade_republic_{client,session,timeline_event,websocket}.rb`                                                        |
| indexa         |                                                                   | `INDEXA_API_TOKEN`                                                                                                          | `provider/indexa_capital.rb`, `indexa_capital_account/holdings_processor.rb`                                                  |
| kraken         |                                                                   | `KRAKEN_API_KEY`, `KRAKEN_API_SECRET`, [`KRAKEN_QUOTE`]                                                                     | `provider/kraken.rb`, `kraken_account/*`                                                                                      |
| binance        |                                                                   | `BINANCE_API_KEY`, `BINANCE_API_SECRET`, [`BINANCE_BASE_URL`]                                                               | `provider/binance.rb`, `binance_account/*`                                                                                    |
| coinspot       |                                                                   | `COINSPOT_API_KEY`, `COINSPOT_API_SECRET`                                                                                   | `provider/coinspot.rb`, `coinspot_account/*`                                                                                  |
| coinstats      |                                                                   | `COINSTATS_API_KEY`, `COINSTATS_PORTFOLIO_ID`, [`COINSTATS_CURRENCY`]                                                       | `provider/coinstats.rb`, `coinstats_account/holdings_processor.rb`                                                            |
| onchain        |                                                                   | `ONCHAIN_CHAIN`, `ONCHAIN_ADDRESS`, [`ONCHAIN_NAME`, `ONCHAIN_EVM_BASE_URL`, `ONCHAIN_EVM_SYMBOL`, per-chain URL overrides] | `onchain_wallet_adapter.rb` and `mempool_space`, `blockscout`, `solana_rpc`, `polkadot_sidecar`, `cosmos_rest` in `provider/` |
| rentcast       | `RENTCAST_API_KEY`                                                | `RENTCAST_ADDRESS`                                                                                                          | `provider/rentcast.rb`                                                                                                        |
| realie         | `REALIE_API_KEY`                                                  | `REALIE_ADDRESS`, `REALIE_STATE`, [`REALIE_CITY`, `REALIE_ZIP`]                                                             | `provider/realie.rb`                                                                                                          |
| yahoo_finance  |                                                                   |                                                                                                                             | `provider/yahoo_finance.rb`                                                                                                   |
| twelve_data    | `TWELVEDATA_API_KEY`                                              |                                                                                                                             | `provider/twelve_data.rb`                                                                                                     |
| tiingo         | `TIINGO_API_TOKEN`                                                |                                                                                                                             | `provider/tiingo.rb`                                                                                                          |
| eodhd          | `EODHD_API_KEY`                                                   |                                                                                                                             | `provider/eodhd.rb`                                                                                                           |

The sync planners follow `account/provider_import_adapter.rb` (find by provider id, pending to posted by id then by amount, claim an unlinked duplicate once, leave protected entries alone, holdings and trades).

Not adapters on purpose: manual vehicle values (you type them), Open Exchange Rates and Frankfurter (the backend's FX job fetches them). Listed as unavailable with reasons in the registry: Mercury, Brex, MX, Finicity (Mastercard Data Connect), Akoya, Apple FinanceKit, Zillow, VinAudit, Capital One direct, Public direct.

## What is not proven until real keys exist

Every adapter is tested against invented responses shaped from each provider's documented replies and from what Sure's code reads. The saved responses are not real ones, so these are the places a real key may need a small fix:

- **Teller**: that card purchases come back negative (the code and fixtures assume Teller signs money out as negative for every account type), the `enrollment.disconnected` error codes, and the mTLS fetch binding.
- **Sophtron**: the exact field names of the accounts and transaction replies (the adapter accepts the several spellings Sure accepts), and which banks report card balances the other way (`SOPHTRON_CARD_BALANCE_SIGN` flips it). Holdings are not read.
- **Plaid**: the `tax_lots` shape on holdings. Plaid's public docs describe holdings, securities and investment transactions; the adapter reads `tax_lots` tolerantly when the institution sends them and otherwise lets the shared sync derive lots.
- **SnapTrade**: Sure uses SnapTrade's OAuth beta; this adapter uses the documented key-and-signature API that Personal keys get (clientId, timestamp, HMAC signature). Check at sign-up which one your key supports. Stock splits arrive without a ratio, so the position falls back on the opening-balance lot.
- **Zerodha Kite**: nothing can be proven without a daily login. Kite gives no purchase dates, so each position is one opening lot at Zerodha's average price, dated the first day it was seen.
- **Coinbase**: the credit of staking rewards and transfers at market value as cost basis (Coinbase cannot know the original cost of coins that came from elsewhere).
- **WazirX**: whether the API is still open for new keys. The adapter is written from the REST docs and needs a real key and an account with trades.
- **Redbark**: the balances reply shape (read as `accountId` plus the first of `balance`, `currentBalance`, `current`, `amount`) is not publicly documented.
- **CoinStats**: the `portfolio/coins` and `portfolio/transactions` replies are read tolerantly (`result` or `data`, `count`, `coin.price`, `coinData`); check the free plan's limits.
- **Enable Banking**: consent length and the `date_to` rules differ by bank; cards are assumed to report the owed amount (taken as an absolute value).
- **Trade Republic**: unofficial, can break at any time, and needs a Worker that can open an outbound WebSocket. Trades come from the timeline's cash amounts without quantities, so lots are one opening lot per position.
- **Wise**: whether a personal US/UK account can create API tokens at all, and whether statements need the SCA key.
- **Trading 212** reads only the 500 newest orders per sync (history is rate limited at 6 requests a minute). **Monobank** reads the last 30 days only (one statement call a minute per account). **Fio** allows one request every 30 seconds per token.

## Adding a connector

1. Add the registry entry in `src/registry.ts` (cost, regions, data types, free slots, reason).
2. Write `src/adapters/<id>/index.ts` with `defineAdapter({ id, sync, probe })`; start the file with a comment naming the Sure files it follows and listing its secrets. Convert signs to the model's rule and turn auth failures into `ConnectorRepairNeededError` (the `HttpClient` already does for 401 and 403).
3. Register it in `src/adapters/index.ts`.
4. Save invented responses in `fixtures/<id>/` and write `test/<id>.test.ts`. For bank-style connectors, `describeBankSuite` in `test/helpers/bankSuite.ts` gives you the shared checks (shape, signs, repeat sync, two identical purchases, pending to posted, repair, health).

```bash
export PATH=/opt/node24/bin:$PATH
npm test -w @manaclaude/connectors     # connectors tests only
npm run check                          # typecheck, lint, format and every test
```
