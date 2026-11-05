# Setup

This is everything you do by hand, once. After it, every push to main deploys the Worker and the web app by itself. You never type a secret on a command line: all of them go into GitHub, and the deploy workflow copies them into Cloudflare.

Provider dashboards (Teller, Plaid, SnapTrade, Sophtron, Zerodha, Open Exchange Rates) change their menus from time to time. The build environment could not open them, so the paths below come from memory of how they were laid out. If a label differs, look for the same word nearby.

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

| First dropdown | Permission group     | Level |
| -------------- | -------------------- | ----- |
| Account        | Workers Scripts      | Edit  |
| Account        | D1                   | Edit  |
| Account        | Workers R2 Storage   | Edit  |
| Account        | Workers KV Storage   | Edit  |
| Account        | Cloudflare Pages     | Edit  |
| Account        | Account Settings     | Read  |
| Account        | SSL and Certificates | Edit  |

4. Under Account Resources choose Include, then your account. Leave Zone Resources empty; Billionaire uses no custom domain.
5. Create the token and copy it right away. Cloudflare shows it once.

The last row (SSL and Certificates) is only for uploading the Teller certificate. It is my best match for the permission that covers mTLS certificates, and I could not confirm the name because Cloudflare's documentation was not reachable from the build environment. If you have no Teller certificate yet, you can leave that row out and add it later. If the deploy log shows an authentication error on the Teller certificate step, open the token, look for the permission with "certificate" or "mTLS" in its name, add it and run the workflow again. The other six rows are the ones Cloudflare's own Workers token template and third-party guides list for this kind of deploy.

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
| TELLER_APPLICATION_ID  | The Teller application ID (see below)                                                                                                                                                                                                                          | Linking banks with Teller     |
| TELLER_CERT_PEM        | The whole text of Teller's certificate file, including the BEGIN and END lines                                                                                                                                                                                 | Teller outside its sandbox    |
| TELLER_KEY_PEM         | The whole text of Teller's private key file, including the BEGIN and END lines                                                                                                                                                                                 | Teller outside its sandbox    |
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

- Teller (teller.io). Create a developer account and an application. The dashboard shows the Application ID (starts with app_) and lets you download the certificate and private key files for the development and production environments. Free for 100 lifetime logins. Open both files in a text editor and paste their full contents into TELLER_CERT_PEM and TELLER_KEY_PEM.
- Plaid (dashboard.plaid.com). Sign up, then open Developers and Keys. The client ID is the same everywhere; the secret differs per environment. Use sandbox while testing with fake banks. The free Trial plan gives 10 lifetime logins and uses the production environment, so set PLAID_ENV to production once you are approved for it. Keep those 10 logins for banks Teller and Sophtron cannot read.
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

3. Save the app. The Worker already answers on that path; the linking screen that uses it comes with the account-linking work.

Zerodha ends your Kite login every morning (around 6 am India time). That is Zerodha's rule. The connection then shows "Repair needed" and one tap on Reconnect fixes it.

## 6. Deploy, and deploy again

The workflow is called "Deploy to Cloudflare" (file .github/workflows/deploy-worker.yml). It runs on its own after every push to main. To run it by hand:

1. Open the repository on GitHub, then the Actions tab.
2. Choose "Deploy to Cloudflare" in the left list.
3. Press "Run workflow", keep the branch on main, and press the green button.

Run it again whenever you add or change a GitHub secret, because that is when the values are copied into the Worker.

What it does, in order: runs the backend tests; creates or reuses the D1 database manaclaude, the R2 bucket manaclaude-files and the KV namespace for sign-ins; uploads the Teller certificate if both PEM secrets exist; finds or registers your workers.dev address; applies the database migrations; deploys the Worker; copies the secrets; deploys the web app to Cloudflare Pages; and prints the addresses.

If CLOUDFLARE_API_TOKEN is missing, the workflow skips itself and shows a notice. If only CLOUDFLARE_ACCOUNT_ID is missing, it stops with an error that says so.

The run summary (open the finished run and scroll to the Summary page) lists three addresses:

- Worker (API): https://manaclaude-api.<my-subdomain>.workers.dev
- Web app: https://manaclaude.pages.dev (Cloudflare adds a suffix if that name is taken)
- MCP server: the Worker address followed by /mcp

A brand-new workers.dev address can take a minute to answer. The workflow checks for that and prints a warning if it still does not.

If your Cloudflare account has never had a workers.dev address, the workflow registers one named manaclaude- followed by eight letters or digits taken from your account ID. You can rename it in the Cloudflare dashboard later, but then run the deploy again and register the Zerodha redirect URL again.

## 7. Connect Claude and Perplexity

The server address is the MCP line from the run summary. The full click-by-click steps are in docs/mcp.md. In short:

1. Claude (Pro): open Settings, then Connectors, press Add custom connector, name it Billionaire, paste the MCP address, press Add, then Connect. A Billionaire page opens. Type MCP_OWNER_PASSWORD and press Allow.
2. Perplexity (Pro): on the website open Settings, then Connectors, press Add custom connector, choose Remote, paste the MCP address, pick OAuth, save, and sign in with the same password. If Perplexity asks for a client ID and secret, docs/mcp.md shows how to create them.

Write tools (changing categories, adding cash entries) stay off until you turn on "Let AI assistants make changes" in the app's Settings.

## What can go wrong

- "R2 is not turned on": do step 1.
- A 403 or "Authentication error" from Cloudflare: the token is missing a permission row from step 2, or it is limited to a different account. Fix the token, then run the workflow again.
- The app says the API token is wrong: APP_API_TOKEN in GitHub and the value typed into the app differ. Copy it again from your password manager. After changing it in GitHub, run the deploy again.
- Linked bank logins stopped working after you changed CREDENTIALS_SECRET: put the old value back, or link the accounts again.
