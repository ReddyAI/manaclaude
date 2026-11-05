# Recon map: Monarch Money (web and Android; iOS shares the flows)

Scope: dashboard widgets, accounts and connections, transactions and review, rules, splits, budgets including Flex, recurring, reports including Sankey cash flow, goals, investments, receipt scanning, the Amazon/Target retail sync extension, AI assistant, weekly recap, Month in Review.
For: the owner's personal finance app, own use only.
Date: 2026-11-04
Method: public sources only. Nothing was signed into. Monarch's help center (`help.monarch.com`) answers automated requests with a bot-check page, so it was not read directly and nothing was done to get around that. This map comes from pages on `monarch.com` that load normally (feature pages, nine product-update posts) and from search-engine summaries of help-center articles. Items that rest only on search summaries are marked "(summary)" and carry medium or low confidence.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Tracking, Budgeting, Planning, Couples pages | https://www.monarch.com/features/tracking, /features/budgeting, /features/planning, /for-couples | read |
| 2 | What's New index | https://www.monarch.com/whats-new | read; ten posts listed |
| 3 | MCP announcement | https://www.monarch.com/blog/monarch-mcp | read |
| 4 | October update (assistant "Savings found", MCP, exclude filters) | https://www.monarch.com/blog/october-product-update | read |
| 5 | September update (switch data provider, faster assistant, sort by balance) | https://www.monarch.com/blog/september-product-update | read |
| 6 | August update (treemap reports, early-retirement forecasting, pending edits preserved) | https://www.monarch.com/blog/august-product-update | read |
| 7 | July update (email receipt forwarding, activity log, investments view) | https://www.monarch.com/blog/july-product-update | read |
| 8 | June update and Goals | https://www.monarch.com/blog/june-product-update and /blog/goals | read |
| 9 | Monarch Plus and Forecasting | https://www.monarch.com/blog/monarch-plus and /blog/forecasting | read |
| 10 | Pricing page (features per tier only; prices not used) | https://www.monarch.com/pricing | read |
| 11 | Flex budgeting (summary) | https://www.monarch.com/blog/flex-budgeting-simplify-your-spending-with-just-one-number and https://help.monarch.com/hc/en-us/articles/360048883631-Creating-Your-Budget-in-Monarch | search summary only |
| 12 | Retail Sync extension (summary) | https://help.monarch.com/hc/en-us/articles/36463599367188-Using-the-Retail-Sync-Extension and https://www.monarch.com/blog/monarch-extension-for-target and the Chrome Web Store listing https://chromewebstore.google.com/detail/monarch-money-retail-purc/imfcckkmcklambpijbgcebggegggkgla | search summary only |
| 13 | Transaction review, rules, splits, hidden (summary) | https://www.monarch.com/blog/transaction-review, https://help.monarch.com/hc/en-us/articles/360048393372 (Creating Transaction Rules), https://help.monarch.com/hc/en-us/articles/360050178492-Splitting-Transactions, https://help.monarch.com/hc/en-us/articles/4405041904916 (Hiding or Unhiding), https://www.monarchmoney.com/review-on-the-go-and-smart-split | search summary only |
| 14 | Recurring, Sankey, monthly progress report (summary) | https://www.monarch.com/blog/track-recurring-bills-and-subscriptions, https://www.monarchmoney.com/visualize-your-cash-flow-like-never-before, https://help.monarch.com/hc/en-us/articles/4402543752468-Monthly-Progress-Report | search summary only |
| 15 | Customizable dashboard (summary) | https://monarchmoney.com/whats-new/customizable-dashboard-manual-transactions | search summary only |
| 16 | App Store listing (screenshots live here; none committed) | https://apps.apple.com/us/app/id1459319842 | Apple search API: rating about 4.89 from about 117,000 ratings on the day of research |

Not read: the Google Play listing (the id I tried returned 404), walkthrough videos, the changelog beyond the posts above.

## Core loop

Accounts sync from several aggregators, transactions land in a review queue (AI categorized, rules applied, household members can be tagged), and the owner looks at the budget (Flex or Category), recurring calendar, reports and goals; the assistant and a weekly recap summarize.

## Screens

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Dashboard | home | draggable widgets: net worth, recent transactions, investment performance, budget summary, spending breakdown, goals; separate layout for web and mobile; swipeable monthly review (mobile) | widget grid, "customize dashboard" | widget hidden |
| S02 | Accounts | nav | all accounts by type with balances, sync status, sort by balance; recommended better provider banner | list, banner | disconnected |
| S03 | Account detail | tap | balance history, transactions, holdings (investment) | chart | manual vs connected |
| S04 | Add account / institution | Accounts, add | pick institution, aggregator login, or create manual account | search, aggregator modal | |
| S05 | Settings: Institutions | Settings | per-institution status; Switch provider; transfer tool | list | |
| S06 | Transactions | nav | search any transaction; swipe-to-review on mobile; filters including exclude filters | list, filter sheet | Needs Review queue |
| S07 | Transaction detail | tap | category, merchant, notes, tags, goal link, split, hide, attachments, receipts, activity log (web) | drawer | pending, split |
| S08 | Split | transaction detail | split amounts across categories; Smart Split via rules | amount rows | |
| S09 | Rules | Settings | conditions and actions (category, rename, tags, hide, review status, smart split, link to goal) with retroactive apply and ordering | rule list | |
| S10 | Receipts tab | nav | emailed or scanned receipts with matched or pending status | list | pending match |
| S11 | Budget | nav | Flex or Category mode; month view, forecast, rollovers, groups, widget | bars, buckets | |
| S12 | Budget setup | first use | choose Flex or Category; set buckets | wizard | |
| S13 | Recurring | nav | calendar and list; review new detected streams; reminders | calendar, list | new streams to review |
| S14 | Reports (formerly Cash Flow) | nav | cash flow, Sankey, spending, income (treemap option), net worth, savings; filters; save report; mobile since June 2026 | charts, saved views | |
| S15 | Goals | nav | Save Up and Pay Down goals; on/off-track status; account allocation; transaction links | cards, projection | |
| S16 | Investments | nav | holdings, allocation, top movers, performance, benchmarks | table, charts | |
| S17 | Net worth | via dashboard and Accounts | assets and liabilities over time, Zillow Zestimate for property | chart | |
| S18 | Forecasting (Plus) | nav | net worth projection with life events on a timeline, assumptions, side-by-side scenarios, early-withdrawal penalties | timeline | |
| S19 | Assistant | nav / sheet | chat; "Savings found" page; weekly recap card | chat | disabled |
| S20 | Month in Review / monthly progress report | mobile dashboard card | cash flow, plan progress, top categories, net worth | swipe cards | |
| S21 | Household / collaboration | Settings | invite partner, advisor; tag a member to review a transaction; shared goals | member list | |
| S22 | MCP connection setup | web settings | connect Claude, ChatGPT, Gemini, Cursor; Read or Read and write | permission choice | |
| S23 | Retail Sync extension popup | Chrome extension | sync Amazon or Target orders; auto-sync every 24 hours; backfill older | popup | not signed in to retailer |
| S24 | Notifications settings | Settings | budget, bills, goals alerts | | |
| S25 | Sign up / login | | | | |

25 screens (some are views of the same page).

## Flows

```
F01 Review inbox
    S06 Needs Review -> swipe (mobile) or click -> accept category, edit, or tag a household member -> cleared
    edge: a manual split counts as reviewed (summary); hidden does not clear review (summary); rules can mark reviewed or needs review (summary)

F02 Create a rule
    S07 change category -> offered rule -> S09 conditions + actions -> optionally apply to existing

F03 Smart split by rule
    S09 split action with fixed or percentage parts (summary); apply retroactively or to new only

F04 Receipt matching
    forward a receipt to the receipts address (no subject format needed) -> S10 shows matched or pending -> note added and split into categories if the setting is on
    edge: forwarding address must be a verified household email

F05 Retail sync
    S23 install extension -> sign in to Amazon US or Target -> sync last 3 months -> orders matched to transactions, split by item and categorized -> "Retail Sync" tag
    edge: Amazon US with English only, business accounts not supported, reconnect every few weeks (summary), Canada not available

F06 Budget with Flex
    S12 choose Flex -> assign categories to Fixed, Non-monthly, Flexible buckets -> goals subtracted -> Flex number = income - fixed - non-monthly - goals (summary) -> watch one number
    edge: can only move money to or from the flexible bucket as a whole under Flex (summary; later release may allow more); non-monthly works as a sinking fund

F07 Category budget
    S11 per-category amounts with rollover for irregular costs; groups; forecast of future months

F08 Recurring
    transactions arrive -> detection -> "new recurring" list to review/edit -> calendar with checkmarks -> reminders before expected charge

F09 Goals
    S15 create Save Up (target, date, monthly contribution) or Pay Down (debt accounts, extra payment modeling) -> allocate any asset account -> link transactions manually, in bulk or through rules -> on/off track

F10 Switch a bank's data provider
    S05 Switch provider -> enter credentials -> confirm accounts; history stays; Accounts banner recommends a better provider

F11 Forecast
    S18 baseline from real data -> add life events (retire, house, career break) -> adjust assumptions -> compare

F12 Ask the assistant or an external AI
    S19 chat; or S22 connect Claude/ChatGPT through MCP; the October update says the assistant now proposes savings opportunities (duplicate charges, idle savings, mortgage rate)
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Dashboard widget | net worth, recent transactions, investments, budget, spending, goals | hidden, reordered | S01 |
| Review row | swipe action on mobile | needs review, reviewed | S06 |
| Budget bar | per category, per bucket | over, under | S11 |
| Sankey diagram | web and mobile | | S14 |
| Treemap | spending, income | drill down group -> category -> merchant -> transactions | S14 |
| Calendar | recurring bills | paid check, due | S13 |
| Goal card | on-track pill, projection chart, custom image | | S15 |
| Activity log | timeline per transaction | web only at launch | S07 |
| System tags | Retail Sync | | S07 |

## Inferred data model

```
Household       members[], subscription; confidence: medium
Account         id, institution, type, balance, source (plaid|mx|finicity|manual), hidden/excluded, sort order; evidence: S02, S05, "customizable dashboard" and search summaries; confidence: medium
Transaction     id, account, date, merchant, amount, category, notes, tags[], goal_id, hidden, needs_review, assigned_member, pending, attachments, receipt_id, split_parent; evidence: S06, S07, July/August posts; confidence: medium-high
ActivityEvent   transaction_id, time, kind (landed|pending_to_posted|category_change|edit); evidence: July update; confidence: high
Rule            conditions -> actions (category, merchant rename, tags, hide, review status, smart split, goal link); order; apply retroactively flag; evidence: summaries; confidence: medium
Receipt         source (email|scan), matched_transaction_id|pending, parsed items; evidence: July update; confidence: medium
Budget          mode (flex|category), month, buckets{fixed, non_monthly, flexible}, category amounts, rollover flags; evidence: budgeting page; confidence: medium
RecurringStream merchant, cadence, amount, next date, status (new|confirmed|ignored); evidence: tracking page; confidence: medium
Goal            kind (save_up|pay_down), target, date, monthly contribution, accounts[], linked transactions, growth rate; evidence: Goals post; confidence: high
ForecastScenario  assumptions, life events[], account withdrawal timing, penalties; evidence: Forecasting post; confidence: medium
SavedReport     type, filters, chart; evidence: August update; confidence: medium
Insight/Recap   weekly recap, savings-found items; confidence: low
```

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Aggregator contracts (Plaid, MX, Finicity), Zillow Zestimates.
- The retail extension's scraping of the owner's Amazon/Target session (terms and fragility); build receipt forwarding and manual itemization first.
- Monarch's default forecasting assumptions (expert reviewed); use your own.
- Monarch AI models and prompts.

## Size

Screens 25, flows 12, entities about 12. Hard parts: multi-aggregator sync with provider switching that keeps history; rules plus review state machine; Flex budget math; forecasting engine; receipt parsing and matching. Size: XL for parity, L for the core.

## Needs a signed-in account to confirm

Everything marked (summary): rule action list, review state machine, exact Flex bucket assignment and rollover behavior, recurring review UI, weekly recap contents, Month in Review slides, widget catalog, Android differences, receipt scan (camera) flow.
