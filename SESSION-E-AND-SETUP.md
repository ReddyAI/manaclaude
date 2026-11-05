# Session E and account setup

Written November 5, 2026, after sessions A to D finished.

## Where things stand

Sessions A to D each opened a pull request, all open and all with green checks: #3 (C), #4 (A), #5 (D), #6 (B). They built the full original scope, more than the trimmed add-ons asked for: 33 connectors, the AI jobs, receipts, MCP read and write tools, planning and recaps.

Merged together they conflict in only two small files (`.prettierignore` and `packages/shared/src/index.ts`). Still missing before the app can use real money:

- Nothing links a new account. The backend can list and sync connections but has no way to create one, and the app has no Add account flow.
- The app still runs on sample data. No session connected it to the backend's API.
- B and D left a hand-off list for each other that nobody has done yet: B still uses its own copy of the sync logic instead of D's, Teller's certificate binding is switched off, and rotated tokens aren't saved.
- Setup currently means typing commands. E1 changes that so every secret goes into GitHub only.

The backend's sign-in is fine: every `/v1` request needs `APP_API_TOKEN`, and the Worker refuses everything if that secret is missing.

Session E is split in two so each session stays small and cheap:

| Session | Where | Environment | Model | Effort | Cost guess |
| ------- | ----- | ----------- | ----- | ------ | ---------- |
| E1: merge, wire B to D, one-place setup, deploy workflows | Claude Code on the web (cloud) | Default | Sonnet 5.5 | High | $6 to $10 |
| E2: link accounts, app on the backend | Your regular Claude Code, after setup | Your computer | Opus 5.5 | High | your plan |

Don't merge #3, #4, #5 or #6 yourself. E1 merges all four into one pull request.

## Step 1: start E1 now

New session: repository ReddyAI/manaclaude, branch `main`, environment Default, Sonnet 5.5, effort High, permission mode Auto. Paste this:

```text
You are build session E1 for my personal finance app in the repo ReddyAI/manaclaude. I don't code: you write and test everything. Don't stop to ask me questions; pick sensible defaults and list them at the end. Use only free tools and services. The repo is public: never commit secrets, keys, personal data or real account details.

In this cloud container run "export PATH=/opt/node24/bin:$PATH" first (the repo needs Node 24 and npm 11), and run Expo CLI with EXPO_OFFLINE=1.

Start by reading CLAUDE.md, docs/project-brief.md and docs/requirements-addendum.md. Then read the descriptions of pull requests #3, #4, #5 and #6 on GitHub; each has a section for the other sessions that you must act on.

1. Merge. Make your own branch from main and merge, in this order: origin/claude/great-pascal-oeochz (#5, connectors), origin/claude/pensive-archimedes-sfo46c (#6, backend), origin/claude/pensive-gauss-iw1ezd (#3, budgets and investments), origin/claude/funny-meitner-4wnvgk (#4, screens). Expected conflicts: .prettierignore (keep one .claude/ line) and packages/shared/src/index.ts (keep every export). Then run npm install and npm run check, and fix whatever fails. Use merges, not squashes or rebases, so GitHub marks the four pull requests as merged when yours is merged.

2. Connect the backend to D's connectors, as #5's description asks of session B: use D's planTransactionSync, planAccountSync, planInvestmentSync and runConnectionSync from connectors/src/sync/ in place of backend/src/sync/plan.ts; apply each plan in one D1 batch and then run the transfer matcher; save result.updatedSecrets after every sync; give Teller a ctx.fetch bound to the TELLER_CERT mTLS binding (turn it on in wrangler.toml); refresh RentCast and Realie values at most monthly; the daily cron syncs every healthy connection and skips needs_repair ones. Add tests for these.

3. One-place setup. I will enter every secret only in GitHub (repo Settings, Secrets and variables, Actions), never on the command line. Change .github/workflows/deploy-worker.yml so that, needing only the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets, it: creates or reuses the D1 database manaclaude, the R2 bucket manaclaude-files and the KV namespace for OAuth by name; applies the migrations; uploads the Teller certificate from the TELLER_CERT_PEM and TELLER_KEY_PEM secrets as an mTLS certificate when they exist; deploys the Worker; works out the Worker's public URL itself so I don't set PUBLIC_URL by hand; and copies each of these GitHub secrets into a Worker secret when it exists: APP_API_TOKEN, MCP_OWNER_PASSWORD, CREDENTIALS_SECRET, OXR_APP_ID, TELLER_APPLICATION_ID, PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, SOPHTRON_USER_ID, SOPHTRON_ACCESS_KEY, KITE_API_KEY, KITE_API_SECRET, ANTHROPIC_API_KEY. It runs on every push to main and by hand, and skips cleanly when CLOUDFLARE_API_TOKEN is missing. Also deploy the web app to Cloudflare Pages with the same two secrets (the web workflow says this waited for an account). Print the Worker URL, the web app URL and the MCP URL in the run summary.

4. Reserve this callback path for session E2, which builds account linking: /v1/link/zerodha_kite/callback. Don't build linking yourself.

5. Write docs/setup.md for me in plain steps, no code: the exact Cloudflare API token permissions your workflows need (as rows I pick in Cloudflare's Create Token page), that R2 must be turned on once in the dashboard, the GitHub secrets and what goes in each, where each connector's keys come from (Teller, Plaid, SnapTrade, Sophtron, Zerodha Kite Connect, Open Exchange Rates), the Zerodha redirect URL to register (https://manaclaude-api.<my-subdomain>.workers.dev/v1/link/zerodha_kite/callback), how to re-run the deploy, and how to connect Claude and Perplexity using docs/mcp.md.

How to test: npm run check must pass and the Android APK workflow must stay green. Check the workflows with actionlint if it's available. The deploy can't run without my account, so test its scripts with wrangler's dry run where you can.

Open one pull request to main titled "Session E1: merge A to D, connect backend and connectors, one-place setup". Say in it that it contains #3, #4, #5 and #6 so I don't merge those separately, and list the defaults you picked and anything session E2 needs to know.
```

## Step 2: set up your accounts while E1 runs

Menu names on these sites may differ a little from what's written here. E1's `docs/setup.md` will have the exact Cloudflare token permissions; if they differ from step 2.5, edit the token to match.

### 2.1 Three passwords

In your password manager, generate and save:

| Name | What it is |
| ---- | ---------- |
| APP_API_TOKEN | 40 or more random characters. The app sends it to your backend. |
| MCP_OWNER_PASSWORD | A password you'll type when connecting Claude or Perplexity. |
| CREDENTIALS_SECRET | 40 or more random characters. Encrypts your bank logins in the database. |

Never paste them into a chat.

### 2.2 to 2.5 Cloudflare (free)

1. Sign up at https://dash.cloudflare.com/sign-up.
2. Open Workers & Pages once. If it asks, pick your workers.dev subdomain and write it down.
3. Open R2 and turn it on. Cloudflare asks for a card even though storage under 10 GB is free.
4. Copy your Account ID (on the Workers & Pages overview page, or the long code in the address bar after dash.cloudflare.com/).
5. Profile icon, My Profile, API Tokens, Create Token, use the "Edit Cloudflare Workers" template. Add rows with "Add more": Account, D1, Edit; Account, Workers R2 Storage, Edit; Account, Cloudflare Pages, Edit. Create it and copy the token (it's shown once).

### 2.6 Open Exchange Rates (free)

Sign up at https://openexchangerates.org/signup/free and copy the App ID.

### 2.7 Connector keys (free developer accounts)

| Connector | Sign up | What to copy |
| --------- | ------- | ------------ |
| Teller | https://teller.io | Application ID; download the certificate and private key files |
| Plaid | https://dashboard.plaid.com/signup | client_id and the Sandbox secret (start with Sandbox) |
| SnapTrade | https://snaptrade.com | Client ID and consumer key from the personal or developer plan |
| Sophtron | https://sophtron.com | User ID and access key |
| Zerodha Kite Connect | https://developers.kite.trade | Create a Personal app. Redirect URL: https://manaclaude-api.YOUR-SUBDOMAIN.workers.dev/v1/link/zerodha_kite/callback. Copy API key and API secret |
| Coinbase, WazirX | nothing yet | You'll make read-only keys and enter them in the app after E2 |

### 2.8 Put everything into GitHub

Open https://github.com/ReddyAI/manaclaude/settings/secrets/actions and click "New repository secret" once per row. Skip any you don't have yet; you can add it later and re-run the deploy.

| Secret name | Value |
| ----------- | ----- |
| CLOUDFLARE_API_TOKEN | token from 2.5 |
| CLOUDFLARE_ACCOUNT_ID | Account ID from 2.4 |
| APP_API_TOKEN | from 2.1 |
| MCP_OWNER_PASSWORD | from 2.1 |
| CREDENTIALS_SECRET | from 2.1 |
| OXR_APP_ID | Open Exchange Rates App ID |
| TELLER_APPLICATION_ID | Teller Application ID |
| TELLER_CERT_PEM | open Teller's certificate file in Notepad and copy all of it, including the BEGIN and END lines |
| TELLER_KEY_PEM | the same for Teller's private key file |
| PLAID_CLIENT_ID | Plaid client_id |
| PLAID_SECRET | Plaid Sandbox secret |
| PLAID_ENV | sandbox |
| SNAPTRADE_CLIENT_ID | SnapTrade client ID |
| SNAPTRADE_CONSUMER_KEY | SnapTrade consumer key |
| SOPHTRON_USER_ID | Sophtron user ID |
| SOPHTRON_ACCESS_KEY | Sophtron access key |
| KITE_API_KEY | Zerodha API key |
| KITE_API_SECRET | Zerodha API secret |

## Step 3: after E1 opens its pull request

1. Check that it says it contains #3, #4, #5 and #6, and that all checks are green. Merge it.
2. GitHub should then show #3 to #6 as merged. If any stays open, close it.
3. Open the Actions tab and click the "Deploy Worker" run on main. Its summary shows the Worker URL, web app URL and MCP URL. If it failed with a permission error, fix the Cloudflare token as `docs/setup.md` says and click "Re-run jobs".
4. You can connect Claude now by following `docs/mcp.md`: in Claude's settings, add a custom connector with the MCP URL and sign in with MCP_OWNER_PASSWORD. It will show no data until E2 is done and your accounts are linked.

## Step 4: E2 in your regular Claude Code

Run it on your own computer so it can reach the bank sandboxes and your deployed backend. Push with your personal GitHub account; the earlier ChatGPT notes say not to use the work Git credentials saved on that computer. Model Opus 5.5, effort High. Replace YOUR-WORKER-URL with the Worker URL from step 3 (it isn't secret). Paste this:

```text
You are build session E2 for my personal finance app in the repo ReddyAI/manaclaude. Clone it if needed and work on a new branch. I don't code: you write and test everything. Don't stop to ask me questions until the pull request is open; pick sensible defaults and list them. The repo needs Node 24 and npm 11; install them if missing. The repo is public: never commit secrets, keys, personal data or real account details, and never ask me to paste a secret into this chat.

Read CLAUDE.md, docs/setup.md, docs/backend-plan.md, docs/mcp.md and connectors/README.md first. The backend is deployed at YOUR-WORKER-URL and all secrets are already set as Worker secrets from GitHub.

1. Link new accounts. Add /v1 endpoints and app screens to link: Teller (Teller Connect with TELLER_APPLICATION_ID; keep the access token it returns), Plaid (create a link token, Plaid Link, exchange the public token; react-native-plaid-link-sdk on Android and Plaid's web Link on web), SnapTrade Personal (register the user, open the connection portal, record the authorization), Sophtron (its link flow with SOPHTRON_USER_ID and SOPHTRON_ACCESS_KEY), Zerodha Kite (login redirect to /v1/link/zerodha_kite/callback, and a one-tap daily re-login from the needs_repair banner), and key-entry screens for Coinbase and WazirX that tell me to make read-only keys. Store every per-login credential encrypted in D1 with AES-GCM, using a key derived from the CREDENTIALS_SECRET Worker secret; no endpoint or log ever returns or prints one. Check free slots before linking. Wire the Accounts screen's Add account and Repair buttons to these flows, following the connector order in docs/project-brief.md and D's planRepair.

2. Make the app use the backend. Add a Backend section in Settings where I enter the Worker URL and my APP_API_TOKEN (expo-secure-store on the phone, browser storage on web). When both are set, the data store loads GET /v1/dataset and every change in features/*/actions.ts goes through the matching /v1 endpoint; otherwise it keeps the sample data. If the backend can't be reached, keep my last loaded data and show a clear error. Upload receipts from Receipt.localUri. Add pull to refresh and a "Sync now" button per connection.

3. Add to docs/setup.md anything I must register for these flows (for example the Android package name in Plaid's dashboard or allowed origins in Teller's).

Tests: npm run check must pass; test the link endpoints and the encryption against invented responses through a fake fetch, including that a credential never appears in any API response or log. The Android APK workflow must stay green.

Open a pull request to main. After I merge it, I'll install the new APK, link my accounts on my phone and tell you here what happens, and you fix what breaks.
```

## Step 5: after E2 is merged

1. Open the newest "Android APK" run on main in the Actions tab, download `mana-android-apk`, unzip it and install the `.apk` over the old one.
2. In the app: Settings, Backend. Enter the Worker URL and your APP_API_TOKEN.
3. Accounts, Add account. Banks and cards: Teller first, then Sophtron, then Plaid for any bank the first two can't handle. Brokerages: SnapTrade first, then Zerodha Kite. Then Coinbase and WazirX with read-only keys.
4. Tell the E2 session what worked and what didn't.
5. For real (non-sandbox) Plaid data, request production access in Plaid's dashboard, then change the PLAID_SECRET and PLAID_ENV secrets in GitHub and re-run the deploy.
