Personal Finance App: project brief
Last updated: November 4, 2026 (fifth update: Claude does all the work, in cloud sessions)
How we work

* Claude writes all the code and does all the research in Claude Code's cloud sessions. Sankar says what he wants and how it should work; he does not code. ChatGPT is not part of the workflow for now (it produced one first pass on Sure, kept in research/sure/).
* Repo: ReddyAI/manaclaude (Sankar's choice; no new repo). Public as of Nov 4, so nothing personal or secret ever goes in it. Sessions work on their own branches and open pull requests. research/ belongs to the research session; build sessions only read it.
* No .NET.
* Personal use only. Personal accounts only: Sankar can't open business accounts, so any connector that needs one is out.

Platform priority

1. Android (Oppo Find X9 Pro): main device
2. Web / desktop
3. iOS

Stack

* App: Expo (React Native) + TypeScript, one codebase for Android, web and iOS.
* Backend: Cloudflare Workers (free plan) + D1 database + Cron Triggers for scheduled syncs. Teller's client certificate goes in a Workers mTLS binding. Receipt images in R2 (free: 10 GB storage). In-app AI on Workers AI (free: 10,000 Neurons a day).
* Builds: GitHub Actions builds the Android APK and deploys the backend and web app.
* Why not Flutter: this cloud environment blocks pub.dev and the Flutter SDK download, so nothing Flutter could be installed or tested here. Expo installs, type-checks and builds for web here (tested Nov 4, 2026; run Expo CLI with EXPO_OFFLINE=1 because api.expo.dev is blocked).

Sure: the connector reference
Sure (AGPL-3.0) has the widest connector set of any app we studied, and it is the main reference for connectors and the data model. We don't fork it, but its provider adapters (Ruby) are open source and can be read and ported to TypeScript; our app is open source too, so AGPL is fine. Teller is added even though Sure doesn't have it.
Teardown of the reference apps
A Claude cloud research session runs the Replica skills (recon, design, diff, reviews) on Sure, Monarch, Copilot, Rocket Money, Lunch Money and Simplifi and writes research/ (prompt: claude/replica-session-prompt.md). Closed apps: public sources only. Sure: its public code. Findings feed the build as they land; the build doesn't wait for the full teardown. A second pass with Sankar's own trial accounts comes later.
UI and feature references
Details per area in claude/ui-references.md.

* Monarch Money: dashboard widgets, interactive reports, Flex Budgeting, Month in Review, goals, receipt scanning, Amazon/Target order sync
* Copilot Money: transaction review with AI confidence, recurring payments, monthly recap, motion and typography
* Rocket Money: subscriptions (keep / cancel / review), onboarding
* Sure: connectors, data model, AI PDF statement parsing with reconciliation, statement vault, insights feed
* Lunch Money: multicurrency (USD + INR), rules, splits, tags, dense desktop tables
* Simplifi: Spending Plan
* YNAB: linked transfers

Required features (added Nov 4)

* Category budgets (required). Monarch-style Flex budgeting optional. No credit monitoring.
* Investments: per-lot purchase date and cost basis, realized and unrealized gains, dividends, allocation, benchmark, stock splits. Planning: retirement / FIRE projection and goals, free.
* Linked transfers: the two sides of a transfer are one linked item, shown once, kept out of spending and income. Credit card payments count as transfers. Cross-currency transfers (USD to NRE) keep both amounts, so the real rate is recorded.
* Default money policies (changeable later): transfers, card payments and brokerage/retirement contributions aren't spending; loan principal is a transfer and interest is spending; refunds reduce their category in the month they post, with no zero floor; amounts stored as integer minor units plus currency.
* Manual cash accounts in USD and INR, with fast entry. ATM withdrawals are transfers into cash.
* Receipts: photo, upload or share into the app; AI reads merchant, date, total and line items; auto-match to the transaction; optional split by line items.
* AI, two layers:
   1. A remote MCP server on the Worker so Sankar's own Claude and Perplexity accounts (and ChatGPT if his plan allows custom connectors) can read his data. Read tools first; write tools only after confirmation.
   2. In-app AI on Workers AI's free allowance, with an optional own API key (Anthropic, OpenAI, OpenAI-compatible, or paid Gemini). Not Gemini's free tier (Google's terms let reviewers read unpaid inputs and say not to send personal info). Features: categorization that learns from corrections and shows confidence, merchant name cleanup, questions in plain English, weekly and monthly recap, receipt and PDF statement parsing, recurring detection with price-increase alerts, duplicate and unusual charge alerts, one switch to turn all AI off.
* Display currency switch in the header: USD only, INR only, both, or each account's own currency. Latest rate hourly from Open Exchange Rates (free plan, USD base); ECB daily rates via Frankfurter (Sure uses it too) as fallback and for history. Show the rate's timestamp. Google has no public rate API.
* Later version: gift cards and passes (balance + barcode). Google Wallet already turns photos of passes into Wallet passes in the US.

Connectors: everything Sure, Monarch, Copilot, Rocket Money and Lunch Money use, plus Teller
Personal access only. Sure's list taken from its releases through v0.7.6-alpha.5 (Oct 2026).
Banks and cards (US):

* Teller: free, 100 lifetime logins
* Sophtron (Sure): free for personal, non-commercial use, 10,000 requests a month, no lifetime cap; covers US/Canada banks, cards, brokerages and crypto exchanges; logs in with your credentials through an AI agent
* Plaid Trial (all five apps): free, 10 lifetime logins, OAuth for big banks
* SimpleFIN (Sure): $15/yr, 25 institutions (paid fallback)
* Lunch Flow (Sure): paid per connection; the only personal route to MX, Finicity and Stripe Financial Connections, plus GoCardless (EU) and SnapTrade

Banks (other countries, personal tokens; build, test with sample data):

* Enable Banking (Sure): EU/UK, free restricted production for private individuals' own linked accounts
* Wise (Sure): personal token; US accounts can read statements (check that your personal account offers API tokens)
* Akahu (Sure): New Zealand, free for own data
* Up (Sure): Australia, personal token
* Redbark (Sure): Australia (check pricing)
* Monobank (Sure): Ukraine, personal token
* Fio banka (Sure): Czech Republic, personal token

Brokerages:

* SnapTrade Personal (Sure, Lunch Flow): free, 20 connections; covers Robinhood, E*TRADE, Zerodha; tax lots are a paid add-on, so lots are derived from activities
* Interactive Brokers Flex Web Service (Sure): free personal token, up to 1 year
* Trading 212, Questrade, Trade Republic, Indexa Capital (Sure): personal API keys/logins in their regions
* Zerodha Kite Connect Personal: free backup for Zerodha
* Plaid Investments: holdings include tax lots when the institution provides them
* Sophtron: backup

Crypto:

* Coinbase, Kraken, Binance, CoinSpot (Sure), WazirX: personal API keys
* On-chain wallets (Sure): Bitcoin, EVM chains, Solana, Polkadot, Cosmos; public blockchain data
* CoinStats (Sure): exchanges and DeFi (check its free plan)

Property and vehicles:

* RentCast (Sure): free plan, 50 calls a month
* Realie (Sure): US parcel and valuation data (check free plan)
* Vehicles: manual value

Market data and FX:

* Yahoo Finance, Twelve Data, Tiingo, EODHD (Sure); Frankfurter and Open Exchange Rates for FX
* India: Sure added Indian investment subtypes and NSE/BSE exchange support

Retail and payments:

* Amazon and Target orders: our own Chrome extension on desktop (Monarch's approach); later
* Venmo: statement download (Copilot's custom link isn't public)

Files (Sure has all of these):

* CSV with saved mappings and date-format detection, PDF statements with AI parsing and reconciliation against existing transactions, QIF with splits, OFX, Sure NDJSON (lets Sankar move data in from Sure), Actual Budget CSV, a statement vault that keeps the original files

Not usable (needs a business account or a business contract):

* Mercury and Brex (Sure): business bank accounts
* MX, Mastercard Data Connect/Finicity and Akoya direct: business contracts only; reach MX and Finicity through Lunch Flow instead
* Apple FinanceKit (Copilot, Sure): needs an organization-level Apple Developer account; iOS only
* Zillow API (partners only), VinAudit (business API), Copilot's direct Capital One and Public links

Connector order (free first, best sync first, then cheapest paid)
Banks and cards: 1. Teller, 2. Sophtron, 3. Plaid Trial (keep its 10 lifetime slots for banks the first two can't handle) Brokerages: 1. SnapTrade Personal, 2. the broker's own API (IBKR Flex, Zerodha Kite, etc.), 3. Sophtron, 4. Plaid Investments Crypto: exchange's own API, then on-chain wallet tracking, then CoinStats India (NRE, NRO and anything without a connector): PDF/CSV statement import Paid, only if free runs out: SimpleFIN ($15/yr), then Lunch Flow (per connection, MX/Finicity coverage), then SnapTrade pay-as-you-go ($2/mo), then Plaid or Teller paid plans (prices unpublished).
Rules: one connector per account; show remaining free slots per connector; repair broken connections instead of deleting and re-adding (lifetime caps); show each connector's last sync and health.
Milestones

1. App shell, design system (with Look switch) and core screens with sample data (Android APK + web)
2. Backend, all file imports, categories, rules, splits, linked transfers, cash accounts, receipts, FX rates
3. Connectors: first the ones that cover Sankar's accounts (Teller, Sophtron, Plaid, SnapTrade, Zerodha Kite, Coinbase, WazirX), then every other personal connector above
4. Category budgets and Spending Plan, recurring/subscriptions, net worth and investments with lots and planning, recaps, currency switch
5. MCP server and in-app AI features
6. Later: gift cards and passes, Amazon/Target Chrome extension, iOS

Open items

* Repo visibility: manaclaude is public; Sankar may switch it to private (then install the Claude GitHub App on it)
* Free Cloudflare account (needed for milestone 2)
* Connector sign-ups at milestone 3: Teller, Sophtron, Plaid, SnapTrade, WazirX key, Open Exchange Rates app ID
* Check at sign-up: Wise personal API token, CoinStats and Realie free plans, Lunch Flow's current US plan price
* ChatGPT custom connector: OpenAI's help page lists it for Business and Enterprise/Edu; test on Plus before relying on it
* iOS: web app on the home screen ($0) or Apple Developer account for a native app
