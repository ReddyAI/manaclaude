# Session E2

Written November 5, 2026, after E1 (pull request #7) was merged and deployed.

## Changes from the earlier E2 plan

- Teller shut down its API in July 2026. E2 marks it unavailable and doesn't build a Teller flow.
- Plaid is off limits for now: no calls at all, not even its Sandbox. E2 builds the Plaid flow against invented responses only, and the app asks before using one of the 10 lifetime connections.
- New bank order: Sophtron (free, 10,000 requests a month), then SimpleFIN ($15 a year, 25 institutions, one refresh a day), then Plaid for a bank the other two can't handle.
- E2 also builds an import screen in the app, since India NRE and NRO statements come in as PDF or CSV.
- E1 flagged that Cloudflare's free plan limits how many database queries one request can make. E2 makes the first sync of a new account work within that limit.
- E2 runs in the cloud now (Default environment). It doesn't need to reach any bank provider, so there's nothing to set up on your computer.

## How to run it

1. Merge the pull request with the Billionaire name and icon first, so E2 starts from it.
2. Start a new session: repository ReddyAI/manaclaude, branch `main`, environment Default, Opus 5.5, effort High, permission mode Auto.
3. Paste the prompt below and send it.

```text
You are build session E2 for my personal finance app, now called Billionaire, in the repo ReddyAI/manaclaude. I don't code: you write and test everything. Don't stop to ask me questions until the pull request is open; pick sensible defaults and list them. Use only free tools and services. The repo is public: never commit secrets, keys, personal data or real account details, and never ask me to paste a secret into this chat.

In this cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11), and run Expo CLI with EXPO_OFFLINE=1.

Read CLAUDE.md, docs/setup.md, docs/backend-plan.md, docs/mcp.md, connectors/README.md and the "For session E2" section of pull request #7 first. The backend is deployed on Cloudflare and every secret is already set from GitHub.

Two facts change the plan in docs/project-brief.md:
- Teller shut down its API in July 2026. Mark the teller connector unavailable in connectors/src/registry.ts with the reason "Teller shut down its API in July 2026", take it out of every connector order, and don't build a Teller link flow. Leave the adapter code in place, unused. Remove Teller from docs/setup.md and drop the Teller certificate step from the deploy.
- Do not call Plaid at all, not even its Sandbox, until I say so. Build and test the Plaid flow only against invented responses through a fake fetch. In the app, linking with Plaid must first show: "This uses 1 of your 10 lifetime Plaid connections (N left). Continue?"

New connector order. US banks and cards: Sophtron first (free, 10,000 requests a month), then SimpleFIN (paid, $15 a year, 25 institutions, one refresh a day), then Plaid only for a bank the other two can't handle. Brokerages: SnapTrade Personal, then Zerodha Kite, then Sophtron. Crypto: the exchange's own API. India NRE and NRO: PDF and CSV import.

1. Link new accounts. Add /v1 endpoints and app screens to link:
   - Sophtron, with SOPHTRON_USER_ID and SOPHTRON_ACCESS_KEY. Sure has open bugs about Sophtron card and loan signs and card balances (github.com/we-promise/sure issues 4350 and 3252); if you can read them, check our adapter for the same bugs and fix them.
   - SimpleFIN: I paste a setup token; claim it for the access URL.
   - SnapTrade Personal: register the user, open the connection portal, record the authorization.
   - Zerodha Kite: login redirect to /v1/link/zerodha_kite/callback with a signed state that expires, and a one-tap daily re-login from the needs_repair banner.
   - Plaid: link token, Plaid Link, public token exchange (react-native-plaid-link-sdk on Android, Plaid's web Link on web), tested only with invented responses.
   - Coinbase and WazirX: key-entry screens that tell me to make read-only keys.
   Store every per-login credential with saveCredentials from backend/src/sync/credentials.ts; no endpoint or log ever returns or prints one. Check free slots before linking. Wire the Accounts screen's Add account and Repair buttons to these flows in the order above, using D's planRepair.

2. Make the app use the backend. Add a Backend section in Settings where I enter the Worker URL (prefilled from EXPO_PUBLIC_API_URL when it's set) and my APP_API_TOKEN (expo-secure-store on the phone, browser storage on web). When both are set, the data store loads GET /v1/dataset and every change in features/*/actions.ts goes through the matching /v1 endpoint; otherwise it keeps the sample data. If the backend can't be reached, keep my last loaded data and show a clear error. Upload receipts from Receipt.localUri. Add pull to refresh and a "Sync now" button per connection. Add an import screen: pick a CSV, OFX, QIF or PDF file, choose the account, see the preview, confirm.

3. First sync within the free plan. Pull request #7 notes that Cloudflare's Workers Free plan allows about 50 D1 queries per invocation (check Cloudflare's docs if you can reach them; otherwise design for 50). Make sure linking an account with two years of history works: multi-row inserts, and a long first sync split across several invocations that continue from the saved cursor. Test it with an invented fixture of at least 3,000 transactions.

4. Add to docs/setup.md, in plain steps, anything I must do for these flows: Sophtron sign-up, getting a SimpleFIN setup token, the Zerodha redirect URL, and what to register in Plaid's dashboard later (the Android package name is com.reddyai.manaclaude).

Tests: npm run check must pass. Test the link endpoints and credential handling against invented responses, including that a credential never appears in any API response or log. Check the screens you touched in the web build with Playwright at 412 px in Midnight dark only. The Android APK workflow must stay green.

Open a pull request to main. After I merge it, I'll install the new APK, link my accounts on my phone and tell you here what happens, and you fix what breaks.
```

## After E2 is merged

1. Open the newest "Android APK" run on main in the Actions tab, download `billionaire-android-apk`, unzip it and install the `.apk` over the old one.
2. In the app: Settings, Backend. Check the Worker URL and enter your APP_API_TOKEN.
3. Accounts, Add account: Sophtron for banks and cards, SnapTrade for brokerages, Zerodha Kite, then Coinbase and WazirX with read-only keys. Use the import screen for NRE and NRO statements. Leave Plaid alone until you decide to spend a connection.
4. Tell the E2 session what worked and what didn't.
