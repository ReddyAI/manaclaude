# How to run sessions A to E

Written November 5, 2026. Budget plan: about $65 for A to E including fixes; top up with your own money only if E needs it.

## Before you start (optional, 15 minutes)

1. Open the Android APK run while signed in to GitHub: https://github.com/ReddyAI/manaclaude/actions/runs/41939362151
2. Download `mana-android-apk`, unzip it, and install the `.apk` on your phone.
3. Look at the three looks (Midnight, Warm, Compact), the tab bar, the dashboard and the text sizes. Write down what you'd change in plain words.
4. Feedback about the dashboard, transactions, accounts, colors or fonts goes at the end of A's message. Feedback about budgets, recurring or net worth goes at the end of C's.

## Step 1: merge the two open pull requests

1. Open https://github.com/ReddyAI/manaclaude/pull/2, scroll down, click "Merge pull request", then "Confirm merge".
2. Open https://github.com/ReddyAI/manaclaude/pull/1 and do the same.

Merge #2 first. The two don't touch the same files, so #1 still merges cleanly afterwards.

## Step 2: start sessions A, B, C and D

| Session | Environment | Model      | Effort | Permission mode |
| ------- | ----------- | ---------- | ------ | --------------- |
| A       | Default     | Sonnet 5.5 | High   | Auto            |
| B       | Default     | Opus 5.5   | High   | Auto            |
| C       | Default     | Sonnet 5.5 | Medium | Auto            |
| D       | Default     | Sonnet 5.5 | High   | Auto            |

Do this once for each session:

1. Start a new Claude Code session.
2. Repository: ReddyAI/manaclaude, branch `main`.
3. Environment: Default (not Research).
4. Model and effort from the table. Permission mode Auto, like your first two sessions, so it doesn't stop to ask for approvals.
5. Open https://github.com/ReddyAI/manaclaude/blob/main/docs/parallel-sessions.md, find that session's gray box, click the copy icon at its top right, and paste it into the message.
6. Leave a blank line and paste that session's add-on from the bottom of this file.
7. For A and C, add your feedback from the app at the end.
8. Send.

All four run at the same time. Each one ends by opening a pull request that lists what it built and the defaults it picked.

## Step 3: while they run

Nothing to do. After about an hour, check your usage. If one session is spending much faster than the others, open it and stop it.

## Step 4: merge each pull request

1. Open the pull request link the session gives you.
2. Wait for "All checks have passed". The Android check takes about 15 minutes.
3. Click "Merge pull request", then "Confirm merge".
4. If B and D are both ready, merge D first; B uses D's sync code.
5. After a merge, the other open pull requests may say "This branch has conflicts that must be resolved". Send this to that session, then merge when its checks are green again:

```text
Main has changed. Rebase your branch on main, fix the conflicts (for package-lock.json take main's copy and run npm install), run npm run check, and push.
```

6. If a check fails, send this to that session:

```text
A check failed on your pull request. Find out why, fix it, run npm run check, and push.
```

## Step 5: before session E

1. Sign up for the free accounts E needs: Cloudflare, Teller, Plaid, SnapTrade, Sophtron and Open Exchange Rates. Zerodha Kite, Coinbase and WazirX keys can wait until E asks. Never paste a key into a chat or into GitHub.
2. Ask Claude for session E's prompt once A to D are merged. It should be written from what they actually built.
3. E: Opus 5.5, high effort. The Default environment blocks api.cloudflare.com and sandbox.plaid.com (checked November 5), so E will probably need hosts added under the environment's Network access settings. E's prompt should list them.

## Add-ons

### Session A

```text
Changes for this run. Where they differ from the prompt above, these win.
1. My budget is tight. Do the Playwright checks only at 412 px in Midnight dark and at 1440 px in Compact light. Don't screenshot every look and mode.
2. research/README.md is now on main. From its complaints list: show a banner on the Dashboard and the Accounts screen when any connection is needs_repair or error, or hasn't synced in 24 hours, with its last sync time. Keep validateSplit's rule that pending transactions can't be split, but let me change the category and notes on a pending transaction.
```

### Session B

```text
Changes for this run. Where they differ from the prompt above, these win.
1. My budget is tight, so this run builds only: the Worker, the D1 schema and the app API; the five build checks as passing tests; CSV, OFX and QIF imports; PDF statement import with AI extraction, the preview and confirm step, and the statement vault; the AI provider layer only as far as PDF extraction needs it, including the switch that stops every AI call; categories, rules, splits, transfer matching, cash accounts and ATM withdrawals; FX rates and the conversion helper; and the MCP server with OAuth and the read tools only.
2. The backend will hold my real bank data on the public internet, so every /v1 endpoint must require sign-in. I'm the only user. Pick a free, simple method that works from the Android app and the web app, document it in docs/backend-plan.md, and add tests that every endpoint rejects a request without valid sign-in.
3. Add an API mode to the app's data store (apps/mobile/src/data, additive change): when Settings has a backend URL and I'm signed in, load from GET /v1/dataset and send changes to the API; otherwise keep the sample data. Add a Backend section in Settings for the URL and sign-in.
4. Leave these for a later session and list them in the pull request as not started: MCP write tools, the AI jobs (categorization learning, merchant cleanup, recurring and duplicate alerts, recap text), receipts (R2 upload, vision extraction, matching), and the Sure NDJSON and Actual Budget imports.
5. From research/README.md: a category I set by hand must never be overwritten by a sync, an import, a rule run or AI. Add a test for it.
```

### Session C

```text
Changes for this run. Where they differ from the prompt above, these win.
1. My budget is tight. Build budgets with rollover and the Spending Plan, recurring and subscriptions, net worth and investments with lots, and the USD/INR display logic. Leave planning (retirement and FIRE projection, goals) and the recap screens for a later session and list them in the pull request as not started.
2. Do the Playwright checks only at 412 px in Midnight dark and at 1440 px in Compact light. Don't screenshot every look and mode.
3. From research/README.md: show actual spending for every category, including categories with no budget.
```

### Session D

```text
Changes for this run. Where they differ from the prompt above, these win.
1. My budget is tight, so this run builds adapters only for Teller, Sophtron, Plaid, SnapTrade Personal, Zerodha Kite Connect Personal, Coinbase and WazirX, plus Yahoo Finance for market data. Build all of item 3 (the pure sync functions) and item 4 (slots, health, repair). Every other connector stays in the registry with its details; list them in the pull request as not built yet.
2. Read Sure by cloning it into a scratch folder outside this repo: git clone --depth 1 https://github.com/we-promise/sure. An earlier session wasn't allowed to attach it with add_repo; the public clone works.
3. From research/README.md, add tests for: each provider's sign conversion; a replaced card (new card number, same account) must not duplicate history; a category edited while a transaction is pending survives when the posted version arrives; every connection reports lastSyncAt and status so the app can warn about stale connections.
4. Add the server side of linking a new account for the seven connectors above, as optional methods on ConnectorAdapter (additive change in packages/shared/src/model/connector.ts): for example Teller storing the access token that Teller Connect returns, Plaid creating a link token and exchanging the public token, SnapTrade registering the user and creating a connection portal link, and key entry for Zerodha Kite, Coinbase and WazirX. Test them against invented responses. The app screens that use them come in a later session.
```
