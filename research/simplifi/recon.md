# Recon map: Quicken Simplifi (web and mobile) - Spending Plan and linked transfers only

Scope: the Spending Plan and linked transfers, plus the pieces they depend on (recurring reminders, exclude flags, rules). Nothing else in Simplifi is mapped.
For: the owner's personal finance app, own use only.
Date: 2026-11-04
Method: public help center only. Nothing was signed into. 16 articles were read one at a time at a normal pace.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | Help center index | https://support.simplifi.quicken.com/en/ | 8 collections |
| 2 | Understanding your Spending Plan | https://support.simplifi.quicken.com/en/articles/4212702-understanding-your-spending-plan | six sections |
| 3 | Setting it up | https://support.simplifi.quicken.com/en/articles/14893966-how-to-set-up-the-spending-plan | |
| 4 | Outstanding items | https://support.simplifi.quicken.com/en/articles/5735189-resolving-outstanding-items-in-the-spending-plan | |
| 5 | Rollover | https://support.simplifi.quicken.com/en/articles/9029030-using-rollover-in-the-planned-spend-section-of-your-spending-plan | Planned Spend only |
| 6 | Planned vs recurring | https://support.simplifi.quicken.com/en/articles/5142441-planned-expenses-versus-recurring-expense-transactions | |
| 7 | Custom income | https://support.simplifi.quicken.com/en/articles/5528672-how-do-i-set-a-custom-income-amount-in-the-spending-plan | per month |
| 8 | Transfers in the plan and in reports | https://support.simplifi.quicken.com/en/articles/5142302-handling-transfers-in-the-spending-plan and /14812140-handling-transfers-in-reports | |
| 9 | How transfers work | https://support.simplifi.quicken.com/en/articles/3352152-how-do-transfers-work | linked transfers |
| 10 | Account-to-account transfers | https://support.simplifi.quicken.com/en/articles/9980256-account-to-account-transfers-a2a | limited availability |
| 11 | Exclude flags | https://support.simplifi.quicken.com/en/articles/3569626-how-to-exclude-and-include-transactions-from-reports-and-the-spending-plan and /8241194-how-investment-transactions-are-handled-in-reports-and-the-spending-plan | |
| 12 | Bills & Income | https://support.simplifi.quicken.com/en/articles/4109588-using-the-bills-income-section | |
| 13 | Spending dashboard (early access) | https://support.simplifi.quicken.com/en/articles/16648530-using-the-spending-dashboard-in-quicken-simplifi | |
| 14 | Transaction rules | https://support.simplifi.quicken.com/en/articles/4792733-how-to-use-transaction-rules-in-the-web-app | |
| 15 | Quicken AI Chat | https://support.simplifi.quicken.com/en/articles/13343650-using-quicken-ai-chat | |
| 16 | Marketing page | https://www.quicken.com/products/simplifi/ | |
| 17 | App Store listing (screenshots there; none committed) | https://apps.apple.com/us/app/quicken-budget-track-money/id1449777194 | the Simplifi app is listed as "Quicken: Budget & Track Money"; rating about 4.54 from about 12,000 ratings on the day of research |

## Core loop

Recurring income, bills and subscriptions plus a few planned variable expenses form a monthly plan, and everything else is "Other Spend"; one number, Left This Month, says what is safe to spend.

## Screens (scoped)

| ID | screen | how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Spending Plan intro and setup | left panel, Spending Plan, "See how it works", Get Started | builds a plan from detected recurring series | wizard | first run |
| S02 | Spending Plan | left panel | Income, Bills, Planned Spend, Other Spend, Goals, Left This Month; each section expands to its transactions; month navigation | section cards with three-dot menus, "Included This Month" and "Excluded This Month" groups | outstanding items, excluded group |
| S03 | Series view/edit | three-dot, View Series, Options, Edit Series | edit a recurring series, exclude flags | form | |
| S04 | Set custom amount | three-dot on Income or a Bills group | override a group's total for the month | dialog | per month only |
| S05 | Planned Spend item | add planned expense | category target with optional rollover | form | rollover on (current and future months only) |
| S06 | Outstanding items | Spending Plan | planned entries not matched to a real transaction yet | list with resolve actions | |
| S07 | Bills & Income | left panel | overview (net after bills and income), reminders, past due, calendar | summary, tabs | |
| S08 | Transactions | left panel | category field doubles as linked-transfer picker; "Go to other side" link; three-dot menu with Exclude From | table | linked, unlinked |
| S09 | Transaction rules | web | If conditions, Then actions | rule form | |
| S10 | Settings: All Recurring | gear | recurring series list; edit series; exclude from plan | list | |
| S11 | A2A transfer | accounts | move money between connected checking and savings at different banks | form | not eligible |
| S12 | Quicken AI Chat | chat | questions and approved changes | chat | Basic only |
| S13 | Spending dashboard | Spending (early access) | trends by month, quarter, year; income, total spent, remaining, savings rate | charts | |

13 screens (scoped).

## Flows

```
F01 Build the plan
    S01 -> detected recurring income, bills and subscriptions form the plan -> review -> done
    edge: plan starts in the month the subscription begins, not retroactive; deleting a recurring item from the plan removes it everywhere

F02 Track a month
    S02: Income (recurring series, extra deposits are excluded by default; move to Included via menu) - Bills - Planned Spend - Goals - Other Spend (all remaining) = Left This Month
    edge: transactions linked to a recurring reminder count under Bills, not Planned Spend, even in the same category (avoids double counting)

F03 Planned expense vs recurring expense
    planned = flexible (groceries, gas), no fixed date; recurring = predictable (rent, subscriptions), has cadence

F04 Resolve outstanding items
    S06: a planned entry that has no match stays outstanding until the owner confirms the planned amount was fully spent or adjusts it

F05 Custom income
    S04 on Income: set an amount for this month (bonus, fixed income, carry-over); switch back to automatic any time

F06 Link a transfer
    S08: set category to the "to" account -> Simplifi links it to the matching transaction in that account, or offers to create the missing side -> "Go to other side"
    edge: built-in "Credit Card Payment" and "Transfer" categories keep a transaction neutral without a second side; Simplifi also auto-detects transfers

F07 Include a transfer in the plan
    S08 three-dot -> Exclude From -> clear Spending Plan checkbox (repeat on the other side to count both); for a recurring transfer series: Settings, All Recurring, Edit Series, clear Spending Plan under Exclude From; for linked recurring transfers choose Money Out, Money In or both
    edge: reports use their own checkbox

F08 Exclude from reports and plan
    flags exist per transaction and per account; excluding from reports also excludes from Watchlists; investment accounts default to both flags set; account-level flag sets the default for new transactions and can be overridden per transaction
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Plan section card | Income, Bills, Planned Spend, Other Spend, Goals | collapsed, expanded | S02 |
| Included / Excluded This Month group | | | S02 |
| Three-dot menu | set custom amount, view series, exclude from, link | | S02, S08 |
| Category field with transfer picker | normal category, linked transfer account | | S08 |
| Exclude From checkboxes | Reports, Spending Plan | | S08, S10 |
| Reminder status colored icons | paid, due, past due | | S07 |

## Inferred data model

```
RecurringSeries   id, kind (income|bill|subscription|transfer), payee, amount, cadence, next date, category, exclude_from_reports, exclude_from_plan, money_out/money_in side for transfers
                  evidence: S02, S03, S10, transfers articles; confidence: high
Reminder (occurrence)  series_id, due date, amount, status (upcoming|paid|past due|skipped), linked transaction; evidence: S07, "link transactions to reminders", "skip an instance"; confidence: high
PlannedSpend      id, category, month, target amount, rollover flag, rolled amount; evidence: S05, rollover article; confidence: medium
SpendingPlanMonth month, income (auto or custom_amount), included/excluded sets, left_this_month (derived); evidence: S02, S04; confidence: medium
Transaction       id, account, date, payee, amount, category (may be a transfer account), linked_transaction_id, exclude_from_reports, exclude_from_plan, reviewed, flagged, downloaded|manual; evidence: transactions articles; confidence: high
Account           id, type, exclude_from_reports, exclude_from_plan (default for its transactions); evidence: exclude articles; confidence: high
Rule              if{payee contains words, amount} then{rename payee, category, tag}; confidence: medium
SavingsGoal       included in plan as contributions; confidence: medium
Space             dataset; created-before date gates A2A; confidence: low
```

Relationships: Account 1-n Transaction; Transaction 0..1-1 Transaction (linked transfer); RecurringSeries 1-n Reminder; Reminder 0..1-1 Transaction; PlannedSpend n-1 Category.

Left This Month = Income - Bills - Planned Spend - Goals - Other Spend, using only the current month's transactions and no account balances.

## Feature matrix

See `features.csv`.

## Out of scope (cannot or should not be cloned)

- Aggregator access (Quicken uses its own and partner connections); A2A money movement (a regulated payment rail).
- Early-access features and business/personal tiers.
- Everything outside Spending Plan and linked transfers (not mapped).

## Size

Screens 13 (scoped), flows 8, entities about 9. Hard parts: reliable recurring detection and reminder-to-transaction matching (amount matching rules), the no-double-count rule between Planned Spend and Bills, linked transfer pairing. Size: M.

## Needs a signed-in account to confirm

Outstanding-item resolution options, how Other Spend treats pending transactions, the exact reminder matching tolerance (an "amount matching" article exists), and how Goals contributions are funded in the plan.
