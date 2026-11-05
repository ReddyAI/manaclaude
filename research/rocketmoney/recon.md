# Recon map: Rocket Money (web and Android; the iOS app shares the flows)

Scope: onboarding, Recurring and subscriptions, the cancel flow, budgets, net worth, spending insights.
For: the owner's personal finance app, own use only. Selling, pricing and positioning are out of scope.
Date: 2026-11-04
Method: public help center and marketing pages only. Nothing was signed into.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Help center index | https://help.rocketmoney.com/en/ | 15 collections; 30 articles read |
| 2 | Bills and subscriptions | https://help.rocketmoney.com/en/articles/2185531-managing-your-bills-and-subscriptions | Recurring tab: Upcoming, All, Inactive |
| 3 | Cancel flow | https://help.rocketmoney.com/en/articles/934402-how-do-i-cancel-a-subscription-on-rocket-money, /934410-how-long-does-it-take-rocket-money-to-cancel-a-subscription, /5032045-why-do-i-need-to-provide-more-information-to-cancel-my-subscription, /13908897-why-can-t-rocket-money-cancel-this, /934383-missing-subscriptions | |
| 4 | Budget | https://help.rocketmoney.com/en/articles/2649810-creating-a-budget, /10770105-understanding-non-spending-categories-in-your-budget, /6235627-enabling-payday-view | |
| 5 | Transactions | https://help.rocketmoney.com/en/articles/13778317-transaction-category-review, /10328100-creating-transaction-rules, /4363893-how-to-split-transactions, /12461821-create-and-apply-tags-for-transactions, /4839084-tax-deductible-transactions, /10296106-exporting-transactions | |
| 6 | Dashboard extras | https://help.rocketmoney.com/en/articles/13704685-track-the-spending-that-matters-most-with-a-watchlist, /14443051-build-better-money-habits-with-challenges, /8418019-how-to-customize-a-low-balance-alert, /13778435-discover-the-learning-hub | |
| 7 | Net worth | https://help.rocketmoney.com/en/articles/5350243-how-is-net-worth-calculated, /9184654-use-equity-values-in-net-worth-charts | |
| 8 | Rowan (AI) | https://help.rocketmoney.com/en/articles/16760933-what-is-rowan, /16760832-what-can-i-ask-rowan | text-message assistant |
| 9 | Goals, bill negotiation, membership | https://help.rocketmoney.com/en/articles/2621011-creating-a-financial-goal, /9744564-how-to-submit-a-bill-negotiation, /2677184-premium-membership-features, /16802386-introduction-to-premium | |
| 10 | Linking, sharing | https://help.rocketmoney.com/en/articles/934328-connecting-bank-accounts-and-credit-cards, /4562634-account-sharing-in-rocket-money, /79778-does-rocket-money-support-international-banks | |
| 11 | Marketing site | https://www.rocketmoney.com/ | "Rowan your AI financial agent" |
| 12 | App Store listing (screenshots live here; none committed) | https://apps.apple.com/us/app/rocket-money-bills-budgets/id1130616675 | Apple search API: rating about 4.47 from about 405,000 ratings on the day of research |

Not read: pricing page, changelog, Play Store listing (blocked for automated reads), videos.

## Core loop

Link accounts, let Rocket Money detect subscriptions and bills, see what is due and what is wasteful, and hand it the cancellation or the negotiation.

## Screens

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Sign up and onboarding | first launch | account, link bank, set budget start | stepper | no accounts |
| S02 | Link account | Settings, Linked Accounts, Add Institution | search bank, aggregator login | search, third-party login | frequent disconnect, missing account |
| S03 | Connection status | Settings | which institutions need attention | status list | |
| S04 | Dashboard | home | summary, Ways To Save (Lower Bills), Watchlist, Recent Transactions with Category Review, Challenges, Learning | cards | free vs premium |
| S05 | Recurring: Upcoming | Recurring tab | next two weeks as a calendar | calendar, list | premium only |
| S06 | Recurring: All | Recurring tab | every subscription and bill; Inactive link at bottom | list with three-dot menu | no payment in last month = Inactive |
| S07 | Subscription detail | tap | amount, cadence, history, cancel, ignore | detail | |
| S08 | Cancel This For Me | three-dot, Cancel | form for account details; View Instructions alternative | form | needs more info, cannot cancel provider |
| S09 | Payday view | Recurring tab | bills due before next paycheck, safe-to-spend | list | paycheck not detected (needs 3 paychecks) |
| S10 | Spending | tab | spending by category over a period | charts, category list | |
| S11 | Budget (app and web) | Manage Budget | income, bills, category budgets, glossary | steps 1 to 3 | not set up |
| S12 | Transactions | tab | list, search, filter, CSV download | list | |
| S13 | Transaction detail | tap | category, split, ignore, tags, notes, tax-deductible | sheet | |
| S14 | Category Review | Dashboard, Recent Transactions | swipe cards: right to confirm, left to change | card stack | needs 10 new transactions to reappear |
| S15 | Rules, categories, tags | Settings, Categories, Tags & Rules | custom categories, tags (mobile only), rules | lists | premium only |
| S16 | Net Worth | More, Net Worth | Summary, Assets, Debts tabs; equity toggle | chart with gray estimate line | premium only |
| S17 | Financial Goals | tab | savings goals backed by partner-bank custodial account | goal cards | premium only |
| S18 | Watchlist | Dashboard | track a category, merchant or tag without a budget | cards | |
| S19 | Challenges | Dashboard | Financial Pulse, Weekly Snapshot, Bad Habit Breaker; badges | cards | |
| S20 | Learning Hub | More, Learning | videos, quizzes, articles | | |
| S21 | Notifications & Alerts | Settings | low-balance alert (default $200), others | list | mobile only to edit |
| S22 | Bill negotiation | Dashboard, Ways To Save | submit a bill (cable, internet, phone, security, satellite radio), status | form | Premium+ |
| S23 | Rowan | text message thread (RCS) | ask questions, set alerts, start cancellations or negotiations | chat | Premium+ |
| S24 | Account sharing | Settings | invite a partner with own login | | premium |
| S25 | Credit score | tab | Experian score | | |
| S26 | High-yield savings | Premium+ | apply for partner-bank account | | |

26 screens.

## Flows

```
F01 Onboard
    S01 -> S02 link a bank -> data loads (first load can take a while) -> S04
    happy path clicks: about 8
    edge: bank not supported, no checking account, international bank unsupported

F02 Find and cancel a subscription
    S06 All -> three dots on a subscription -> Cancel -> "Cancel This For Me" or "View Instructions" -> short form (S08) -> status notification and email
    happy path clicks: 5
    edge: provider not supported (no Cancel option, only self-cancel instructions); needs credentials to match the account; 2 to 10 business days; billed via Apple, Google Play, Amazon, Roku or PayPal needs cancelling there; missing subscription (check Inactive)

F03 Set up a budget
    S11 Manage Budget -> Steps 1 to 3 (income, bills, categories)
    edge: non-spending categories (Tax-Deductible, Reimbursements, Ignored, Transfers, Income) never count

F04 Review categories fast
    S04 -> S14 swipe through ten recent transactions
    edge: feature returns after ten more transactions

F05 Payday planning
    S09 requires linked paycheck account and 3 consistent paychecks -> shows bills due before next payday and a safe-to-spend number

F06 Negotiate a bill
    S22 submit -> savings process -> status check -> negotiated savings take effect later (a charge article exists; not read)
    edge: not available outside listed bill types

F07 Watch a category without budgeting
    S18 add category, merchant or tag
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Swipe card | confirm / change | | S14 |
| Calendar of upcoming bills | two-week window | | S05 |
| Three-dot row menu | cancel, ignore, edit | | S06 |
| Net worth chart | with equity toggle, gray estimate segment | | S16 |
| Badge / challenge card | | earned | S19 |
| Premium gate | feature locked | | many |

## Inferred data model

```
Institution/Link  id, name, status (ok|needs_attention|disconnected), provider; evidence: S02, S03; confidence: medium
Account       id, institution, type, balance, include_in_budget, include_in_net_worth; evidence: S02, S16, "excluding an account" article; confidence: high
Transaction   id, account_id, date, name, amount, category_id, ignored, tags[], note, split_parent_id, tax_deductible; evidence: S12, S13; confidence: high
Category      id, name, kind (spending | non-spending: tax_deductible|reimbursements|ignored|transfers|income), budget; evidence: non-spending categories article; confidence: high
Rule          conditions (amount, description) -> actions (category, bill assignment, ignore, rename); evidence: rules article; confidence: medium
Subscription/Bill  id, merchant, amount, cadence, next_due, status (active|inactive), cancel_state (none|requested|in_progress|done|needs_info), source (auto|manual); evidence: S06, S08; confidence: high
CancelRequest id, subscription_id, submitted_at, info_required, status; evidence: cancel articles; confidence: medium
Budget        income, bills, category budgets, period; confidence: medium
Goal          id, target, linked_checking_account_id, custodial balance, deposits/withdrawals, paused; evidence: goals articles; confidence: medium
WatchItem     kind (category|merchant|tag), ref; confidence: medium
Alert         type (low_balance), threshold; confidence: high
NegotiationCase  id, bill, status, savings; confidence: medium
```

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Human and automated cancellation services (agents calling providers, credential vaulting) and bill negotiation (a labor service with fees).
- Partner-bank custodial savings, high-yield savings and Experian credit score (regulated or licensed).
- Rowan over RCS messaging (carrier and vendor integration).
- Aggregator contracts.

## Size

Screens 26, flows 7, entities about 11. Hard parts: subscription detection from raw transactions; the cancel concierge (human or vendor); payday detection. Size: M for the detection and views, XL if cancellation is automated.

## Needs a signed-in account to confirm

The real onboarding screens, cancellation form fields, which fields the aggregator returns for subscriptions, how detection handles price changes, and the exact Spending tab charts.
