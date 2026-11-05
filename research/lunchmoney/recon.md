# Recon map: Lunch Money (web, plus the iOS and Android companion app)

Scope: transactions table, rules engine, splits, groups, tags, multicurrency, recurring, budgets, query tool (Analyze), crypto.
For: the owner's personal finance app, own use only.
Date: 2026-11-04
Method: public knowledge base only. Lunch Money publishes each page as Markdown (append `.md`), which was read one page at a time. Nothing was signed into. The marketing site (`lunchmoney.app/features`) sits behind a bot challenge and was not read.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Knowledge base index (llms.txt) | https://support.lunchmoney.app/llms.txt | full page list |
| 2 | Getting started | https://support.lunchmoney.app/getting-started | |
| 3 | Transactions: actions, types, status, enhancements, other features | https://support.lunchmoney.app/finances/transactions/transaction-actions and /transaction-types, /transaction-status, /transaction-enhancements, /other-features | bulk edit list, split, group, reviewed status, change history, filters |
| 4 | Rules | https://support.lunchmoney.app/setup/rules | conditions and actions |
| 5 | Budget | https://support.lunchmoney.app/finances/budget | budgeting v2: custom period, rollovers, category group budgeting |
| 6 | Recurring | https://support.lunchmoney.app/finances/recurring-items/the-basics-of-recurring and /creating-recurring-items, /recurring-transactions | |
| 7 | Analyze (query tool) | https://support.lunchmoney.app/finances/analyze | |
| 8 | Overview, Net Worth, Stats, Trends | https://support.lunchmoney.app/home/overview and /net-worth, /stats, /trends | |
| 9 | Categories | https://support.lunchmoney.app/setup/categories/category-properties and /category-groups, /auto-categorization | |
| 10 | Tags | https://support.lunchmoney.app/setup/tags | |
| 11 | Accounts, crypto, multicurrency | https://support.lunchmoney.app/setup/accounts/adding-accounts, /setup/crypto, /settings/multicurrency | |
| 12 | Imports | https://support.lunchmoney.app/guides/import-via-csv and /guides/automatic-imports | CSV and PDF; Plaid |
| 13 | Collaborators, mobile app, developer API | https://support.lunchmoney.app/settings/collaborators, /miscellaneous/mobile-app, /miscellaneous/developer-api | |
| 14 | App Store listing of the companion app (screenshots there; none committed) | https://apps.apple.com/us/app/lunch-money/id6739028463 | few reviews |

Not read: pricing, changelog, billing, affiliate program, beta program, videos.

## Core loop

Sync or import transactions, clean them with rules and categories (reviewed vs unreviewed), watch the period budget, recurring items and net worth, and slice the data with the query tool.

## Screens

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Overview | landing page | accounts overview with estimated net worth, period summary, spending and budget breakdown, attention cards | period picker, cards | no accounts |
| S02 | Net Worth | Home | assets and liabilities over time, manual balance edits, historical balances, CSV export | chart, table, filters | |
| S03 | Stats | Home | top expensive purchases, new merchants for a period | cards, toggles (include recurring, include excluded-from-totals) | |
| S04 | Trends | Home | totals and charts over time | same toggles | |
| S05 | Transactions | Finances | spreadsheet-like table with inline edits, three filter modes (quick search, quick filter, advanced), bulk edit, CSV export | table, filter bar, selected-transactions panel | unreviewed prompt |
| S06 | Transaction Details panel | arrow at row end | all fields, notes, "I want to..." actions (split, duplicate, create recurring link, delete), change history, direct link | right panel | pending (notes only), synced (amount locked) |
| S07 | Split panel | "Split transaction" | even, custom or equal payments over time; unsplit | amount rows | |
| S08 | Group panel | select then Group | collapse several transactions into one group row with own properties | | |
| S09 | Create transfer / create from recurring | arrow next to "Add to cash" | two linked transactions in "Payment, Transfer" category | right panel | |
| S10 | Quick Add | hidden page | rapid manual entry | | |
| S11 | Budget (v2) | Finances | period budget, income pool, category and category-group budgets, rollovers | table with budgeted, actual, remaining | |
| S12 | Budget guide pages | Guides | steps 1 to 5 | | |
| S13 | Recurring | Finances | month view of recurring items with status (paid, pending, unlinked), suggested items | table, panel | |
| S14 | Create recurring item | panel | merchant, expected date, category, cadence, amount, active period, account | form | |
| S15 | Analyze (query tool) | Finances | report, pie, bar, line, stacked bar views; date range; time granularity; filters; save views | chart + table | |
| S16 | Accounts | Setup | synced and manual accounts, crypto, allow-modification flag, balances | list | not supported (crypto) |
| S17 | Add account | Setup | Plaid link, manual cash/asset, crypto wallet, exchange | wizard | |
| S18 | Categories | Setup | list, properties (treat as income, exclude from budget, exclude from totals), groups, auto-categorization, export/import | list | |
| S19 | Auto-categorization settings | Categories | map Plaid categories to own categories | list with status icons | |
| S20 | Tags | Setup | create, manage, assign, analyze | list | |
| S21 | Rules | Setup | list, create, apply to existing, one-time rules | rule form | |
| S22 | CSV / PDF import tool | Setup | upload, match columns, review settings, review transactions | stepper | |
| S23 | Settings | gear | user preferences (auto-review options), currencies, primary currency, collaborators, API token, billing | | |
| S24 | Collaborators | Settings | invite by email; shared budget; notifications | | |
| S25 | Mobile companion | iOS and Android | add transactions, view stats and spending | | |
| S26 | Developer API (outside app) | lunchmoney.dev | token, community tools | | |

26 screens.

## Flows

```
F01 Set up
    sign up -> create budget account -> add accounts (Plaid, manual, crypto) -> import history -> categories -> rules -> budget
    edge: US/Canada and some EU banks via Plaid; about 40% of users outside US/Canada rely on CSV/PDF import

F02 Review transactions
    S05 unreviewed prompt -> click check mark per row, or header check to mark all in view reviewed
    edge: settings to auto-review on update and on manual creation; rules can set reviewed

F03 Create a rule from a transaction
    S06 -> change category -> offered rule (payee contains X) -> conditions and actions -> optionally apply to existing

F04 Split
    S06 "Split transaction" -> choose even / custom / over time -> total must equal original -> save; unsplit later (bulk unsplit through Delete -> keep parents)

F05 Group
    select rows -> Group -> group has own date, category, payee, notes, tags; filters match the group, not children by default

F06 Transfer
    arrow next to Add -> Create transfer -> from, to, amount -> two transactions auto-grouped, net zero, "Payment, Transfer" category (excluded from budget and totals)

F07 Recurring
    Recurring page -> suggested items or Add -> link transactions (manual or via rule) -> status per month (paid, not yet, unlinked)

F08 Budget a period
    S11 -> choose period (custom start day) -> income settings -> set category budgets -> optional rollover for the general pool or each category -> optional category-group budgeting

F09 Multicurrency
    Settings -> enable currencies -> primary currency for all totals -> per-amount currency dropdown on every editable amount

F10 Import CSV or PDF
    S22 upload -> match columns -> review settings -> review transactions -> import
    edge: Mint and YNAB migration pages

F11 Query tool
    S15 choose view type, date range, granularity -> filters, group by -> save
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Editable table cell | text, category combobox, tag chips, currency-aware amount | edit, locked (synced amount, pending, recurring-linked) | S05 |
| Reviewed check icon | gray, green | | S05 |
| Selected-transactions panel | totals, average, bulk-edit toggles | | S05 |
| Right-side panel | details, split, group, transfer, recurring | | many |
| Period picker | last 7 days to year to date, custom | | S01 to S04, S05 |
| Chart switcher | report, pie, bar, line, stacked bar | | S15 |
| Toggle "include recurring / include exclude-from-totals" | | | S03, S04 |
| Status icons for auto-categorization | | | S19 |

## Inferred data model

```
Budget account  id, primary_currency, budget period config (start day, rollover options), collaborators[]; evidence: settings, budget; confidence: high
Account        id, name, kind (synced|manual cash/asset|crypto), currency, balance, allow_modifications, closed, excluded; evidence: accounts pages; confidence: high
Transaction    id (stable, direct URL), date, payee, original_name, amount, currency, account_id, category_id, tags[], notes, status (reviewed|unreviewed), pending, recurring_id, group_id, split_parent_id, source (plaid|csv|pdf|manual|api), attachments; evidence: transaction pages; confidence: high
TransactionGroup  id, properties (date, payee, category, notes, tags), children[]; confidence: high
ChangeLog      transaction_id, changes[] (data edits, splits, groups, recurring links); evidence: "View Change History"; confidence: high
Category       id, name, group_id, properties{treat_as_income, exclude_from_budget, exclude_from_totals}, plaid_mapping, budget, rollover; confidence: high
Tag            id, name; confidence: high
Rule           conditions{payee (contains|starts|exact), category, notes, amount type and range, day range, account} -> actions{set payee, notes, category, uncategorized, add tags, link or unlink recurring, split, reviewed, email, delete}; confidence: high
RecurringItem  id, merchant, cadence, billing date, amount (estimate), category, account, active period, status per month; confidence: high
Budget         period, income pool, rollover flags, category budgets; confidence: medium
Asset/Balance  account_id, date, balance (historical entries allowed); confidence: medium
CryptoHolding  symbol (300+), qty, rate; source (manual|coinbase api|kraken api|ethereum address); confidence: medium
```

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Plaid and its institution list (aggregator contract); crypto exchange APIs are fine with the owner's own keys.
- The hosted collaboration billing model.
- Community tools and the Discord.

## Size

Screens 26, flows 11, entities about 11. Hard parts: spreadsheet-grade table with inline edits, rule engine with apply-to-existing, groups plus splits plus transfers netting, multicurrency totals. Size: M to L.

## Needs a signed-in account to confirm

Advanced filter fields and saved views, exact budget v2 math for the general pool, how groups interact with budget totals, the Analyze grouping options, mobile app screens.
