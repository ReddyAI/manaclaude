# Parallel build sessions

The foundation (shared model, design system, app shell with sample data, backend and connector skeletons, CI) is on main. Four sessions build on it at the same time. Each one edits only its own folders (see the table in [CLAUDE.md](../CLAUDE.md)), so their pull requests don't collide.

Paste one prompt per session. Each prompt is plain text and stands on its own.

Boundaries between sessions:

- A and C read data through the app store (`useFinance`) and keep working on sample data until B's API exists.
- B owns persistence, imports, transfer matching, FX, AI and MCP. B calls D's pure sync functions to apply connector results to D1.
- C owns how amounts are shown in USD, INR, both or native (`useMoneyDisplay`, `Amount`); A owns the chip that switches the mode. Both use B's conversion helper in `packages/shared/src/fx/convert.ts` (a working version is already there; B keeps its signatures).
- D owns adapters, the registry, slot tracking, sync health, the repair flow and the pure merge logic in `connectors/src/sync/`. A shows connector status on the Accounts screen.

## Session A: Dashboard, Transactions, Accounts

```text
You are build session A for my personal finance app in the repo ReddyAI/manaclaude. Four build sessions (A, B, C, D) run at the same time on top of a finished foundation on main. I don't code: you write and test everything. Don't stop to ask me questions; pick sensible defaults and list them at the end. Use only free tools and services.

Start by reading CLAUDE.md, docs/project-brief.md and docs/requirements-addendum.md, then docs/data-model.md and docs/design-system.md. Look at the existing screens in apps/mobile/src/features/ before changing anything.

Build only the addendum items tagged A, plus these: the Dashboard, Transactions (including transaction review) and Accounts screens, the currency chip and the cash quick-add. In detail:
1. Currency chip in the header of every main screen: tap cycles USD, INR, Both, Native; long-press shows the current rate and when it was fetched. The chip exists in features/currency/CurrencyChip.tsx; finish and polish it. In Both mode totals show the main currency large with the other underneath (the Amount component already does this; C owns it).
2. Linked transfers as one row with a link icon and a label like "Everyday Checking to High-Yield Savings"; tapping shows both sides; manual link and unlink.
3. Transaction detail: attach a receipt from the camera, the gallery or the Android share sheet into the app; show the thumbnail and line items; a "Split by items" action that uses validateSplit and buildSplitChildren from @manaclaude/shared.
4. Review queue with the AI confidence on each transaction, lowest confidence first. Swipe right marks reviewed (haptic confirm), swipe left skips. Use react-native-gesture-handler's ReanimatedSwipeable and FlashList.
5. Cash quick-add: a + button that opens a number pad first, then the category; defaults to the cash account in the current display currency (USD or INR).
6. Accounts screen: every connector with status and free slots left; unavailable connectors greyed out with their reason (data comes from @manaclaude/connectors/registry, which session D maintains).
7. Dashboard in two layouts behind a setting: widget grid, and one safe-to-spend number with a spending chart.

You may edit: apps/mobile/src/features/dashboard/, apps/mobile/src/features/transactions/, apps/mobile/src/features/accounts/, apps/mobile/src/features/currency/CurrencyChip.tsx, apps/mobile/src/features/settings/sections/DisplaySection.tsx, new route files under apps/mobile/src/app/transactions/, apps/mobile/src/app/accounts/ and apps/mobile/src/app/dashboard/, and packages/shared/src/sample/transactions.ts. Shared folders (packages/shared/src/model, apps/mobile/src/design, apps/mobile/src/data) only through small additive changes as CLAUDE.md describes. Never edit research/. The repo is public: no secrets, API keys, personal data or real account details; sample data stays invented.

Data: keep using the sample data store. Write changes through updateFinance in your own features/transactions/actions.ts. Receipt images stay on the device for now with a Receipt record whose r2Key is a placeholder; session B adds the upload. Add native modules with "EXPO_OFFLINE=1 npx expo install <package>" from apps/mobile so versions match Expo SDK 58. Every colour and size comes from the theme; ESLint fails otherwise.

How to test: in the cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11). Add Jest tests under __tests__ for the review queue order, swipe actions, cash quick-add, link and unlink, and split by items. Build the web app with "EXPO_OFFLINE=1 npx expo export --platform web --output-dir dist" and check every screen you touched in a browser with Playwright at 412 px and 1440 px wide in the Midnight, Warm and Compact looks, light and dark. "npm run check" must pass, and the Android APK workflow on your pull request must stay green.

Work on your own branch, push it early and after every commit, rebase on main before you open the pull request (if package-lock.json conflicts, take main's copy and run npm install), and open a pull request to main. In it list what you built, the defaults you picked, and anything another session needs to know.
```

## Session B: Backend, imports, rules, transfers, receipts, FX, AI, MCP

```text
You are build session B for my personal finance app in the repo ReddyAI/manaclaude. Four build sessions (A, B, C, D) run at the same time on top of a finished foundation on main. I don't code: you write and test everything. Don't stop to ask me questions; pick sensible defaults and list them at the end. Use only free tools and services. I don't have a Cloudflare account yet, so everything runs and is tested locally.

Start by reading CLAUDE.md, docs/project-brief.md and docs/requirements-addendum.md, then docs/data-model.md, docs/backend-plan.md and research/sure/rea.md. research/ is read-only.

Build only the addendum items tagged B, plus these: the Cloudflare Worker and D1 backend, its API for the app, all file imports (CSV with saved mappings and date-format detection, PDF statements with AI extraction and a preview and confirm step, QIF with splits, OFX, Sure NDJSON, Actual Budget CSV, and a statement vault in R2), categories, rules, splits, transfer matching, cash accounts and ATM withdrawals, receipts (R2 storage, Workers AI vision extraction, matching to transactions), FX rates (hourly Open Exchange Rates, daily ECB through Frankfurter, the conversion helper), the AI provider layer with one switch that stops every AI call, the AI jobs, and the remote MCP server at /mcp with OAuth, read tools first and write tools off by default. Write the MCP setup steps for Claude and Perplexity in docs/mcp.md.

The five build checks from research/sure/rea.md are written out as test cases in docs/backend-plan.md and as it.todo entries in backend/test/build-checks.test.ts. Turn every one into a passing test against a local D1 database, using the default money policies in the brief. The pure parts already pass in packages/shared/test/policy.test.ts; reuse reportTreatment, summarizeSpending, validateSplit and buildSplitChildren from @manaclaude/shared instead of writing new versions.

Connector sync: session D writes pure functions in connectors/src/sync/ that turn a provider SyncResult plus existing rows into inserts, updates and removals (dedupe by provider id, pending to posted, never touching userEditedFields). Your backend applies those decisions to D1 and runs the transfer matcher afterwards. Until D's functions land, code against the ConnectorAdapter and SyncResult types in packages/shared/src/model/connector.ts.

You may edit: backend/, packages/shared/src/fx/, packages/shared/src/policy/, and new folders packages/shared/src/api/ (request and response types the app will use) and packages/shared/src/import/ (pure parsers), apps/mobile/src/features/settings/sections/AiSection.tsx and MoneyPoliciesSection.tsx, docs/backend-plan.md, docs/mcp.md, and a new .github/workflows/deploy-worker.yml that only runs when a CLOUDFLARE_API_TOKEN secret exists. Keep the exported signatures in packages/shared/src/fx/convert.ts stable; sessions A and C use them. The shared model changes only through small additive edits. Never edit research/. The repo is public: no secrets, API keys, personal data or real account details. Secrets go in Worker secrets; list their names in backend/.dev.vars.example with empty values.

How to test: in the cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11). Use @cloudflare/vitest-pool-workers with a local D1 database and the repo's Vitest 4.1. Put invented sample files for every import format under backend/test/fixtures/ and saved responses for Open Exchange Rates, Frankfurter, Workers AI and Anthropic so tests never call the network. Check that "npx wrangler deploy --dry-run" bundles the Worker and that "npx wrangler dev" answers the API locally. Exercise the MCP server with the MCP Inspector or a small test client. "npm run check" must pass.

Work on your own branch, push it early and after every commit, rebase on main before you open the pull request (if package-lock.json conflicts, take main's copy and run npm install), and open a pull request to main. In it list what you built, the defaults you picked, the Cloudflare setup steps I'll need once I have an account, and anything another session needs to know.
```

## Session C: Budgets, recurring, net worth, investments, planning, recaps, USD/INR

```text
You are build session C for my personal finance app in the repo ReddyAI/manaclaude. Four build sessions (A, B, C, D) run at the same time on top of a finished foundation on main. I don't code: you write and test everything. Don't stop to ask me questions; pick sensible defaults and list them at the end. Use only free tools and services.

Start by reading CLAUDE.md, docs/project-brief.md and docs/requirements-addendum.md, then docs/data-model.md and docs/design-system.md. Look at the existing Budgets, Recurring and Net worth screens in apps/mobile/src/features/ before changing anything.

Build only the addendum items tagged C, plus these: Budgets and the Spending Plan, recurring payments and subscriptions, net worth and investments with lots and planning, recaps, and the USD/INR display logic. In detail:
1. Category budgets per month with rollover, editable in the app; Flex mode (fixed, flexible, non-monthly) as an option; a Spending Plan view (income minus bills and savings leaves what you can spend).
2. Recurring and subscriptions: upcoming bills, keep, cancel or review decisions, price-increase alerts.
3. Investments: per-lot table (acquired date, quantity, cost basis, gain or loss, short or long term), position cost basis and unrealized gain, realized gains from sells (FIFO by default), dividends, allocation, stock splits, and a benchmark against the S&P 500. Lots come from the broker when provided and are otherwise derived from buy and sell activities with deriveLotsFifo in packages/shared/src/investments/lots.ts, which you own and session D calls.
4. Planning: retirement and FIRE projection with adjustable return, inflation, contributions and target; goals with progress bars.
5. Weekly recap and Month in Review screens. Session B builds the recap job; until it exists, add a Recap type to the shared model (small additive change) and build recaps from the sample data.
6. Every chart and total follows the display currency mode through useMoneyDisplay and Amount, which you own. Use the conversion helper in packages/shared/src/fx/convert.ts (session B owns it and keeps its signatures). Balances and net worth use the latest rate; spending uses the rate on each transaction's date; a linked cross-currency transfer uses its own rate.

You may edit: apps/mobile/src/features/budgets/, recurring/, networth/, and new folders planning/ and recaps/ under apps/mobile/src/features/, apps/mobile/src/features/currency/useMoneyDisplay.ts and Amount.tsx, apps/mobile/src/features/settings/sections/BudgetsSection.tsx, new route files under apps/mobile/src/app/budgets/, recurring/, networth/, planning/ and recaps/, packages/shared/src/investments/, and packages/shared/src/sample/budgets.ts, recurring.ts and investments.ts. Shared folders (packages/shared/src/model, apps/mobile/src/design, apps/mobile/src/data) only through small additive changes as CLAUDE.md describes. Never edit research/. The repo is public: no secrets, API keys, personal data or real account details; sample data stays invented. Every colour and size comes from the theme; ESLint fails otherwise.

How to test: in the cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11). Add Vitest tests in packages/shared/test/ for lot derivation (FIFO, splits, partial sells, dividends, short and long term), realized gains, rollover and the FIRE projection, and Jest tests under __tests__ for the screens and the display-currency modes. Build the web app with "EXPO_OFFLINE=1 npx expo export --platform web --output-dir dist" and check every screen you touched in a browser with Playwright at 412 px and 1440 px wide in the Midnight, Warm and Compact looks, light and dark. "npm run check" must pass, and the Android APK workflow on your pull request must stay green.

Work on your own branch, push it early and after every commit, rebase on main before you open the pull request (if package-lock.json conflicts, take main's copy and run npm install), and open a pull request to main. In it list what you built, the defaults you picked, and anything another session needs to know.
```

## Session D: Connectors

```text
You are build session D for my personal finance app in the repo ReddyAI/manaclaude. Four build sessions (A, B, C, D) run at the same time on top of a finished foundation on main. I don't code: you write and test everything. Don't stop to ask me questions; pick sensible defaults and list them at the end. Use only free tools and services. I don't have developer keys for any connector yet.

Start by reading CLAUDE.md, docs/project-brief.md and docs/requirements-addendum.md, then docs/data-model.md, especially the connector section, and packages/shared/src/model/connector.ts (the ConnectorAdapter interface and the normalized SyncResult shapes). research/ is read-only.

Build only the addendum items tagged D, plus this: every connector from the addendum, porting logic from Sure's open-source adapters, with sync, dedupe, slot tracking and the repair flow, tested with saved sample API responses until I have developer keys. In detail:
1. Read Sure's provider adapters (github.com/we-promise/sure, AGPL-3.0, under app/models/provider and the matching *_item and *_account models). Attach it read-only with the add_repo tool, or clone it into a scratch folder outside this repo. Port the logic to TypeScript: account mapping, pending-to-posted handling, dedupe, credit card balance signs, holdings and cost basis, reconnect and repair flows, sync health. Don't copy Sure's files into this repo; write our own code and note which Sure file each adapter follows.
2. One adapter per connector under connectors/src/adapters/<id>/, each implementing ConnectorAdapter, registered in connectors/src/adapters/index.ts. Build Teller, Sophtron (user ID plus access key, HMAC-signed requests), Plaid (Transactions, Liabilities, Investments including tax_lots), SnapTrade Personal (positions, balances, activities; derive lots with deriveLotsFifo from @manaclaude/shared), Zerodha Kite Connect Personal, Coinbase and WazirX first, then every other personal connector in the addendum, then market data (Yahoo Finance first, then Twelve Data, Tiingo, EODHD; NSE and BSE). Amounts must follow the model's sign rule: negative means money left the account.
3. Pure sync functions in connectors/src/sync/ that take a SyncResult and the existing rows and return inserts, updates and removals: dedupe by provider id, pending to posted through pendingExternalId, never overwriting fields in userEditedFields, and holdings and lots updates. Session B's backend applies these to D1, so keep them free of database code.
4. Slot tracking (free slots per connector, lifetime caps never give a slot back), connection health and the repair flow (ConnectorRepairNeededError, status needs_repair, repair instead of delete). Keep connectors/src/registry.ts current: availability, cost, regions, data types, free slots, and the unavailable connectors with their reasons. Session A shows this on the Accounts screen.

You may edit: connectors/ (src, adapters, sync, fixtures, tests) and packages/shared/src/sample/accounts.ts (sample connections). The shared model in packages/shared/src/model/connector.ts changes only through small additive edits. Never edit research/. The repo is public: no secrets, API keys, tokens, personal data or real account details. Fixtures are invented and shaped like each provider's documented responses; never save a response from a real account. Credentials come from ConnectorContext.secrets, which the Worker fills from its secrets; list the secret names each adapter needs in connectors/README.md.

How to test: in the cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11). Every adapter gets Vitest tests in connectors/test/ that run against its saved responses in connectors/fixtures/<id>/ through a fake fetch, covering sign conversion, pagination or cursors, pending to posted, dedupe on a repeated sync, a token-expired response that leads to needs_repair, and holdings and lots where the provider has them. The sync functions get their own tests, including "a user-edited category survives the next sync" and "two identical real purchases are both kept". "npm run check" must pass.

Work on your own branch, push it early and after every commit, rebase on main before you open the pull request (if package-lock.json conflicts, take main's copy and run npm install), and open a pull request to main. In it list what you built, the defaults you picked, which connectors still need real keys to finish, and anything another session needs to know.
```
