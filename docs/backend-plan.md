# Backend plan

Session B owns this plan and `backend/`. It starts from a Worker skeleton that bundles with wrangler and answers `GET /health`. Everything below is the plan; adjust it as the build teaches you something, and keep this file current.

## Shape

- **Runtime:** one Cloudflare Worker (`backend/src/index.ts`), free plan. A small router (Hono is fine) under `/v1`.
- **Database:** D1 with SQL migrations in `backend/migrations/` (`wrangler d1 migrations apply`). Tables mirror the shared model: `accounts`, `balance_snapshots`, `transactions`, `transfer_links`, `categories`, `category_groups`, `tags`, `transaction_tags`, `merchants`, `rules`, `budgets`, `goals`, `recurring_items`, `securities`, `holdings`, `tax_lots`, `investment_activities`, `prices`, `receipts`, `fx_rates`, `connections`, `connector_slots`, `imports`, `settings`, `idempotency_keys`. Money columns are `INTEGER` minor units next to a `TEXT` currency column; quantities are `TEXT` decimals.
- **Key constraints:** unique `(account_id, source, external_id)` where `external_id` is not null; unique `(account_id, import_fingerprint)` where not null; unique `(out_transaction_id)` and `(in_transaction_id)` on active transfer links; unique `idempotency_keys(key)`.
- **Files:** R2 bucket `FILES` for receipt images and the statement vault (original PDFs and CSVs, never deleted by imports).
- **Crons:** hourly `0 * * * *` fetches Open Exchange Rates `latest.json` (USD base, app ID in the `OXR_APP_ID` secret); daily `30 6 * * *` fetches ECB rates from `api.frankfurter.dev` (fallback and history) and runs connector syncs.
- **AI provider layer:** Workers AI by default; Anthropic or OpenAI when their key is set as a Worker secret. `settings.aiEnabled = false` stops every AI call. Never a free tier that allows training on or human review of inputs.
- **MCP:** `/mcp`, Streamable HTTP with OAuth (`@cloudflare/workers-oauth-provider` and the MCP agent pattern). Read tools first; write tools behind `settings.mcpWriteToolsEnabled`. Setup steps for Claude and Perplexity in `docs/mcp.md`.
- **API for the app:** `GET /v1/dataset` returns a `FinanceDataset` so the app can swap sample data for real data without screen changes. Then small write endpoints (`POST /v1/transactions/:id/review`, `/split`, `/link`, `/unlink`, `/category`, `POST /v1/cash`, `POST /v1/imports`, `POST /v1/receipts`). Put request and response types in `packages/shared/src/api/`.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers` (compatible with the repo's Vitest 4.1) and a local D1 database per test file. Pure logic (reportTreatment, splits, lots, FX) already lives in `packages/shared` with its own tests; the backend tests cover persistence, idempotency and matching.

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

From `research/sure/rea.md`, "Suggested immediate build checks". The pure parts already pass in `packages/shared/test/policy.test.ts`; `backend/test/build-checks.test.ts` holds these cases as `it.todo` for B to implement against local D1. All amounts are invented.

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
