# MCP server: connect Claude and Perplexity

The Worker runs a remote MCP server at `/mcp` so your own Claude and Perplexity accounts can read your finance data. It speaks Streamable HTTP and signs in with OAuth 2.1 (dynamic client registration, PKCE), using Cloudflare's `workers-oauth-provider`. There is one user, you, so the sign-in page asks for one thing: the owner password you set as the `MCP_OWNER_PASSWORD` Worker secret.

The server URL is `https://manaclaude-api.<your-subdomain>.workers.dev/mcp` (the `PUBLIC_URL` variable plus `/mcp`).

## Tools

Read tools are always on:

| Tool                  | What it returns                                                                        |
| --------------------- | -------------------------------------------------------------------------------------- |
| `list_accounts`       | Accounts with type, currency, balance and when the balance was read                    |
| `search_transactions` | Transactions by text, dates, account or category, newest first                         |
| `spending_summary`    | Spending and income for a date range by category, in one currency, using your policies |
| `budget_status`       | Each category budget for a month: budgeted, spent, left                                |
| `holdings_with_lots`  | Positions with value, cost basis, unrealized gain and every open lot                   |
| `net_worth_history`   | Net worth by date, converted with each date's rate                                     |
| `list_recurring`      | Bills, subscriptions and income with next due date and price history                   |
| `search_receipts`     | Receipts by merchant or line item, with totals and the matched transaction             |

Write tools are a separate group and are off by default:

| Tool                     | What it does                                                      |
| ------------------------ | ----------------------------------------------------------------- |
| `categorize_transaction` | Sets a category (counts as your edit and teaches the categorizer) |
| `add_cash_transaction`   | Adds cash spending to the default cash account for that currency  |
| `tag_transaction`        | Adds a tag                                                        |
| `link_transfer`          | Links two transactions as a transfer between your accounts        |

An assistant only sees the write tools when both of these are true: Settings > AI > "Let AI assistants make changes" is on, and the connection was approved with the `write` scope (the default when the assistant doesn't ask for a narrower scope). Write tools are marked as not read-only, so Claude asks you before each call. Every amount comes back as minor units, a currency and a formatted string (`{"minor": 20000, "currency": "USD", "formatted": "$200.00"}`), so an assistant can't misread cents.

## Before you connect

1. Deploy the Worker and set its secrets (see "Cloudflare setup" in [backend-plan.md](backend-plan.md)). `MCP_OWNER_PASSWORD` must be set; without it the sign-in page refuses.
2. Set the `PUBLIC_URL` repository variable (or the value in `backend/wrangler.toml`) to your workers.dev URL and deploy again. OAuth tokens are bound to `PUBLIC_URL/mcp`.
3. Check it from a terminal. This walks the same OAuth flow the assistants use and lists the tools:

```bash
cd backend && npm run smoke:mcp -- https://manaclaude-api.<your-subdomain>.workers.dev <your-owner-password>
```

## Claude (Pro)

These steps follow Anthropic's help article on [custom connectors with remote MCP](https://support.claude.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers). The feature is marked beta, so labels may move.

1. On claude.ai or Claude Desktop, open Settings > Connectors.
2. Click "Add custom connector".
3. Name it "Mana" and paste the server URL ending in `/mcp`. Leave "Advanced settings" empty; Claude registers itself.
4. Click "Add", then "Connect". A Mana page opens: type your owner password and press Allow.
5. In a chat, open the tools menu and turn Mana on. Ask something only your data can answer, like "What did I spend on restaurants last month?"
6. If you turn on write tools later, open the connector's settings in Claude to choose which tools need approval. Leave them on "needs approval".

Claude Desktop only adds remote servers through Settings > Connectors, not through `claude_desktop_config.json`.

## Perplexity (Pro)

Perplexity doesn't have an official help page for this that I could find; these steps come from third-party guides and a community bug report, so check the labels in the app.

1. On perplexity.ai (web or desktop, not the phone app), open Settings > Connectors.
2. Click "+ Custom connector" and choose Remote.
3. Name it "Mana", paste the server URL ending in `/mcp`, and pick OAuth as the sign-in method.
4. Save. A Mana page opens in the browser: type your owner password and press Allow.
5. In a new thread, turn Mana on in the sources menu and ask a question about your accounts.

If Perplexity says the server did not return a client secret, or asks for a client ID and secret, create a confidential client and paste both into the connector's advanced settings. Use the redirect (callback) URL Perplexity shows in that form:

```bash
curl -X POST https://manaclaude-api.<your-subdomain>.workers.dev/v1/mcp/clients \
  -H "Authorization: Bearer <APP_API_TOKEN>" \
  -H "content-type: application/json" \
  -d '{"name":"Perplexity","redirectUris":["<callback URL Perplexity shows>"]}'
```

The secret is shown once. The same endpoint works for Claude's "Advanced settings" if it ever needs one.

## ChatGPT

OpenAI lists custom connectors for Business and Enterprise/Edu plans. The server follows the same standard, so it should work wherever ChatGPT allows a custom remote MCP server; test on Plus before relying on it.

## Security notes

- Access tokens last an hour and refresh tokens 30 days. Grants and tokens live in the `OAUTH_KV` namespace; tokens are stored hashed.
- Ten wrong passwords from one IP in an hour block further tries for that hour.
- The app's `/v1` API uses a separate bearer token (`APP_API_TOKEN`). An MCP token can't call `/v1`, and the app token can't call `/mcp`.
- To cut an assistant off, remove the connector in the assistant. To cut every assistant off at once, change `MCP_OWNER_PASSWORD` and delete the `grant:` keys in `OAUTH_KV` (Cloudflare dashboard > Storage > KV).

## Testing locally

`npm run dev -w @manaclaude/backend` serves the Worker on http://localhost:8787 with a local D1 database. Put `MCP_OWNER_PASSWORD` in `backend/.dev.vars` (copy `.dev.vars.example`), then:

```bash
cd backend && npm run smoke:mcp -- http://localhost:8787 <password from .dev.vars>
```

`backend/test/mcp.test.ts` runs the full flow in CI: client registration, the consent page with a wrong and a right password, PKCE token exchange, then the official MCP SDK client lists and calls tools and checks that write tools appear only when allowed.
