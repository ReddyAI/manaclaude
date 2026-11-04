# Recon map: Sure (web, plus Flutter mobile companion and Tauri macOS shell)

Scope: every screen and flow, the data model, every provider and connector, imports, rules, budgets, recurring, investments and cost basis, AI assistant, insights, MCP and API.
For: the owner's personal finance app, built for their own use only. Not for sale.
Date: 2026-11-04
Method: reading the public repository at commit `6bcb6268d39ad08183201b24e2fd8479ef73062e` (the same commit as the earlier `rea.md`). Sure is AGPLv3, so reading its code and docs is allowed. This file records features and behavior. No code is copied, and anything we build from it should be written fresh. Nothing was run; no account, bank data or screenshots were used.

Companion files: `rea.md` and `features-chatgpt.csv` (earlier first pass, unchanged), `features.csv` (this pass), `reviews.csv` and `feedback.md`.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | README | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/README.md | positioning, hosting, clients |
| 2 | Roadmap | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/roadmap.md | three phases: stabilize, expand personal finance, open the platform |
| 3 | Routes | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/config/routes.rb | the authoritative list of screens and actions (about 1,090 lines) |
| 4 | Provider registry | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/provider/metadata.rb | 31 providers with region, kind and maturity |
| 5 | Schema | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/db/schema.rb | 154 tables |
| 6 | Hosting docs: AI, MCP, recurring bills | https://github.com/we-promise/sure/tree/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/hosting | ai.md, mcp.md, recurring-bills.md |
| 7 | LLM guides: goals, providers, architecture | https://github.com/we-promise/sure/tree/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/llm-guides | goals.md, providers.md, wealth-blueprint.md |
| 8 | API docs and OpenAPI | https://github.com/we-promise/sure/tree/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/api | generated from request specs |
| 9 | Clients overview | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/clients.md | web, macOS, mobile, agents, API |
| 10 | Onboarding guide | https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/docs/onboarding/guide.md | asset versus liability, first accounts |
| 11 | Models, controllers and views | https://github.com/we-promise/sure/tree/6bcb6268d39ad08183201b24e2fd8479ef73062e/app | 303 model files, 116 controller files; read for behavior |

Not reachable from this session: Sure's GitHub issues and discussions (the GitHub API and issue pages need repository access that was not granted). See `feedback.md` for the effect on the review sample.

## Core loop

Connect or import accounts, let transactions sync, categorize them (rules, then Bayes and LLM), and look at net worth, cash flow, budget and bills on one dashboard, with an assistant that can query and change the data.

## Screens

Counts come from routes and view folders. Mobile (Flutter) shows login and balances only.

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Sign up / sign in | `/registration/new`, `/sessions/new` | account creation, login; first user on a fresh install lands on create-account | email and password, SSO buttons (OIDC), passkey button, invite code field | empty, error, MFA step |
| S02 | MFA verify | `/mfa/verify` | TOTP code or WebAuthn key | code input, backup code, security key | error, locked |
| S03 | Password reset, email confirmation | `/password_reset/new`, `/email_confirmation/new` | recovery | email form | sent, expired |
| S04 | Onboarding: setup, preferences, goals, trial | `/onboarding`, `/onboarding/preferences`, `/onboarding/goals`, `/onboarding/trial` | name, country, currency, date format, theme, financial goals, trial | stepper | per-step |
| S05 | Dashboard | `/` | net worth chart, cash flow Sankey, outflows donut, balance sheet, insights feed | sections that can be reordered, hidden, collapsed, resized; period filter popover | no accounts, loading, filled |
| S06 | Cash flow (dashboard detail) | `/dashboard/cash_flow` | Sankey by category or by account | Sankey chart, filter | empty, filled |
| S07 | Accounts list | `/accounts` | accounts grouped by type, with sparklines and totals | account cards, group headers, sort mode, sync controls | empty, syncing, error |
| S08 | Account detail | `/accounts/:id` | balance chart, activity feed, holdings, statements | header, tabs (activity, holdings, statements), menu | manual, linked, disabled |
| S09 | New account type picker and per-type forms | `/accounts/new`, `/depositories/new`, `/investments/new`, `/properties/new`, `/vehicles/new`, `/credit_cards/new`, `/loans/new`, `/cryptos/new`, `/other_assets/new`, `/other_liabilities/new` | create manual accounts with type-specific fields | subtype dropdown, balance, currency, logo picker | validation errors |
| S10 | Property wizard | `/properties/:id/balances`, `/address` | purchase price, mortgage link, address, valuation refresh | address form, AVM refresh button | no provider, provider |
| S11 | Account sharing | `/accounts/:id/sharing` | per-member permission (full control, read/write, read only) | member list, permission select | solo household |
| S12 | Account statements vault | `/account_statements` | upload PDF, CSV, XLSX statements, match to accounts, coverage | upload zone, match suggestion, link/unlink/reject | duplicate upload, failed |
| S13 | Transactions list | `/transactions` | search, filters, bulk select, inline category, summary | table, filter bar, selection bar, pending badge, split parent rows | empty, filtered, pending |
| S14 | Transaction detail | `/transactions/:id` | edit name, date, amount, category, merchant, tags, notes, attachments, split, transfer match, convert to trade | drawer, attachments, notes | pending, split child, excluded |
| S15 | New transaction | `/transactions/new` | manual entry with name suggestions | form, combobox | error |
| S16 | Split transaction | `/transactions/:id/split/new` | divide into children that sum to parent | amount rows, remainder indicator | invalid total |
| S17 | Transfer match | `/transactions/:id/transfer_match/new` | pair two sides as transfer or card payment | candidate list | none found |
| S18 | Pending duplicate merge | `/transactions/:id/pending_duplicate_merges/new` | merge pending with posted | side-by-side | none |
| S19 | Bulk edit | `/transactions/bulk_update/new` | set category, merchant, tags, date for selection | form | partial permission |
| S20 | Categorize queue | `/transactions/categorize` | step through uncategorized transactions, with rule preview | card, assign, preview rule | queue empty |
| S21 | Categories | `/categories` | tree of categories, color, Lucide icon, lock, merge, bootstrap defaults | list, form, merge dialog, deletion dialog | empty, locked |
| S22 | Merchants | `/family_merchants` | list, edit, merge, enhance with AI | list, merge | empty |
| S23 | Tags | `/tags` | list, color, delete all | list | empty |
| S24 | Rules | `/rules` | rule groups, ordered rules, confirm and apply, apply all, clear AI cache | rule row, drag handle, group, activation toggle | empty, category CTA |
| S25 | Rule editor | `/rules/new`, `/rules/:id/edit` | nested conditions and actions, effective date, stop processing | condition builder, action builder | validation |
| S26 | Rule confirm | `/rules/:id/confirm`, `/rules/confirm_all` | preview matches before applying | match list | zero matches |
| S27 | Budgets | `/budgets/:month_year` | monthly plan, income vs spend, category budgets, donut, rollover, copy previous | donut, category groups, available-to-spend, over-allocation warning, owner switcher | not set up, over-allocated |
| S28 | Budget category edit | `/budgets/:month/budget_categories` | per-category amount, move allocation | slider, input | |
| S29 | Bills / recurring | `/bills` (views: upcoming, calendar, all, history, paycheck) | occurrences with status, month pulse, paycheck bridge | summary, series menu, state chips, drawer | empty (find recurring), suggested strip |
| S30 | Bill detail | `/bills/:id`, occurrence drawer | mark paid, skip, snooze, override amount, allocate payment | drawer, allocation list | overdue, cancelled |
| S31 | Recurring transactions settings | `/recurring_transactions` | identify patterns, cleanup, smart fill, pause, dismiss | list, form | disabled by family toggle |
| S32 | Goals | `/goals` | KPI strip, goal cards, filter chips, pending pledge callout | cards, progress ring, status pill | empty |
| S33 | Goal detail | `/goals/:id` | progress, projection chart, funding accounts, pledges | ring, D3 chart, breakdown | paused, completed, archived |
| S34 | Goal create / edit | `/goals/new` | two-step stepper: kind, target, accounts | stepper, color picker | currency warning |
| S35 | Pledge and consume | `/goals/:id/pledges/new`, `/goals/:id/consume` | promise a contribution; record spending from the goal | amount preview | expired pledge |
| S36 | Reports | `/reports` | trends and insights, transactions breakdown, budget performance, net worth, investment flows and performance, spending vs normal | period picker, breakdown table, collapsible sections | empty |
| S37 | Reports print and export | `/reports/print`, `/reports/export_transactions`, Google Sheets instructions | CSV and print view | | |
| S38 | Insights | `/insights` | generated insight cards, refresh, acknowledge | card list | none |
| S39 | Investments tab | account holdings tab, `/holdings`, `/trades` | holdings with cost basis, trades, activity labels | table, unlock cost basis, remap security | no holdings |
| S40 | Trade / holding forms | `/trades/new`, `/holdings/:id` | buy, sell, dividend, deposit, withdrawal; ticker lookup | form | manual ticker |
| S41 | Valuation | `/valuations/new` | manual balance reconciliation with confirm step | form, confirm | |
| S42 | Securities search | `/securities` | ticker lookup across price providers | combobox | |
| S43 | Imports index | `/imports` | history of imports with status | list | empty |
| S44 | Import wizard | `/imports/new` then upload, configuration, clean, confirm, summary | type pick, file upload, column mapping, row cleaning, mapping of accounts, categories, tags, publish | drag-drop overlay, mapping tables, row editor | failure, revert failure |
| S45 | QIF category selection | `/imports/:id/qif_category_selection` | pick categories from QIF | | |
| S46 | Providers settings | `/settings/providers` | cards per provider with maturity badge, health strip, connect drawer, sync all | search filters, status pill | not configured, connected, error |
| S47 | Provider connect panels | `/settings/providers/:key/connect_form` and per-provider screens | keys, tokens, OAuth, account selection, setup accounts | forms, step list | one panel per provider (31) |
| S48 | Settings: profile, preferences, appearance | `/settings/profile`, `/preferences`, `/appearance` | name, avatar, family, locale, currency, month start day, theme, layout | forms | |
| S49 | Settings: security | `/settings/security` | password, MFA, WebAuthn credentials, SSO identities | | |
| S50 | Settings: API keys and MCP | `/settings/api_keys`, `/settings/mcp` | scoped keys; OAuth tokens for agents | key list, revoke | none |
| S51 | Settings: hosting, AI prompts, classifier, LLM usage | `/settings/hosting`, `/ai_prompts`, `/classifier`, `/llm_usage` | provider keys, prompt overrides, Bayes tuning and evaluation, token usage | forms, tables | |
| S52 | Settings: guides, payment, subscription, debug, background jobs | `/settings/guides`, `/payment`, `/subscription`, `/debug`, `/background_jobs` | help, billing (hosted), support diagnostics | | |
| S53 | Family export / import | `/family_exports`, `/imports` (SureImport) | full data export zip, archived export link | list | cancelled |
| S54 | Invitations and invite codes | `/invitations`, `/invite_codes` | add household members | | |
| S55 | Chat sidebar and chats page | `/chats`, `/chats/:id` | AI assistant conversation, tool calls, retry | message list, thinking bubble, timeout report | busy, failed |
| S56 | Admin: SSO providers, users, families, invitations, system health | `/admin/*` | super admin tools | tables | |
| S57 | Changelog, release highlight, feedback, intro | `/changelog`, `/release_highlight`, `/feedback`, `/intro` | release notes | | |
| S58 | Design system (dev only) | `/design-system` | Lookbook component gallery | | |
| S59 | Mobile (Flutter) | iOS and Android app | login and account balances | | |
| S60 | macOS desktop shell (Tauri) | native window around the web app | server URL prompt, SSO via system browser | | |

Total: 60 screens (about 45 distinct user-facing, plus 31 provider panels counted once in S47).

## Flows

```
F01 First run
    S01 create account -> S04 onboarding (preferences, goals, trial) -> S05 empty dashboard -> S09 add first account
    happy path clicks: about 12
    edge: invite code required, SSO-only instance, email confirmation

F02 Add a manual account and record transactions
    S07 -> S09 pick type -> fill balance, subtype -> S08 -> S15 new transaction
    edge: liability sign convention, multi-currency, opening balance

F03 Connect a bank or broker
    S46 -> S47 provider panel (keys or OAuth) -> setup accounts (choose which to import) -> sync -> S07
    edge: link to existing manual account, unlink, repair, reauthorize (Enable Banking, TrueLayer), replacement suggestions (SimpleFIN), SCA keypair (Wise), device-flow login (SnapTrade), QR login (Trade Republic)

F04 Import a CSV
    S43 -> S44 upload -> configuration (columns, date format, number format, signage) -> clean rows -> mappings -> confirm -> publish -> summary
    edge: duplicates (see rea.md SURE-003), revert, PDF statement via AI, QIF, Mint, YNAB, Actual

F05 Review and categorize
    S13 -> S20 categorize queue -> assign -> preview rule -> create rule
    edge: locked categories, AI auto-categorize, Bayes, confidence threshold

F06 Create and run a rule
    S24 -> S25 -> S26 confirm -> apply
    edge: stop processing, one-time apply, rule from a transaction (prompt after categorizing)

F07 Split a transaction
    S14 -> S16 -> save -> children appear, parent excluded; undo restores
    edge: not available for transfers or pending (see SURE-002)

F08 Match a transfer or card payment
    automatic on sync (matcher) or manual S17; reject via rejected_transfers; mark as recurring from transfer
    edge: auto-match disabled per family

F09 Set a monthly budget
    S27 (bootstrap from previous month, or copy previous) -> set expected income -> allocate per category -> rollover per category
    edge: over-allocation warning, personal versus household budget, budget share with another member

F10 Bills and recurring
    sync/import -> detection (3 consistent occurrences) -> suggested strip -> confirm or dismiss -> occurrences (paid, skipped, snoozed) -> iCal feed
    edge: price change detection, weekend adjust, autopay, trial end, installments

F11 Goals
    S34 -> S33 -> S35 pledge -> next sync reconciles the pledge against a matching transfer or valuation (15-minute sweep expires pledges)
    edge: maintained goals, months-of-expenses target, pause, archive, reopen

F12 Investments
    connect broker -> holdings and trades import -> cost basis reconciled (manual > calculated > provider) -> performance in reports
    edge: unlock cost basis, remap security, price sync, convert a transaction to a trade

F13 Ask the assistant
    S55 -> question -> tool calls (accounts, transactions, budgets, holdings...) -> answer; can also create rules, categories, goals, bills, and import a statement
    edge: external assistant via MCP, mcp_only mode, busy queue, timeout report

F14 Statement vault
    S12 upload -> metadata detection and account matching -> link -> optional PDF import -> coverage view
    edge: duplicate checksum, 25 MB cap

F15 Share an account
    S11 -> choose member and permission -> member sees account with limited edit rights

F16 Export everything
    S53 request export -> background job -> download or archived link

F17 Connect an AI agent
    S50 -> OAuth dynamic registration or static token -> agent calls MCP tools
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Sidebar nav (collapsible) and AI sidebar | left nav, right chat | open, closed, mobile | all |
| Dashboard section card | cashflow Sankey, outflows donut, net worth chart, balance sheet, insights feed | collapsed, hidden, resized, reordered | S05 |
| Period picker | month, quarter, year, custom | | S05, S36 |
| Transactions table | inline category editor, pending badge, split parent row, selection bar | selected, filtered | S13 |
| Entry drawer (modal) | transaction, trade, valuation | edit, read-only (shared) | S14, S39, S41 |
| Combobox | category, merchant, tag, security | search, create-new | many |
| Sankey, donut, line, sparkline (D3) | | hover tooltips | S05, S06, S36, S33 |
| Progress ring and status pill | on track, behind, paused, complete | | S32, S33 |
| Provider logo | Brandfetch icon, initials fallback | | S46 |
| Maturity badge | stable, beta, alpha | | S46 |
| Stepper | goal create, onboarding | | S34, S04 |
| Toast and release highlight banner | | dismissed | all |
| Lucide icon and color pickers | | | S21, S34 |
| Drag handle list | rules, dashboard sections | | S24, S05 |

## Inferred data model

Verified from `db/schema.rb` (154 tables). Core entities below; provider tables follow one pattern (see end).

```
Family          name, currency, locale, country, timezone, date_format, month_start_day,
                assistant_type (builtin|external|mcp_only), categorization_provider,
                categorization_confidence_threshold, bayes_settings, ai_prompt_overrides,
                auto_match_transfers_disabled, personal_budgets, household_budget_enabled,
                investment_contributions_as_spending, recurring_transactions_disabled,
                bills_feed_token, enabled_currencies, default_account_sharing
                evidence: schema families; hosting/ai.md; confidence: high
User            email, role (guest|member|admin|super_admin), preferences json (dashboard order,
                hidden, collapsed, layout), theme, ui_layout, otp_*, ai_enabled, default_period
                evidence: schema users; user.rb; confidence: high
Account         name, balance, cash_balance, currency, classification (asset|liability, derived),
                accountable (delegated type), subtype, status (draft|active|disabled),
                exclude_from_reports, owner_id, institution_name/domain, locked_attributes json
                evidence: schema accounts; confidence: high
  Accountable types: Depository (cash, checking, savings, hsa, cd, money_market),
                Investment (brokerage, 401k, roth_401k, 403b, 457b, tsp, ira, roth_ira, sep_ira,
                simple_ira, 529_plan, hsa, plus non-US subtypes), Crypto (wallet, exchange),
                Property (10 subtypes; area, year built, AVM id and provider),
                Vehicle (make, model, year, mileage), Loan (mortgage, student, auto, home_equity,
                line_of_credit, business, other; rate, term, rate_type, insurance, variable schedule),
                CreditCard (apr, limit/available credit, due day, statement close day, minimum payment,
                annual fee), OtherAsset, OtherLiability
Entry           account_id, date, name, amount (decimal 19,4), currency, notes, excluded,
                entryable (Transaction | Trade | Valuation), parent_entry_id (splits),
                source, external_id, idempotency_key, import_locked, user_modified, locked_attributes
                reconciled_at, reconciled_by_statement_id
                evidence: schema entries; rea.md SURE-002/004/006; confidence: high
Transaction     kind (standard|funds_movement|cc_payment|loan_payment|one_time|investment_contribution),
                category_id, merchant_id, tags (via taggings), investment_activity_label, extra json
                (provider namespaces, pending flags), transfer_id, attachments
Trade           security_id, qty, price, fee, currency, investment_activity_label
                (Buy, Sell, Sweep In/Out, Dividend, Reinvestment, Interest, Fee, Transfer,
                Contribution, Withdrawal, Exchange, Other)
Valuation       kind (reconciliation | opening | current), locked_attributes
Holding         account, security, date, qty, price, amount, cost_basis, cost_basis_source
                (manual|calculated|provider), cost_basis_locked, security_locked
Security        ticker, name, exchange_mic, country, asset_class/sub_class, sector, industry,
                price_provider, offline, failed_fetch_count; SecurityPrice, SecuritySplit
Balance         account, date, balance, cash_balance, flows (cash and non-cash inflows/outflows,
                market flows, adjustments) - a daily series per account
Category        name, color, lucide_icon, parent_id (one level), classification_unused; family.categories_locked
Merchant        FamilyMerchant (user) and ProviderMerchant (from data providers), logo_url, website
Tag/Tagging     name, color
Transfer        inflow_transaction, outflow_transaction, status (pending|confirmed); RejectedTransfer
Rule            resource_type, position, active, effective_date, stop_processing, rule_group;
                RuleCondition (nested via parent_id; type, operator, value); RuleAction (type, value);
                RuleRun history
Budget          start/end date, budgeted_spending, expected_income, currency, user_id (null = household)
BudgetCategory  budgeted_spending, rollover_enabled, rolled_over_amount; BudgetShare
RecurringTransaction  name, amount, expected min/avg/max, amount_strategy (fixed|average|last),
                tolerance, anchor date, expected_day_of_month, bill_type (bill|subscription|installment|...),
                status (suggested|active|paused|cancelled...), autopay, end_mode, weekend_adjust,
                holiday_calendar, match window days, notify_days_before, payment_url, renews_on,
                trial_ends_on, dedup_scope, matcher_hints json, replaced_by
RecurringOccurrence   due_on, original_due_on, expected_amount, status, snoozed_until, closed_source
RecurringAllocation   entry_id, allocated_amount, match_confidence, match_signals, state
RecurringPriceChange, RecurringMatchRejection
Goal            name, kind (one_off|maintained), target_mode (fixed|months_of_expenses), target_amount,
                target_date, state (active|paused|completed|archived), progress_basis, color, icon;
                GoalAccount; GoalPledge (amount, kind, status, expires_at, matched_transaction)
Insight         insight_type, priority, title, body (template text), facts json, status, dedup_key
Import          type (12 subclasses), status, column label mappings, date/number format, signage,
                rows; ImportRow; ImportMapping; ImportSession (chunked API upload)
AccountStatement   original_file, checksum, source, upload_status, account match, coverage
Chat/Message/ToolCall  assistant conversation, tool-call log; LlmUsage (tokens, cost)
ApiKey, OAuth tokens (Doorkeeper), MobileDevice, PushSubscription, NotificationDelivery
Sync            per account/item/family sync runs with status; ProviderRequestCount
Provider item/account tables (x31)  <provider>_items (credentials, status, sync cursor) 1-n
                <provider>_accounts (raw payload) 1-1 AccountProvider -> Account (n providers per account)
```

Relationships: Family 1-n User, Account, Category, Merchant, Tag, Rule, Budget, Goal, RecurringTransaction, Import; Account 1-n Entry; Entry 1-1 Transaction|Trade|Valuation; Entry 1-n Entry (split children); Account 1-n Holding, Balance; Account n-n Goal; Account n-n User (AccountShare); Transaction n-n Tag; Transfer pairs two Transactions; RecurringOccurrence n-n Entry via RecurringAllocation.

## Providers and connectors (31 in the registry)

Region, kind, maturity as declared in `Provider::Metadata`. Behavior notes come from routes and `docs/providers`.

| provider | region | kind | maturity | connect flow notes |
| --- | --- | --- | --- | --- |
| Plaid (US), Plaid EU | US, EU | bank | stable (paid tier) | link token flow; webhooks `/webhooks/plaid`, `/plaid_eu`; pending linking id |
| SimpleFIN | US | bank, investment | stable | setup token claimed; balances refresh action; replacement-suggestion dismissal; pending detection by posted=0 |
| Lunch Flow | global | bank | stable | API key; preload, select, link accounts |
| Enable Banking | EU | bank | beta | choose bank, authorize redirect, callback, reauthorize, new connection |
| TrueLayer | UK | bank | alpha | connect redirect, callback, reauthorize |
| Sophtron | US | bank, investment | alpha | connect institution, manual sync toggle, connection status, MFA submit |
| Akahu | NZ | bank, investment | beta | personal tokens |
| Up | AU | bank | beta | token |
| Redbark | AU | bank | beta | token |
| Monobank | UA | bank | alpha | token; hold = pending, settles under a different id |
| Fio banka | CZ | bank | alpha | token |
| Mercury | US | bank | beta | API key |
| Brex | US | bank | beta | API token |
| Wise | global | bank | beta | profiles, SCA keypair generation, statements and activities |
| Apple Wallet (FinanceKit) | US/UK | bank | beta | on-device batches pushed by the iOS app via `/api/v1/financekit`; conflicts endpoint |
| SnapTrade | US/CA | investment | beta | OAuth redirect or device flow, connections list, delete connection |
| Questrade | CA | investment | beta | token; link accounts |
| Interactive Brokers (IBKR) | global | investment | beta | Flex Web Service query |
| Trading 212 | EU | investment | alpha | API key |
| Trade Republic | EU | bank, investment | beta | phone login with two-phase confirm, QR login, repair |
| Indexa Capital | ES | investment | alpha | token |
| Coinbase | global | crypto | beta | API key |
| Binance | global | crypto | beta | API key |
| Kraken | global | crypto | beta | API key |
| CoinSpot | AU | crypto | beta | API key |
| CoinStats | global | crypto | beta | link wallet or exchange through CoinStats |
| On-chain wallets | global | crypto | alpha | paste address, preview, review tokens, enable crypto prices; explorers include Etherscan/EVM, Blockscout, mempool.space, Solana RPC, Cosmos REST, Polkadot sidecar |
| RentCast | US | property valuation | beta | AVM estimate for a property |
| Realie | US | property valuation | beta | AVM |
| Chimnie | UK | property valuation | beta | AVM |

Market data (not account connectors): securities prices from Tiingo, Twelve Data, EODHD, Yahoo Finance, Alpha Vantage, MFAPI (India mutual funds), MOEX, T-Invest; exchange rates from Frankfurter. Classification and AI: OpenAI-compatible, native Anthropic, and Jev (categorization only).

## Imports (12 types)

TransactionImport (CSV), TradeImport (CSV), AccountImport (CSV), MintImport, ActualImport, YnabImport, QifImport, PdfImport (AI extraction of bank, card and investment statements and contracts), CategoryImport, MerchantImport, RuleImport, SureImport (Sure's own export). Chunked API uploads through `import_sessions`; a preflight endpoint validates a file before upload.

## Rules

Resource: transactions. Conditions (nestable): name, amount, type, merchant, category, tag, details, notes, account. Actions: set category, set tags, set merchant, set name, set investment activity label, exclude, set as transfer or payment, split transaction, send email notification, fill similar merchants, Bayes categorize, AI auto-categorize, AI detect merchants (AI actions only offered when a provider is configured). Rule groups with activation; ordered rules; `stop_processing`; `effective_date`; confirm-before-apply preview; apply one or all; clear AI cache; rule run log; safe regex handling.

## Budgets

Monthly budget with a configurable month start day. Expected income, per-category amounts, per-category rollover, copy previous month, bootstrap from history, over-allocation warning, available-to-spend and available-to-allocate figures. Personal budgets per member and a shared household budget can coexist; a member can share a budget view with another. Category spending nets refunds with a floor of zero (SURE-005). Transaction kinds decide inclusion; investment contributions can be treated as spending by a family switch.

## Recurring and bills

Detection clusters history by merchant or name, amount within tolerance and consistent day; three consistent occurrences make a series. New series are `suggested` until confirmed; dismissal leaves a tombstone. Pipeline runs after each sync/import (debounced 30 s) and nightly. Views: upcoming, calendar, all, history, paycheck (bills due before next payday, with shortfall and bridge). Occurrences can be marked paid, skipped, snoozed, amount-overridden, or allocated across entries (including cross-currency, with match confidence). Price-change detection. iCal feed with a resettable token. AI shortcuts: review, smart fill, smart configuration (blocked in `mcp_only`). Per-family disable.

## Investments and cost basis

Accounts hold Holdings (daily snapshots) computed forward or reverse from Trades and provider data. Cost basis source priority: manual, then calculated, then provider; a locked basis is never overwritten; a zero provider basis is treated as unknown. Users can unlock basis, remap or reset a holding's security, and sync prices. Tax treatment per Investment subtype (taxable, tax-deferred, tax-exempt, tax-advantaged) drives badges and cash-flow filters. Activity labels classify trades; internal movements (transfer, sweep in/out, exchange) are excluded from budget. Reports include investment performance and investment flows.

## AI assistant

Three modes: builtin (LLM with function tools), external (a remote agent calls back via MCP), `mcp_only` (no in-app chat). Builtin tools (about 40): accounts, balance sheet, income statement, transactions, uncategorized transactions, categories, tags, merchants, budget, holdings, valuations, insights, rules (get, options, preview, create, apply), bills (get, details, audit, create, record payment), recurring, goals (create), paycheck plan, transfer match candidates and review/match, create or delete categories/tags/transactions, set opening balance, record valuation, statement tools (list, get, coverage, import bank statement), search family files (vector store). Token budgeting and history trimming. Separate AI lane in the job queue; chat reservation holds back background AI for 60 s. Langfuse tracing and LLM usage page. Consent toggle per user.

Background AI: auto-categorization with a confidence threshold and shadow-rate evaluation, Bayes categorizer with its own evaluation and weight tuning, merchant detection and enhancement, PDF statement extraction. Insights never use AI; their text comes from templates.

## Insights (8 generators)

Budget, cash-flow warning, idle cash, maintained-goal depleted, net-worth milestone, savings-rate change, spending anomaly, subscription audit. Each has priority, dedup key, acknowledge and refresh.

## API and MCP

REST API v1 (OpenAPI generated from request specs): accounts, balances, budgets, budget categories, categories, merchants, rules, rule runs, securities, security prices, tags, transactions (+ split), trades, holdings, transfers, rejected transfers, valuations, recurring transactions, family exports, imports (+ preflight, rows), import sessions (chunked), usage, cash flow, spending vs normal, balance sheet, insights, push subscriptions, family settings, syncs, provider connections, chats and messages, auth (signup, login, refresh, SSO exchange/link/create), currencies, user reset. Scopes: read, read_write. Credentials: scoped API keys or OAuth (Doorkeeper). MCP at `POST /mcp` with OAuth dynamic client registration (`/.well-known/*`, `/register`) or a static bearer token pinned to one user; tools include write operations.

## Security and administration

Password plus TOTP MFA with backup codes, WebAuthn security keys, passwordless passkeys, OIDC SSO with audit log and identity blocks, desktop and mobile SSO hand-off with PKCE, rate limiting, impersonation sessions with logs (support), invite codes, roles (guest, member, admin, super_admin), encrypted provider credentials, Pipelock scan in CI, web push and notification deliveries, system health page (queue, AI lane, worker AI check), Sidekiq UI for super admins.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Hosted-service billing (Stripe subscription, trial) and the Maybe trademark.
- Brandfetch logos, provider logos and institution data (third-party assets).
- Provider API credentials and data-provider contracts: Plaid, SimpleFIN and the others each need the owner's own keys, and some (Plaid) are paid.
- AGPL code itself: build from behavior, not by copying.
- The Apple Wallet (FinanceKit) path needs an iOS app and an Apple entitlement.

## Size

Screens 60, flows 17, entities about 45 core (154 tables), providers 31. Hard parts: provider sync with idempotency and pending-to-posted reconciliation; multi-currency balance history with daily materialization; holdings and cost basis; recurring detection and matching; rules engine with AI actions; assistant tool surface with safe writes. Size: XL for the whole product; L for the core without providers and AI.

## What can't be confirmed from source alone

Visual design, empty-state copy, real latency, provider reliability, AI answer quality, and cross-month refund behavior. The earlier `rea.md` lists the same limits.
