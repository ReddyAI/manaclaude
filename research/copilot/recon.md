# Recon map: Copilot Money (iOS, iPad, Mac, web)

Scope: transaction review with AI confidence, categories and rules, recurring, budgets, investments, cash flow, month and year in review, Amazon and Venmo connections.
For: the owner's personal finance app, own use only.
Date: 2026-11-04
Method: public sources only. Nothing was signed into. Pages were read one at a time at a normal pace; no crawling, no JavaScript bundles, no network captures.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Help center index | https://help.copilot.money/en/ | 15 collections, about 110 articles; 51 were read |
| 2 | Transactions overview | https://help.copilot.money/en/articles/9554412-transactions-tab-overview | search, filters, export |
| 3 | Copilot Intelligence for Spending | https://help.copilot.money/en/articles/8182433-copilot-intelligence-for-spending | per-user ML categorization, 30-review threshold |
| 4 | Transaction types | https://help.copilot.money/en/articles/3971267-transaction-types | income, internal transfer, regular |
| 5 | Name rules and bank category rules | https://help.copilot.money/en/articles/3971270-creating-name-rules and https://help.copilot.money/en/articles/13978302-bank-category-rules | |
| 6 | Splitting, tags, bulk edit, excluding | https://help.copilot.money/en/articles/5325255-splitting-transactions and /9554342-tags, /7668990-bulk-editing-transactions, /9718801-excluding-transactions | |
| 7 | Dot colors | https://help.copilot.money/en/articles/9834380-transaction-dot-color-guide | blue = needs review |
| 8 | Refunds, card payments, shared recurrings | https://help.copilot.money/en/articles/5325170-refund-and-reimbursement-transactions, /10671434-credit-card-payment-transactions, /5324776-shared-recurring-expenses | workaround patterns |
| 9 | Categories and budgets | https://help.copilot.money/en/articles/9504513-categories-tab-overview, /3767655-groups-of-categories, /3790828-budget-rollovers, /6206302-rebalancing-your-budget, /6282850-optional-budgeting, /6918427-understanding-key-metrics-for-spending, /11660741-tips-for-zero-based-budgeting | |
| 10 | Recurrings | https://help.copilot.money/en/articles/9778259-recurrings-tab-overview, /3760068-creating-recurrings, /3783499-optimizing-recurrings, /10671662-recurring-transaction-name | |
| 11 | Dashboard and cash flow | https://help.copilot.money/en/articles/6045480-dashboard-tab-overview, /5542019-income-vs-budget, /9682232-cash-flow-tab-overview | |
| 12 | Investments | https://help.copilot.money/en/articles/5377645-investments-tab-overview, /5497913-live-balance-estimates, /5497919-calculating-investment-performance, /10262766-investment-account-limitations | |
| 13 | Goals | https://help.copilot.money/en/articles/11470324-savings-goal-tab-overview, /11100511-spending-from-savings-goals | |
| 14 | Month and Year in Review | https://help.copilot.money/en/articles/10310024-month-and-year-in-review | |
| 15 | Amazon and Venmo | https://help.copilot.money/en/articles/5569639-amazon-integration, /3971255-venmo-integration-faq | |
| 16 | Money Assistant and MCP | https://help.copilot.money/en/articles/14462982-money-assistant-overview, /17678669-money-assistant-settings, /14758080-connecting-to-ai-tools | |
| 17 | Accounts, data sources, platforms | https://help.copilot.money/en/articles/6213732-accounts-tab-overview, /5593601-adding-and-managing-connected-accounts, /10768078-how-do-you-get-my-financial-data, /11780342-copilot-money-for-web, /8047816-real-estate-accounts, /6162313-crypto-support-with-copilot, /4523792-sharing-your-account-with-a-partner, /9834331-adding-widgets, /10715424-international-currency | |
| 18 | Marketing site | https://www.copilot.money/ | "iPhone, Mac, iPad, and Web", about 4.8 stars |
| 19 | App Store listing (screenshots live here; none committed) | https://apps.apple.com/us/app/copilot-track-budget-money/id1447330651 | Apple search API: rating about 4.75 from about 30,900 ratings on the day of research |

Not read: pricing page (selling is out of scope), changelog, videos.

## Core loop

New transactions arrive, a per-user model suggests categories, the owner reviews them (blue dot to cleared), and the Dashboard shows "free to spend" against the monthly budget.

## Screens

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Dashboard | tab | spending-progress chart with "left to spend", new transactions, trending categories, upcoming recurrings, net income, referral credits | line chart with ideal-pace dotted line, cards | budgeting on or off (off compares to last month) |
| S02 | Transactions | tab | list, search, filters, export, review | search field, filter chips, totals for filtered set (web), dots | filtered, empty |
| S03 | Transaction detail | tap a row | name, category, type, date, tags, notes, split, recurring link, original name | detail sheet, three-dot menu | tip dot, split mismatch dot |
| S04 | New transaction | "+" button | manual transaction or internal transfer | form | |
| S05 | Split | detail then Split | split by amount or percent, or equally; change date, name, category, type per split | mode toggle | red dot when sum is wrong |
| S06 | Bulk edit | multi-select | change category, mark reviewed, tags | bottom bar, keyboard shortcuts on Mac and web (X, R, C, F) | |
| S07 | Categories | tab | spend vs budget per category, bars colored by pace, groups | list, chart, Rebalance button | budget on or off |
| S08 | Category detail | tap a category | key metrics: total per year, average monthly spend, edit budget by month | metrics | |
| S09 | Category settings | menu | color, emoji, group, excluded flag, rollover | | |
| S10 | Rebalance preview | Rebalance Budgets | suggested budget changes; "only this month" or "this month and after" | preview sheet | |
| S11 | Recurrings | tab | paid vs left to pay this month, less frequent, archived; list or grid | cards, filters | |
| S12 | Recurring detail | tap | frequency, name filter, amount range, day window, category, linked transactions | editable underlined filters | paused, archived |
| S13 | New recurring | "+" | search a transaction, choose frequency, confirm | stepper | |
| S14 | Cash Flow | tab | income, spending, net income by period; bars tap to category and transaction detail | bar charts | excluded spend toggle |
| S15 | Investments | tab | returns or balances chart, holdings, benchmark, live estimate | chart, holdings list | no investment accounts |
| S16 | Savings Goals | tab | month or all-time goals chart, goal list by state | cards | Active, Ready to Spend, Archived |
| S17 | Goal detail | tap | contributions, allocations, update progress | | |
| S18 | Accounts | tab | net worth chart with timeframe, accounts grouped by type | graph, gear menu | |
| S19 | Connect or create account | "+" | link bank, create manual account, manual holdings, crypto address, property | | |
| S20 | Month in Review / Year in Review | end of Transactions tab at period end | shareable slides: spending, income, investments, trends | slide stack with share | legacy app icon unlock after year one |
| S21 | Money Assistant chat (iOS) | arrow button on any tab | chat, per-tab prompts, per-element launch | chat sheet | |
| S22 | Money Assistant settings | Settings, Features | toggle, personality, transaction fixes, proactive suggestions | | |
| S23 | Settings | gear | connections, features (budgeting, tags), notifications, subscription, export, 2FA, referral codes | | |
| S24 | Connections manager | Settings, Connections | add institution, reconnect, remove | | |
| S25 | Amazon connection | Settings | link one Amazon account per device | | |
| S26 | Venmo forwarding | Settings | forwarding email address per Venmo account | | |
| S27 | Widgets | home screen | Daily Spending and others | | |
| S28 | Login | email magic link, Apple, 2FA | | | |
| S29 | MCP connector setup | external AI tool | OAuth, read-only | | |

29 screens. Platform differences: Money Assistant iOS only; Venmo forwarding set up on iPhone, iPad or Mac; splitting flow redesigned on web first (June 2026).

## Flows

```
F01 Review new transactions
    S02 (blue dots) -> S03 confirm or change category -> option to create a name rule or bank-category rule -> marked reviewed
    happy path clicks: 1 (confirm) to 3 (change + rule)
    edge: shortcut keys on Mac and web, bulk mark reviewed (S06), model needs 30 reviewed transactions first

F02 Recategorize with a rule
    S03 tap category -> pick -> choose "apply to same exact name" or partial name or same bank category -> Create a Rule
    edge: "No thanks" updates one transaction only

F03 Set up recurring
    S11 "+" -> S13 search -> individual or all with that name -> confirm frequency -> S12 edit emoji, name, filters, category -> save
    edge: name varies each month (shorten match text), multiple recurrings for the same merchant, shared expense with reimbursement recurring

F04 Budget a month
    S07 -> edit category budget (applies to month or onward) -> optional rebalance (S10) -> rollovers on in settings
    edge: group budget with unassigned amount, budgeting disabled

F05 Handle a card payment
    leave both sides as Internal Transfer to avoid double counting; set the outgoing side to Regular to budget a historic balance

F06 Refund or reimbursement
    categorize refund in the original category, set its date to the original purchase date; or split a combined deposit

F07 Month in Review
    end of month S20 -> swipe slides -> share a slide

F08 Amazon item-level categories
    S25 connect once -> orders matched by amount within 2 days -> manual match option -> split by item

F09 Venmo
    S26 forwarding email -> receipts parsed in real time -> transactions created and matched

F10 Ask the assistant (iOS)
    S21 -> tab-specific prompt or typed question; assistant can view, create and delete name rules; proactive transaction fixes and idle-cash tips
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Transaction row with status dot | blue (needs review), gray (tip), red (split mismatch) | | S02 |
| Pace-colored category bar | green on pace, other colors as spend runs ahead | | S07 |
| Dashboard spending chart | solid actual line, dotted ideal line | | S01 |
| Benchmark selector | 8 ETFs | | S15 |
| Live balance estimate line (dashed) | on, off | | S15 |
| Emoji / Genmoji category icon | | | S07 |
| Month/year review slide | | | S20 |
| Widgets | Daily Spending and others | | S27 |

## Inferred data model

```
Transaction  id, account_id, date, amount, name (display), original_name, pending|posted, type (income|internal_transfer|regular),
             category_id, excluded, reviewed, tip_amount, notes, tags[], recurring_id, split_parent_id, bank_category
             evidence: S02, S03 export columns (Date, Name, Amount, Pending/Posted, Category and Parent Category, Excluded, Transaction Type, Account and Mask, Notes, Associated Recurrings)
             confidence: high
Category     id, name, emoji, parent/group, color, budget (per month), rollover_enabled, excluded
             evidence: categories collection; budget rollovers; groups with unassigned budget; confidence: high
BudgetMonth  category_id, month, amount; rollover start month; total budget; confidence: medium
Recurring    id, name, emoji, frequency (weekly|biweekly|monthly|non-monthly), name_filter, amount_min, amount_max, day_window, category_id, status (active|paused|archived), shared?
             evidence: S12, S13; confidence: high
Rule         kind (name_exact|name_partial|bank_category), match, category_id; confidence: high
Account      id, institution, mask, type, balance, source (plaid|mx|mastercard|akoya|direct|manual), hidden/closed; confidence: high
Holding      account_id, symbol, qty, price, value; Performance series (TWR-like, ignoring transfers); confidence: medium
Goal         id, name, target, state (active|ready_to_spend|archived), allocations[account_id, amount], contributions; confidence: medium
Tag          id, name; Transaction n-n Tag; no budget; confidence: high
PerUserModel inputs: transaction name, amount, day of week and similar; trained from reviewed transactions; confidence: medium (article truncated what else it uses)
Review artifacts  MonthInReview, YearInReview (derived); confidence: low
```

Relationships: Account 1-n Transaction; Category 1-n Transaction; Recurring 1-n Transaction; Transaction 1-n Transaction (splits); Transaction n-n Tag; Goal n-n Account.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Apple Design Awards polish, native Swift UI, widgets, Genmoji.
- Aggregator access: Plaid, MX, Mastercard, Akoya, and direct Apple, Capital One, Public and Coinbase integrations are contracts.
- Zillow Zestimates (licensed), Amazon order data through the owner's own login on a device.
- The trained model weights; only the idea (per-user model trained on reviewed transactions) can be reproduced.

## Size

Screens 29, flows 10, entities about 10. Hard parts: bank sync, per-user categorization model with confidence, recurring matching with fuzzy filters, investment performance (TWR-like), Amazon/Venmo matching. Size: L.

## Needs a signed-in account to confirm

Exact confidence display, rule-creation dialog copy, how pending is shown, the Month in Review slide list, goal funding rules, web feature gaps, and what the model uses beyond name, amount and weekday.
