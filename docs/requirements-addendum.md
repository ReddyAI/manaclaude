Requirements addendum (November 4, 2026)
Paste this into every running session. Each session builds only the items tagged with its own letter (A, B, C or D). New shared types go into the shared model as small additive changes; if another session already added a type, reuse it instead of adding a second one. Save this file in the repo as docs/requirements-addendum.md and link it from CLAUDE.md. If the foundation session hasn't finished yet, it builds the "Shared model" and "Look switch" sections first.
Shared model additions (whichever session gets here first)

* Account: type adds "cash"; every account has a currency (ISO code).
* Transaction: always store originalAmount and originalCurrency; add transferLinkId (nullable), receiptId (nullable), aiCategoryConfidence (0 to 1), reviewed (boolean).
* TransferLink: id, outTransactionId, inTransactionId, outAmount, outCurrency, inAmount, inCurrency, impliedRate, status (auto, confirmed, rejected).
* TaxLot: holdingId, acquiredOn, quantity, costBasis, currency, source (broker or derived).
* Receipt: id, r2Key, merchant, date, total, currency, lineItems[], matchedTransactionId, status.
* FxRate: base, quote, rate, asOf, source.
* Settings: displayCurrencyMode ("USD", "INR", "BOTH", "NATIVE"), aiEnabled, aiProvider, look ("midnight", "warm", "compact").
* ConnectorDefinition: id, name, kinds[], availability ("available", "paid", "unavailable"), reason, freeSlotsTotal, freeSlotsUsed.

Look switch (foundation, or A if foundation is done)

* Every component reads colors, font sizes, spacing/density, corner radius, animation durations and haptic strength from the active theme. No hard-coded colors or sizes in screens. Use react-native-unistyles 3 for runtime theme switching (CSS variables on web) unless the existing setup already does this another way.
* Three looks, each with light and dark: Midnight (Copilot-inspired: near-black navy #000814 canvas, text at 90% white, large display numbers, charts as the main surface, green income / red spending / blue net worth / yellow pending), Warm (Monarch-inspired: warmer palette, card widgets), Compact (Lunch Money-inspired: short rows, smaller type, spreadsheet-style transactions table on wide screens with resizable columns and bulk-select totals).
* Font: Inter with tabular figures for every money amount.
* One haptics helper. Android: expo-haptics performAndroidHapticsAsync (Confirm when a transaction is reviewed, Segment_Tick while scrubbing a chart, Toggle_On/Toggle_Off on switches, Reject on errors). iOS: impactAsync/selectionAsync. Haptics on/off in Settings.
* Reanimated and Gesture Handler for motion and swipes (swipe right = reviewed, swipe left = skip). FlashList for long lists.
* Don't copy any app's logo, icons, illustrations or brand names.

A: Dashboard, Transactions, Accounts

* Currency chip in the header of every main screen: tap cycles USD, INR, Both, Native; long-press shows the current rate and when it was fetched. In Both mode, totals show the main currency large with the other currency underneath.
* Linked transfers appear as one row with a link icon and a label like "Chase Checking to Ally Savings". Tapping it shows both sides. Manual link and unlink.
* Transaction detail: attach a receipt (camera, gallery, or Android share sheet into the app), show the thumbnail and line items, and a "Split by items" action.
* Review queue shows the AI's confidence on each transaction and lists low-confidence ones first.
* Cash quick-add: a + button that opens a number pad first, then category; defaults to the cash account in the current display currency.
* Accounts screen: every connector with status and free slots left; unavailable connectors greyed out with their reason.
* Dashboard in two layouts behind a setting: widget grid (Monarch-style) and one safe-to-spend number with a spending chart.

B: Backend, import, categories, rules, splits, transfers

* Read research/sure/rea.md first. Turn its five "Suggested immediate build checks" into automated tests: no double counting of transfers and card payments; repeat imports are idempotent but two identical real purchases are both kept; splits balance exactly, write atomically and undo cleanly; user edits survive later syncs; refund and investment-contribution policies are explicit.
* Default policies (Sankar can change them in Settings later): credit card payments, transfers between own accounts, and contributions to brokerage/retirement accounts are transfers, not spending. Loan payments: principal is a transfer, interest is spending. Refunds reduce spending in their category in the month they post, and a category can show a net credit (no zero floor). Money is stored as integer minor units plus currency code.
* Transfer matching after every sync or import: pair transactions between Sankar's own accounts with opposite signs, equal amounts (within 2% after FX conversion for cross-currency pairs such as USD to NRE), dates within 5 days, preferring memos with transfer, payment, Zelle, ACH, Wise or Remitly. Credit card payments pair the checking debit with the card credit. Auto-link when there's exactly one candidate; queue for confirmation when there are several. Linked pairs are excluded from spending and income everywhere. Matching is idempotent: re-running it never double-links.
* Cash accounts; ATM withdrawals become transfers into the cash account.
* Receipts: store images in R2. Extract merchant, date, total, currency and line items with a Workers AI vision model (@cf/meta/llama-3.2-11b-vision-instruct or newer). Match to a transaction by amount (exact, or within a tip range for restaurants), date within 3 days, and merchant similarity.
* PDF statement import with AI extraction (for NRE and NRO statements), with a preview and confirm step before anything is saved, reconciled against transactions that already exist. Keep the original files in a statement vault (R2).
* Other file imports (Sure has all of these): CSV with saved column mappings and date-format detection, QIF with splits, OFX, Sure NDJSON, Actual Budget CSV.
* FX rates: hourly Cron fetch from Open Exchange Rates latest.json (USD base; app ID in a Worker secret). Daily ECB rates from api.frankfurter.dev as fallback and to backfill history. Store everything in D1. Conversion helper: balances and net worth use the latest rate; spending reports use the rate on each transaction's date; a linked cross-currency transfer uses its own implied rate.
* AI provider layer: default Workers AI; optional Anthropic or OpenAI API key from Worker secrets. Never use a free tier whose terms allow training on or human review of inputs. aiEnabled=false stops every AI call.
* AI jobs: categorization with a confidence score that learns from corrections (store corrections as rules or examples), merchant name cleanup, recurring detection with price-change alerts, duplicate and unusual charge alerts, weekly and monthly recap text.
* Remote MCP server at /mcp on the Worker: Streamable HTTP with OAuth (Cloudflare's workers-oauth-provider and MCP agent pattern). Read tools: list_accounts, search_transactions, spending_summary, budget_status, holdings_with_lots, net_worth_history, list_recurring, search_receipts. Write tools, off by default and in a separate group: categorize_transaction, add_cash_transaction, tag_transaction, link_transfer. Must work as a custom connector in Claude (Pro) and Perplexity (Pro). Write setup steps for each in docs/mcp.md.

C: Budgets, recurring, net worth, investments, recaps, USD/INR

* Category budgets per month with rollover. Flex mode (fixed, flexible, non-monthly) as an option later.
* Investments: per-lot table (acquired date, quantity, cost basis, gain or loss, short or long term), position cost basis and unrealized gain, realized gains from sells (FIFO by default), dividends, allocation, and a benchmark against the S&P 500. Lots come from the broker when provided (Plaid tax_lots) and are otherwise derived from BUY/SELL activities (SnapTrade).
* Planning: retirement / FIRE projection with adjustable return, inflation, contributions and target; goals with progress bars. Monte Carlo later.
* All charts and totals follow displayCurrencyMode using B's conversion helper.
* Weekly recap and Month in Review screens fed by B's recap job.

D: Connectors
Rule: personal accounts only. Sankar can't open business accounts, so connectors that need one are listed as unavailable.
Sure (github.com/we-promise/sure, AGPL-3.0) is the main reference. Read its provider adapters under app/models/provider and the matching *_item / *_account models, and port the logic to TypeScript: account mapping, pending-to-posted handling, dedupe, credit card balance signs, holdings and cost basis, reconnect/repair flows, sync health. Keep one adapter per connector behind the shared connector interface.

* A connector registry with every connector below: availability, cost, regions, data types (transactions, balances, holdings, lots), free slots, last sync and health. A displays it.
* Build first (covers Sankar's accounts): Teller; Sophtron (free personal API, user ID + access key, HMAC-signed requests; banks, cards, brokerages, crypto); Plaid (Transactions, Liabilities, Investments including tax_lots); SnapTrade Personal (positions, balances, activities; derive lots from BUY/SELL); Zerodha Kite Connect Personal; Coinbase; WazirX.
* Build next (personal access, test with sample responses): SimpleFIN; Lunch Flow (paid; MX, Finicity, Stripe, GoCardless, SnapTrade behind one API); Interactive Brokers Flex Web Service; Trading 212; Questrade; Trade Republic; Indexa Capital; Kraken; Binance; CoinSpot; CoinStats; on-chain wallets (Bitcoin, EVM chains, Solana, Polkadot, Cosmos); Enable Banking (restricted production, own linked accounts); Wise (personal token); Akahu; Up; Redbark; Monobank; Fio banka; RentCast and Realie (property values).
* Market data: Yahoo Finance first, then Twelve Data, Tiingo, EODHD as fallbacks; Indian securities on NSE/BSE.
* Listed as unavailable, with reasons: Mercury and Brex (business accounts), MX / Mastercard Data Connect (Finicity) / Akoya direct (business contracts; use Lunch Flow instead), Apple FinanceKit (organization-level Apple Developer account), Zillow API, VinAudit, Capital One and Public direct links.
* Connector order when linking a new account: banks and cards Teller, then Sophtron, then Plaid Trial; brokerages SnapTrade, then the broker's own API, then Sophtron, then Plaid Investments; paid fallbacks SimpleFIN, then Lunch Flow.
* Test every connector against saved sample responses until real keys exist.

Later (don't build today)

* Gift cards and passes: balance, barcode or QR image, expiry, camera scan.
* Amazon and Target order sync through a Chrome extension on desktop: read order history, send orders to the Worker, match them to card transactions, split by item.
* iOS build.
