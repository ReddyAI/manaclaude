# Backend plan

Session B owns this file and `backend/`. It describes the Worker as built; keep it current.

## Shape

- **Runtime:** one Cloudflare Worker (`backend/src/index.ts`), free plan. `workers-oauth-provider` sits in front: `/mcp` needs an OAuth token, everything else goes to a Hono app (`backend/src/api/app.ts`). The bundle is about 610 KB gzipped (the free plan allows 3 MB).
- **Database:** D1, schema in `backend/migrations/0001_init.sql`, mapped to the shared model in `backend/src/db/tables.ts` (one line per field, snake_case columns). Money columns are `INTEGER` minor units next to a `TEXT` currency; quantities are `TEXT` decimals.
- **Key constraints:** unique `(account_id, source, external_id)` where `external_id` is set; unique `(account_id, import_fingerprint)` where set; unique `(out_transaction_id, in_transaction_id)` on transfer links (a rejected pair stays stored, so it is never proposed again); unique active link per side; `split_locks(parent_id)` and `idempotency_keys(key)` for splits; `imports.status` moves `preview` to `committing` to `committed` with a conditional update so a double commit can't run.
- **Files:** R2 bucket `FILES`. Receipts under `receipts/<yyyy-mm>/<id>`; the statement vault under `vault/<yyyy-mm>/<importId>/<file>` with the SHA-256 in `imports`. Imports never delete originals; undoing an import removes its rows and keeps the file.
- **Crons:** hourly `0 * * * *` fetches Open Exchange Rates `latest.json` (USD base, `OXR_APP_ID` secret; one row per pair per day, latest wins). Daily `30 6 * * *` fetches ECB rates from `api.frankfurter.dev`, backfills history back to the oldest transaction, syncs every connection, then runs the AI jobs (merchants, categorize, recurring, alerts, and recaps when a week or month just ended).
- **After every import or sync:** rules on the new rows, ATM withdrawals get their cash-side deposit and link, then the transfer matcher.
- **AI provider layer** (`backend/src/ai/provider.ts`): Workers AI by default (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` for text, `@cf/meta/llama-4-scout-17b-16e-instruct` for receipts, `toMarkdown` for PDFs), capped at `AI_DAILY_CALL_LIMIT` calls a day. Anthropic (official SDK, `claude-opus-5-5`, server-side fallbacks on, low effort, JSON schema output), OpenAI, OpenAI-compatible and paid Gemini when chosen in Settings and their key is a Worker secret. `settings.aiEnabled = false` makes `getAi()` throw before anything is sent; jobs then fall back to rules, learned corrections and templates.
- **MCP:** `/mcp`, stateless Streamable HTTP (no Durable Objects), OAuth with the owner password on the consent page. Read tools always; write tools only with `settings.mcpWriteToolsEnabled` and the `write` scope. Setup in [mcp.md](mcp.md).
- **Tests:** Vitest 4.1 with `@cloudflare/vitest-plugin` (the renamed `@cloudflare/vitest-pool-workers`), inside workerd with local D1, R2 and KV. Providers get saved responses from `backend/test/fixtures/` through injected `fetch` and AI fakes; nothing calls the network.

## API for the app

Every `/v1` request needs `Authorization: Bearer <APP_API_TOKEN>`; without the secret the API answers 503. Request and response types are in `packages/shared/src/api/`. Errors are `{ "error": code, "message": text }`.

| Method and path                                                                                                                                                | Purpose                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /health`                                                                                                                                                  | No token. Liveness and current policies                                      |
| `GET /v1/dataset`                                                                                                                                              | The whole `FinanceDataset`, the shape the app already renders                |
| `GET /v1/accounts`, `POST /v1/accounts/cash`                                                                                                                   | Accounts; create a cash account                                              |
| `GET /v1/transactions?from&to&accountId&categoryId&q&limit&offset`                                                                                             | List (split parents hidden)                                                  |
| `GET/PATCH /v1/transactions/:id`                                                                                                                               | Read; edit (each sent field joins `userEditedFields`)                        |
| `POST /v1/transactions/:id/review`, `/category`                                                                                                                | Review queue and quick category                                              |
| `POST/DELETE /v1/transactions/:id/split`                                                                                                                       | Split with `idempotencyKey`; undo                                            |
| `POST /v1/transactions/:id/link`, `/unlink`                                                                                                                    | Manual link and unlink                                                       |
| `GET /v1/transfer-links?status=suggested`, `POST /v1/transfer-links/:id/confirm`, `/reject`, `POST /v1/transfer-links/run`                                     | Suggestions and the matcher                                                  |
| `POST /v1/cash`                                                                                                                                                | Fast cash entry into the default cash account for the currency               |
| `GET/POST /v1/categories`, `PATCH /v1/categories/:id`                                                                                                          | Categories (defaults seeded on first read)                                   |
| `GET/POST /v1/rules`, `PUT/DELETE /v1/rules/:id`, `POST /v1/rules/run`                                                                                         | Rules; a new rule runs on existing rows unless `?apply=false`                |
| `POST /v1/imports` (multipart `file`, `accountId?`, `format?`, `mapping?`, `skipRows?`, `preferDayFirst?`, `commit?`)                                          | Preview any file; `commit=true` saves at once (not for PDFs)                 |
| `GET /v1/imports`, `GET /v1/imports/:id`, `POST /v1/imports/:id/commit`, `/discard`, `DELETE /v1/imports/:id/transactions`                                     | Preview, confirm, discard, undo                                              |
| `GET /v1/import-mappings`                                                                                                                                      | Saved CSV mappings by header signature                                       |
| `GET /v1/vault`, `GET /v1/vault/:id/file`                                                                                                                      | Statement vault and original files                                           |
| `POST /v1/receipts` (multipart `file`, `transactionId?`), `GET /v1/receipts?q&from&to`, `GET /v1/receipts/:id/image`, `POST /v1/receipts/:id/attach`, `/split` | Receipts                                                                     |
| `GET /v1/fx/latest?base&quote`, `GET /v1/fx/rates?from&to`, `POST /v1/fx/refresh`, `POST /v1/fx/backfill`                                                      | Rates with their timestamp                                                   |
| `GET/PATCH /v1/settings`                                                                                                                                       | Settings (partial patch; policies merge)                                     |
| `GET /v1/ai/status`, `POST /v1/ai/jobs/:job`, `POST /v1/ai/ask`                                                                                                | AI status, run a job, plain-English question                                 |
| `GET /v1/alerts`, `POST /v1/alerts/:id/dismiss`                                                                                                                | Duplicate, unusual-charge and price-increase alerts                          |
| `GET /v1/recaps?period=week                                                                                                                                    | month`, `GET /v1/recurring`                                                  | Recap text and numbers; recurring items |
| `GET /v1/connections`, `POST /v1/connections/:id/sync`                                                                                                         | Connector sync through session D's adapters                                  |
| `POST /v1/mcp/clients`                                                                                                                                         | Create a confidential OAuth client for an assistant that can't self-register |
| `POST /v1/dev/seed`                                                                                                                                            | Local only (`ALLOW_SAMPLE_SEED=true`): load the invented sample data         |

## Imports

Parsers are pure and live in `packages/shared/src/import/` (the app can use them for previews too): CSV with delimiter, header and column guessing, debit/credit columns, bank preambles (`skipRows`), Indian lakh grouping and `DD/MM` detection; QIF with `S/E/$` splits and `[Account]` transfers; OFX 1.x and 2.x with FITIDs; Sure NDJSON (`{"type","data"}` lines, outflows flipped to our sign); Actual Budget CSV with split rows; AI JSON for PDF statements with an opening + rows = closing check.

Every import is two steps. The preview stores the original in the vault, parses, finds the account (chosen, by mask, by name, or a new one the file names), and marks each row `new`, `already_imported` (same FITID or fingerprint) or `existing` (a synced or typed-in row with the same amount within 3 days). Commit writes the `new` rows; the unique indexes make a repeat or concurrent commit add nothing. CSV mappings are saved under the header signature and reused automatically.

## Cloudflare setup

Setup is done once through GitHub secrets and the "Deploy to Cloudflare" workflow; the steps are in [setup.md](setup.md). The workflow needs only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. It creates or reuses the D1 database, the R2 bucket and the OAuth KV namespace by name, applies the migrations, uploads the Teller certificate when its two PEM secrets exist, finds the Worker's public URL, deploys the Worker and the web app, and copies the optional secrets into Worker secrets of the same name. The code is in `backend/deploy/` and its tests in `backend/deploy/test/`.

Worker secrets used by the code: `APP_API_TOKEN`, `MCP_OWNER_PASSWORD`, `CREDENTIALS_SECRET` (encrypts saved logins), `OXR_APP_ID`, `TELLER_APPLICATION_ID`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY`, `SOPHTRON_USER_ID`, `SOPHTRON_ACCESS_KEY`, `KITE_API_KEY`, `KITE_API_SECRET`, `ANTHROPIC_API_KEY`. Which connector reads which name is in `backend/src/sync/secrets.ts` and `connectors/README.md`. Per-login credentials (access tokens and the like) are stored encrypted in the `connection_credentials` table (`backend/src/sync/credentials.ts`).

Local development needs none of this: copy `backend/.dev.vars.example` to `backend/.dev.vars`, fill in a token and password, and run `npm run dev -w @manaclaude/backend` (local D1, R2 and KV; Workers AI calls answer 503 `ai_unavailable` because Workers AI only runs on Cloudflare). `npm run dev:remote-ai -w @manaclaude/backend` uses real Workers AI after `wrangler login`.

## For the other sessions

- **A:** read with `GET /v1/dataset`; write with the endpoints above. Linked pairs are `TransferLink` rows with status `auto` or `confirmed`; suggestions are `suggested` and don't set `transferLinkId` on the transactions until confirmed. Review queue: `aiCategoryConfidence` is set by the categorizer (0.95 for learned corrections). Receipts: upload, then `match` or `candidates` in the response; "Split by items" is `POST /v1/receipts/:id/split`.
- **C:** recaps are your `Recap` model (`packages/shared/src/model/recap.ts`, copied byte for byte from your branch so the two merge cleanly) with `source: 'ai'` when the AI wrote `headline` and `highlights`, `'local'` when AI is off. `GET /v1/recaps?kind=weekly|monthly`. Weekly recaps cover the last complete calendar week (starting on `weekStartsOn`); monthly ones the last complete month. Once your optional `FinanceDataset.recaps` lands, `/v1/dataset` can fill it. Conversion: `convertAmount`/`findRate` are unchanged; `convertWithPolicy` in `packages/shared/src/fx/providers.ts` adds the linked-transfer rate. `GET /v1/fx/latest` gives the rate and its timestamp for the currency chip.
- **D:** `backend/src/sync/plan.ts` is a stand-in for your `planTransactionSync` with the same input (`connectionId`, `accounts` map, `existing`, `result`, `now`) and the same output (`inserts`, `updates` as `{ id, changes, reason }`, `removals` with `hadUserEdits`, `categoryHints` keyed by provider id). `applySyncResult` maps hints to categories only when the category is empty and not user-edited, keeps removed rows that had user edits (marked excluded), then runs rules, ATM cash and the matcher. When your code is on main, swap the `planSync(...)` call for yours. Adapters get secrets named `<CONNECTOR_ID>_<NAME>` from `connectorSecrets()` in `backend/src/sync/run.ts`.
- **A:** `Receipt.localUri` from your branch is fine: `POST /v1/receipts` returns the receipt with its real `r2Key`.
- **Shared policy change:** `reportTreatment` now honours `count` for linked pairs: with, say, `investmentContributions: 'count'`, the outgoing side of a linked contribution counts as spending and the receiving side stays out. Defaults are unchanged.

## Policies the tests assume

The defaults in `DEFAULT_MONEY_POLICIES` (`packages/shared/src/model/settings.ts`), from the brief:

| Policy                                 | Default                                                     |
| -------------------------------------- | ----------------------------------------------------------- |
| Transfers between own accounts         | not spending or income                                      |
| Credit card payments                   | not spending (the card purchases already count)             |
| Brokerage and retirement contributions | not spending                                                |
| Loan payments                          | principal excluded, interest is spending                    |
| Refunds                                | reduce their category in the month they post; no zero floor |
| Pending transactions                   | counted until they post                                     |
| Money                                  | integer minor units plus currency                           |

## The five build checks as test cases

From `research/sure/rea.md`, "Suggested immediate build checks". The pure parts pass in `packages/shared/test/policy.test.ts`; every case below is a passing test against local D1 in `backend/test/build-checks.test.ts` (test names start with the case number). All amounts are invented.

### Check 1: no double counting of transfers and card payments

| #   | Given                                                                                                                                           | When                                            | Then                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1.1 | Card purchase -$200.00 (Shopping) on Oct 3; checking -$200.00 "LAKESHORE CARD PAYMENT" on Oct 25; card +$200.00 "PAYMENT - THANK YOU" on Oct 25 | Matcher runs, then October spending is computed | One `card_payment` link (status `auto`); October spending is $200.00, all in Shopping; income is $0               |
| 1.2 | Checking -$1,000.00 Nov 3, savings +$1,000.00 Nov 4                                                                                             | Matcher runs                                    | One `transfer` link; neither row appears in spending or income                                                    |
| 1.3 | Checking -USD 2,000.00 "WISE US INC" Oct 15; NRE +INR 1,76,240.00 Oct 17                                                                        | Matcher runs with Oct 15 rate 88.0              | Linked (within 2% after FX, within 5 days); `impliedRate` 88.12 stored; both amounts kept; excluded from spending |
| 1.4 | Checking -$200.00 "ATM WITHDRAWAL"; cash USD +$200.00 same day                                                                                  | Matcher runs                                    | One `atm_withdrawal` link; later cash purchases count as spending                                                 |
| 1.5 | Two candidate savings deposits of +$500.00 within 5 days of one -$500.00                                                                        | Matcher runs                                    | Links are `suggested`, not `auto`; both sides still count until one is confirmed                                  |
| 1.6 | A link the user rejected                                                                                                                        | Matcher runs twice more                         | No new link for that pair; no transaction ever has two active links                                               |

### Check 2: repeat imports are idempotent, real duplicates are kept

| #   | Given                                                                        | When           | Then                                                               |
| --- | ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| 2.1 | CSV with two rows: Nov 1, "STARBUCKS STORE 04412", -5.75 (twice)             | Imported       | Two transactions, fingerprints with occurrence 1 and 2             |
| 2.2 | The same CSV                                                                 | Imported again | Zero new rows; the import reports 2 matched, 0 added               |
| 2.3 | Same date and amount in checking and in the card                             | Imported       | Not merged across accounts                                         |
| 2.4 | Provider sends `externalId` T1 that already exists                           | Sync           | Row updated in place, no insert                                    |
| 2.5 | Pending P1 -$18.47, then posted T2 -$21.47 (tip) with `pendingExternalId` P1 | Sync           | One transaction remains, posted, amount -$21.47, same id as before |

### Check 3: splits balance exactly, write atomically and undo cleanly

| #   | Given                                          | When                                                               | Then                                                                                        |
| --- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 3.1 | -$100.00 Shopping                              | Split into -$60.00 Shopping and -$40.00 Restaurants                | Parent `isSplitParent`; two children; spending $100.00 total, $60.00 and $40.00 by category |
| 3.2 | -$100.00                                       | Split into -$60.00 and -$50.00                                     | 400 error; nothing written                                                                  |
| 3.3 | -$100.00                                       | Two identical split requests with the same idempotency key at once | Exactly two children exist                                                                  |
| 3.4 | A split transaction                            | Undo                                                               | Children deleted and parent restored in one D1 batch; spending back to $100.00 in Shopping  |
| 3.5 | Pending, linked-transfer or already-split rows | Split requested                                                    | Rejected                                                                                    |

### Check 4: user edits survive later syncs

| #   | Given                                                     | When                                   | Then                                                        |
| --- | --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| 4.1 | Synced transaction, AI category Shopping; user sets Gifts | Next sync sends category hint Shopping | Category stays Gifts; `categoryId` is in `userEditedFields` |
| 4.2 | User renamed "SQ *GREENLEAF" to "Greenleaf Florist"       | Next sync sends a new amount           | Name stays; amount updates (not user-edited)                |
| 4.3 | A rule and an AI job both want to change an edited field  | They run                               | The edited field is untouched                               |

### Check 5: refund and investment-contribution policies are explicit

| #   | Given                                                                    | When                   | Then                                                                          |
| --- | ------------------------------------------------------------------------ | ---------------------- | ----------------------------------------------------------------------------- |
| 5.1 | -$100.00 and +$30.00 refund, both Shopping, same month                   | Monthly spending       | Shopping $70.00                                                               |
| 5.2 | Purchase in October, +$24.50 refund in November, Shopping                | November spending      | November Shopping is reduced by $24.50 and can be negative; October unchanged |
| 5.3 | Checking -$500.00 to brokerage, linked                                   | Spending with defaults | $0 counted; with `investmentContributions: 'count'` it is $500.00             |
| 5.4 | -$452.18 loan payment split into principal -$389.40 and interest -$62.78 | Spending               | $62.78 (Loan interest); principal excluded                                    |
| 5.5 | Policies changed in Settings                                             | Spending recomputed    | Totals follow the new policy; each policy value has a test                    |
