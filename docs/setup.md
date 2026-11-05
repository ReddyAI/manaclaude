# Setup

This is everything you do by hand, once. After it, every push to main deploys the Worker and the web app by itself. You never type a secret on a command line: all of them go into GitHub, and the deploy workflow copies them into Cloudflare.

Provider dashboards (Plaid, SnapTrade, Sophtron, SimpleFIN, Zerodha, Open Exchange Rates) change their menus from time to time. The build environment could not open them, so the paths below come from memory of how they were laid out. If a label differs, look for the same word nearby.

## What you need

- A free Cloudflare account.
- Admin rights on the GitHub repository ReddyAI/manaclaude (to add secrets).
- A password manager, to keep the random values you invent below.

## 1. Turn on R2 once

R2 holds receipts and statement files. Cloudflare asks you to switch it on yourself, and the workflow cannot do that for you.

1. Sign in at dash.cloudflare.com.
2. In the left menu open R2 Object Storage.
3. Press the button to get started or enable R2. Cloudflare may ask for a payment card. The first 10 GB stays free, and Billionaire will use far less.

If you skip this, the deploy stops at the "Create or reuse Cloudflare resources" step with a message that says R2 is not turned on. Do this step, then run the workflow again.

## 2. Make the Cloudflare API token

1. In Cloudflare open My Profile, then API Tokens, then Create Token.
2. Choose "Create Custom Token" (or start from the "Edit Cloudflare Workers" template and check the rows against the list below).
3. Add these permission rows. Each row has three dropdowns: the first says Account, the second is the permission group, the third is the level.

| First dropdown | Permission group   | Level |
| -------------- | ------------------ | ----- |
| Account        | Workers Scripts    | Edit  |
| Account        | D1                 | Edit  |
| Account        | Workers R2 Storage | Edit  |
| Account        | Workers KV Storage | Edit  |
| Account        | Cloudflare Pages   | Edit  |
| Account        | Account Settings   | Read  |

4. Under Account Resources choose Include, then your account. Leave Zone Resources empty; Billionaire uses no custom domain.
5. Create the token and copy it right away. Cloudflare shows it once.

These are the rows Cloudflare's own Workers token template and third-party guides list for this kind of deploy. (An earlier version of this guide had a seventh row, SSL and Certificates. It is no longer needed, and you can remove it from the token.)

Find your Account ID on the Cloudflare dashboard home page: open your account's menu (the three dots next to the account name) and choose Copy account ID.

## 3. Add the GitHub secrets

In GitHub open the repository, then Settings, then Secrets and variables, then Actions, then New repository secret. Add one secret per row. Only the first two are needed to deploy. The rest can be added whenever you have them; after you add one, run the deploy again (step 6).

| Secret name            | What goes in it                                                                                                                                                                                                                                                | Needed for                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| CLOUDFLARE_API_TOKEN   | The token from step 2                                                                                                                                                                                                                                          | Everything                    |
| CLOUDFLARE_ACCOUNT_ID  | The account ID from step 2                                                                                                                                                                                                                                     | Everything                    |
| APP_API_TOKEN          | A long random string you invent (40 or more characters, from your password manager's generator). The app sends it with every request.                                                                                                                          | The app talking to the Worker |
| MCP_OWNER_PASSWORD     | A password you invent. You type it on the sign-in page when you connect Claude or Perplexity.                                                                                                                                                                  | MCP                           |
| CREDENTIALS_SECRET     | A second long random string (40 or more characters). It encrypts the saved bank logins in the database. Save a copy in your password manager. Do not change it later: every saved login would become unreadable and you would have to link the accounts again. | Linking accounts and syncing  |
| OXR_APP_ID             | The Open Exchange Rates app ID (see below)                                                                                                                                                                                                                     | Hourly exchange rates         |
| PLAID_CLIENT_ID        | Your Plaid client ID                                                                                                                                                                                                                                           | Plaid                         |
| PLAID_SECRET           | The Plaid secret for the same environment                                                                                                                                                                                                                      | Plaid                         |
| PLAID_ENV              | The word sandbox or production                                                                                                                                                                                                                                 | Plaid                         |
| SNAPTRADE_CLIENT_ID    | Your SnapTrade client ID                                                                                                                                                                                                                                       | SnapTrade                     |
| SNAPTRADE_CONSUMER_KEY | Your SnapTrade consumer key                                                                                                                                                                                                                                    | SnapTrade                     |
| SOPHTRON_USER_ID       | Your Sophtron user ID                                                                                                                                                                                                                                          | Sophtron                      |
| SOPHTRON_ACCESS_KEY    | Your Sophtron access key                                                                                                                                                                                                                                       | Sophtron                      |
| KITE_API_KEY           | The API key of your Kite Connect app                                                                                                                                                                                                                           | Zerodha direct                |
| KITE_API_SECRET        | The API secret of the same app                                                                                                                                                                                                                                 | Zerodha direct                |
| ANTHROPIC_API_KEY      | An Anthropic API key. Optional: Billionaire's AI uses Cloudflare Workers AI by default and this only adds Claude as a choice. It bills per use.                                                                                                                | Claude as the AI provider     |

A secret that is not set is skipped. A Worker secret that already exists in Cloudflare is left alone when the GitHub secret is missing, so removing a GitHub secret does not remove it from the Worker. To remove one for good, delete it in the Cloudflare dashboard under Workers & Pages, manaclaude-api, Settings, Variables and Secrets.

## 4. Where each provider's keys come from

All of these have a free personal route. Sign-ups and key pages:

- Plaid (dashboard.plaid.com). Sign up, then open Developers and Keys. The client ID is the same everywhere; the secret differs per environment. Use sandbox while testing with fake banks. The free Trial plan gives 10 lifetime logins and uses the production environment, so set PLAID_ENV to production once you are approved for it. Keep those 10 logins for banks Sophtron and SimpleFIN cannot read. Billionaire does not call Plaid at all until you ask for it to be turned on (see step 7).
- SnapTrade (snaptrade.com). Sign up for the Personal (free) plan in their dashboard. It shows a client ID and a consumer key. It covers Robinhood, E*TRADE and Zerodha with up to 20 connections.
- Sophtron (sophtron.com). Create a personal developer account and open the API or developer page. It shows a user ID and an access key. Free for personal use, 10,000 requests a month.
- Zerodha Kite Connect (developers.kite.trade). Sign in with your Zerodha login, open My apps, and create an app of the free Personal type. Kite shows the API key and API secret on the app's page. The same page has a Redirect URL field (see step 5).
- Open Exchange Rates (openexchangerates.org). Sign up for the free plan, then open the App IDs page and copy the default app ID. The free plan allows hourly updates and a USD base, which is what Billionaire uses.

## 5. Register the Zerodha redirect URL

Kite sends your browser back to the Worker after you log in to Zerodha. The Worker only accepts the address you register.

1. Find your workers.dev name. The first deploy prints the full address in the run summary (step 6). It looks like manaclaude-api.<my-subdomain>.workers.dev. <my-subdomain> is your Cloudflare workers.dev subdomain.
2. In the Kite developer console open your app and set the Redirect URL to:

https://manaclaude-api.<my-subdomain>.workers.dev/v1/link/zerodha_kite/callback

with your own subdomain in place of <my-subdomain>. The run summary also prints this exact line.

3. Save the app. In Billionaire, Accounts, then the + button, then Zerodha Kite, opens the Kite login and comes back to the app by itself.

Zerodha ends your Kite login every morning (around 6 am India time). That is Zerodha's rule. The Accounts screen then shows a "Log in to Zerodha" button: one tap opens the Kite login, and after you sign in the app syncs. No new connection is used.

## 6. Deploy, and deploy again

The workflow is called "Deploy to Cloudflare" (file .github/workflows/deploy-worker.yml). It runs on its own after every push to main. To run it by hand:

1. Open the repository on GitHub, then the Actions tab.
2. Choose "Deploy to Cloudflare" in the left list.
3. Press "Run workflow", keep the branch on main, and press the green button.

Run it again whenever you add or change a GitHub secret, because that is when the values are copied into the Worker.

What it does, in order: runs the backend tests; creates or reuses the D1 database manaclaude, the R2 bucket manaclaude-files and the KV namespace for sign-ins; finds or registers your workers.dev address; applies the database migrations; deploys the Worker; copies the secrets; deploys the web app to Cloudflare Pages; and prints the addresses.

If CLOUDFLARE_API_TOKEN is missing, the workflow skips itself and shows a notice. If only CLOUDFLARE_ACCOUNT_ID is missing, it stops with an error that says so.

The run summary (open the finished run and scroll to the Summary page) lists three addresses:

- Worker (API): https://manaclaude-api.<my-subdomain>.workers.dev
- Web app: https://manaclaude.pages.dev (Cloudflare adds a suffix if that name is taken)
- MCP server: the Worker address followed by /mcp

A brand-new workers.dev address can take a minute to answer. The workflow checks for that and prints a warning if it still does not.

If your Cloudflare account has never had a workers.dev address, the workflow registers one named manaclaude- followed by eight letters or digits taken from your account ID. You can rename it in the Cloudflare dashboard later, but then run the deploy again and register the Zerodha redirect URL again.

## 7. Link your accounts

Do these on the phone after installing the new APK (or in the web app). First open Settings, Backend: the Worker URL is filled in when the build knows it; paste your APP_API_TOKEN from your password manager and press Save and connect. The app checks the token with the Worker before it keeps it, then stores it in the phone's secure storage (in the browser's own storage on the web). Until both are set, the app shows made-up sample data.

The Accounts screen's + button (Add account) lists every way to link, in the order to try them. Each new login fetches up to two years of history. A long history comes in parts: you can leave the screen, and the Worker finishes it within a few minutes on its own.

### Sophtron (US banks and cards, try first)

1. Sign up for a personal developer account at sophtron.com and open its API or developer page. It shows a user ID and an access key. Free for personal use, 10,000 requests a month.
2. Add them as the GitHub secrets SOPHTRON_USER_ID and SOPHTRON_ACCESS_KEY (step 3) and run the deploy again (step 6). Skip this if they are already set.
3. In the app: +, Sophtron, search for your bank, sign in with the bank's own user name and password, and answer any security question or code the bank asks for. The password goes to Sophtron once and is not stored.

If a card or loan shows purchases as income, tell me: Sophtron banks differ in how they sign cards and loans, and the app decides per account from the rows it sees.

### SimpleFIN (US banks Sophtron can't read, $15 a year)

1. Sign up at SimpleFIN Bridge (beta-bridge.simplefin.org) and pay the $15 a year. It covers up to 25 institutions and refreshes once a day.
2. On SimpleFIN Bridge, connect your banks there first (SimpleFIN signs in to them, not Billionaire).
3. Still on SimpleFIN Bridge, open the page for apps (named New connection or Connect an app), create a setup token and copy it. It is one long line of letters and digits.
4. In the app: +, SimpleFIN, paste the token, Connect. A token works once. If the app says it was already used, make a new one.

### SnapTrade (brokerages, try first)

The SnapTrade keys are already GitHub secrets. In the app: +, SnapTrade, Open SnapTrade, choose the brokerage (Robinhood, E*TRADE, Zerodha...) and sign in on SnapTrade's page. On the phone the page closes by itself; on the web, come back to the Billionaire tab and press Done. Each brokerage login uses one of the 20 free connections.

If SnapTrade complains about the redirect address, add https://manaclaude-api.<my-subdomain>.workers.dev/v1/link/snaptrade/callback as an allowed redirect in the SnapTrade dashboard.

### Zerodha Kite (Zerodha direct)

Register the redirect URL first (step 5). Then in the app: +, Zerodha Kite, Log in to Zerodha. From then on, a "Log in to Zerodha" button appears on the Accounts screen each morning.

### Coinbase and WazirX (crypto)

Make read-only keys. Never allow trading, transfers or withdrawals on a key you give an app.

- Coinbase: on coinbase.com open Settings, then API (Coinbase Developer Platform), create an API key and tick only View. Copy the key name and the private key.
- WazirX: open Settings, then API Key Management, create a key and leave trading and withdrawals off. Copy the API key and the secret key.

In the app: +, Coinbase or WazirX, paste both parts, Check and save. The app checks the key with the exchange before saving it.

### India NRE and NRO statements

These accounts have no connector. Download the statement from the bank's website as PDF or CSV. In the app: Accounts, Connectors, Import a statement (or +, Import a statement), pick the file, choose the NRE or NRO account (or let the file decide), look at the preview and press Import. Rows that are already there are left out, so importing an overlapping statement again is safe. PDF statements are read by Workers AI on your Worker.

### Plaid (later, only when you say so)

Plaid stays switched off: the Worker refuses every Plaid request and nothing is sent to Plaid, not even its Sandbox. The Plaid row in Add account still shows its question ("This uses 1 of your 10 lifetime Plaid connections (N left). Continue?") so you can see how it will work. When you want to spend a Plaid login:

1. In dashboard.plaid.com open Developers, then API. Under Allowed Android package names add com.reddyai.manaclaude. (The phone's Plaid Link checks this.)
2. Make sure PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV (production for the free Trial plan) are GitHub secrets, and run the deploy.
3. Tell me to turn Plaid on. That is one line (PLAID_LINK_ENABLED in backend/wrangler.toml) and a deploy.
4. Use Plaid from the phone. Banks that sign in through their own website (OAuth) also need an allowed redirect URI in Plaid's dashboard for the web app; the web app does not handle that yet.

### Repairs

A login that stops working shows on the Accounts screen with a Repair button. Repair keeps the same connection, accounts and history and never uses a new slot. Each connection also has Sync now on the Connectors tab, and pulling down on Home, Transactions or Accounts reloads your data.

## 8. Connect Claude and Perplexity

The server address is the MCP line from the run summary. The full click-by-click steps are in docs/mcp.md. In short:

1. Claude (Pro): open Settings, then Connectors, press Add custom connector, name it Billionaire, paste the MCP address, press Add, then Connect. A Billionaire page opens. Type MCP_OWNER_PASSWORD and press Allow.
2. Perplexity (Pro): on the website open Settings, then Connectors, press Add custom connector, choose Remote, paste the MCP address, pick OAuth, save, and sign in with the same password. If Perplexity asks for a client ID and secret, docs/mcp.md shows how to create them.

Write tools (changing categories, adding cash entries) stay off until you turn on "Let AI assistants make changes" in the app's Settings.

## What can go wrong

- "R2 is not turned on": do step 1.
- A 403 or "Authentication error" from Cloudflare: the token is missing a permission row from step 2, or it is limited to a different account. Fix the token, then run the workflow again.
- The app says the API token is wrong: APP_API_TOKEN in GitHub and the value typed into the app differ. Copy it again from your password manager. After changing it in GitHub, run the deploy again.
- Linked bank logins stopped working after you changed CREDENTIALS_SECRET: put the old value back, or link the accounts again.
- The app shows "The backend can't be reached": check the phone's connection and the Worker URL in Settings, Backend. Your last loaded data stays on screen meanwhile.
- A link screen says a connector "is not set up yet": the GitHub secrets it names are missing. Add them and run the deploy again.
