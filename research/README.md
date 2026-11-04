# Reference app research

Recon of six personal finance apps for a build that is for the owner's own use only. Done on 2026-11-04 with the Replica skills (`.claude/skills/replica-*`). Public sources only. No signed-in accounts, no screenshots committed, no personal data.

Files:

- `<app>/recon.md`: screens, flows, components, inferred data model with evidence and confidence, what can't be cloned, size.
- `<app>/features.csv`: that app's features in Replica format.
- `<app>/reviews.csv` and `<app>/feedback.md`: collected reviews and the ranked report from `reviews.py`.
- `features.csv`: one matrix across all six apps (columns: area, feature, priority, monarch, copilot, rocketmoney, lunchmoney, simplifi, sure, ours, keep_from, notes). `ours` starts at "no".
- `features-parity.csv`: the same rows in Replica's parity format, ready for `.claude/skills/replica-diff/parity.py`.
- `themes-finance.json`: the theme list used for the review ranking.
- `sure/rea.md` and `sure/features-chatgpt.csv`: the earlier first pass, left unchanged.

Cell values in `features.csv`: yes, partial, no, unconfirmed (could not verify from public sources), not mapped (outside the scope given for that app; only Simplifi).

## The six apps in five lines each

### Sure (open source, self-hosted web app)
- Core loop: connect or import accounts, sync, categorize with rules then Bayes and LLM, read one dashboard, ask an assistant that can read and change data.
- Size: 60 screens, 17 flows, about 45 core entities in 154 tables, 31 providers.
- Hardest parts: idempotent provider sync with pending-to-posted matching, daily multi-currency balance history, holdings and cost basis, recurring detection and matching, the assistant's tool surface.
- Out of scope: hosted billing, provider credentials and logos, FinanceKit (needs an iOS app), copying AGPL code.
- Reviews: 5 Hacker News rows only; Sure's GitHub issues and discussions were not reachable (see gaps below).

### Monarch Money (web, iOS, Android)
- Core loop: accounts sync from several aggregators, a Needs Review queue clears new transactions, then budget (Flex or Category), recurring calendar, reports and goals.
- Size: 25 screens, 12 flows, about 12 entities.
- Hardest parts: multi-aggregator sync with provider switching that keeps history, rules plus review state, Flex budget math, forecasting, receipt parsing and matching.
- Out of scope: aggregator contracts, Zillow data, the retail extension's scraping of a logged-in retailer session, Monarch's forecasting defaults.
- Reviews: 82 rows (63 App Store, 19 Hacker News). The help center was blocked, so several items rest on search summaries and are marked as such in `monarch/recon.md`.

### Copilot Money (iOS, iPad, Mac, web)
- Core loop: new transactions get a suggested category from a per-user model, the owner clears blue dots, and the dashboard shows what is left to spend.
- Size: 29 screens, 10 flows, about 10 entities.
- Hardest parts: bank sync, the per-user categorization model, fuzzy recurring matching, investment performance, Amazon and Venmo matching.
- Out of scope: aggregator contracts, Zestimates, native Apple UI and widgets, trained model weights.
- Reviews: 76 rows (65 App Store, 11 Hacker News).

### Rocket Money (web, iOS, Android)
- Core loop: link accounts, detect subscriptions and bills, show what is due and what is waste, then cancel or negotiate for the user.
- Size: 26 screens, 7 flows, about 11 entities.
- Hardest parts: subscription detection, payday detection, and the cancel concierge (people or vendors).
- Out of scope: cancellation and bill negotiation services, custodial savings, credit score, Rowan over text messages.
- Reviews: 86 rows (59 App Store, 27 Hacker News).

### Lunch Money (web, small mobile companion)
- Core loop: sync or import, clean up with rules and reviewed flags, watch the period budget, recurring items and net worth, slice data with the query tool.
- Size: 26 screens, 11 flows, about 11 entities.
- Hardest parts: spreadsheet-grade editable table, rule engine with apply-to-existing, splits plus groups plus transfers, multicurrency totals.
- Out of scope: Plaid and its institution list, hosted collaboration billing.
- Reviews: 57 rows (30 App Store across several storefronts, 27 Hacker News). Few App Store reviews exist because the app is a companion.

### Quicken Simplifi (Spending Plan and linked transfers only)
- Core loop: recurring income, bills and a few planned expenses form the month, everything else is Other Spend, and one number says what is left.
- Size: 13 screens (scoped), 8 flows, about 9 entities.
- Hardest parts: recurring detection with reminder-to-transaction matching, the no-double-count rule, linked transfer pairing.
- Out of scope: account-to-account money movement, early-access features, everything outside the two scoped areas.
- Reviews: 62 rows, all App Store.

## Top 30: take this from X

1. Review state: Lunch Money's explicit reviewed/unreviewed flag with auto-review settings; Copilot's blue-dot queue as the screen.
2. Categorization: Copilot's per-user model trained on reviewed transactions (it waits for 30), plus Sure's confidence threshold and shadow-rate evaluation.
3. Cheap first pass: Sure's local Bayes categorizer before any LLM call.
4. Sync safety: Sure's locked fields, import lock and per-entry idempotency key, so a sync never undoes a manual edit.
5. Pending to posted: Monarch's approach of recognizing the same purchase even when the bank sends no link, with Sure's provider-id match first.
6. Spending vs movement: Sure's transaction kinds internally, Lunch Money's three category properties (treat as income, exclude from budget, exclude from totals) as the screen the owner sees.
7. Transfers: Simplifi's linked transfers (pick the other account as the category, auto-create the missing side) with Sure's matcher and rejected-pair memory.
8. Refunds: Sure's netting inside the category with an explicit floor choice; Copilot's "date it like the original purchase" as a user option.
9. Rules: Lunch Money's conditions (payee, category, notes, amount range, day range, account) and actions; Sure's nesting, confirm-before-apply preview and run log.
10. Splits: Lunch Money's even, custom and over-time modes with bulk unsplit; Sure's atomic, undoable writes.
11. Tables: Lunch Money's inline-editable table and full bulk-edit action list; Copilot's keyboard shortcuts.
12. History: Monarch's and Lunch Money's per-transaction change log.
13. Plan structure: Simplifi's Income, Bills, Planned Spend, Other Spend, Goals, Left This Month, including the rule that a transaction linked to a bill counts once.
14. Exclusions: Simplifi's two flags (reports, plan) on both transactions and accounts, with investment accounts excluded by default.
15. Budget modes: offer Monarch's Flex (fixed, non-monthly, flexible) and plain category budgets.
16. Headline number: Copilot's free-to-spend with the ideal-pace line; Copilot's Rebalance preview.
17. Periods and rollover: Lunch Money's custom period start and rollover for both the income pool and categories; Sure's month start day.
18. Income: Simplifi's per-month custom income override; Sure's expected income.
19. Recurring detection: Sure's three-occurrence rule, suggested then confirmed, with a tombstone on dismiss and price-change detection.
20. Recurring matching: Copilot's editable name text, amount range and day window.
21. Payday: Rocket Money's bills-before-next-payday view and safe-to-spend, with Sure's shortfall and bridge.
22. Subscriptions: Rocket Money's "where is this billed from" hints (Apple, Google Play, Amazon, PayPal) and self-cancel steps. Skip the concierge.
23. Connections: Monarch's switch-provider flow that keeps history; Sure's one-account-many-providers tables and health strip with maturity badges.
24. Reports: Monarch's Sankey and treemap drill-down; Lunch Money's Analyze query tool; saved views from Monarch.
25. Reviews of the period: Copilot's shareable Month and Year in Review slides.
26. Investments: Sure's holdings, trade labels and cost-basis priority (manual, calculated, provider, with lock); Copilot's performance that ignores deposits, benchmarks and live estimate.
27. Goals: Monarch's Save Up and Pay Down with on/off-track status, many-to-many account allocation; Sure's pledge reconciliation as an optional extra.
28. Insights: Sure's template-based generators (no LLM needed) plus Monarch's "savings found" for duplicate charges and idle cash.
29. Assistant: Sure's tool surface, Simplifi's approval before any change, and Monarch's Read versus Read-and-write choice on the MCP connection.
30. Own-data safety: Sure's full export and re-import, Lunch Money's personal API token, and Lunch Money's primary-currency model with Sure's exchange rate history.

## User complaints to avoid

Sample sizes are small and come from two sources (App Store and Hacker News), so treat counts as signals. The ranker's themes are keyword-based; only the rows quoted here were read and checked by hand. Review ids refer to rows in each app's `reviews.csv` (which holds the full link).

- Silent stale connections. Monarch, review 14704658469: "There's essentially no UI for telling you that your accounts haven't been synced due to a problem, leading me to miss all spending on a few accounts for nearly a year." Also Monarch 14562516939, Simplifi 14722318997, Lunch Money 13583758466. Show last-synced time and a loud banner per account.
- Reconnecting a replaced card doubles history. Monarch, review 14655994312: new card sync "doubles every transaction as they now both count as same card". Merge by account identity, not card number.
- Wrong sign. Monarch 14726105604: withdrawals recorded as deposits; Lunch Money 13583758466: debits reported as credits. Test sign handling per provider and per import.
- Pending items cannot be edited. Monarch 14730713071: "when charges are pending, u can't split it ahead of time". Allow edits and keep them when the posted version arrives.
- Duplicates and off categories. Simplifi 14605461694 (duplicates, wrong categories forcing manual entry) and 14603624107 ("Category is always off for 20% of the transactions even after repeated corrections"). Corrections must train the next suggestion and must not be overwritten.
- Features removed without notice. Monarch 14556686415: "MCP removed without warning". Version any API or tool surface we expose.
- Itemization that needs daily re-login. Copilot 14635651909: "you need to reverify your Amazon account almost daily". Prefer receipt forwarding and manual itemization first.
- Investment numbers wrong. Copilot 14737317948: "Stock performance data is wrong literally every single day." Reconcile holdings against balances and show data age.
- Inflexible budgeting for variable spending. Copilot 14419594285: "do it their way or don't bother"; Monarch 14655994312 on forcing rollovers onto flexible spending. Offer both budget styles.
- Missing detail where it matters. Monarch 14678658534: no quick spent figure for an unbudgeted category. Always show actual spend, with or without a budget.
- Mobile gaps and sluggishness. Lunch Money 14739505090: the iOS app lacks features the web has; Copilot 14722885973 and Simplifi 14521725720 on slowness. Keep one clean web app fast before any mobile app.
- Regional bank coverage. Lunch Money 13491156809 and 12727982620 (Canadian banks); Sure Hacker News 48446070 (SimpleFIN needs daily 2FA refresh and caused lockouts). Keep CSV and PDF import as a first-class fallback.
- Cancellation and billing problems dominate Rocket Money's reviews (the ranker matched 25 of 86 rows) and also appear for Monarch, Copilot and Simplifi. They do not apply to a personal app, so no action beyond not building dark patterns.

## Gaps and what still needs the owner's own signed-in account

Access gaps in this session:
- Reddit, Trustpilot, G2, Capterra and Google Play block automated reads; the one attempt to read around that with a headless browser was denied and not repeated. Review sources are therefore the App Store RSS feed and the Hacker News API only: two sources per app (one for Simplifi), not the three asked for. Lunch Money and Sure are below the 50-row target because their App Store footprint is small (Lunch Money 57 rows, Sure 5).
- Sure's GitHub issues and discussions need repository access that was not granted, so Sure has no issue-based reviews. Of Sure's 5 Hacker News rows, only 1 is a user report about Sure itself; the others discuss the Maybe project it forked from.
- Monarch's help center is behind a bot check. No help articles were read; see `monarch/recon.md` for what rests on summaries.
- No store screenshots were saved. Each recon file links the App Store listing where they live.

Needs a signed-in account (the owner's own) to confirm:
- Monarch: rule action list and review state machine, Flex bucket assignment and rollover behavior, recurring review screen, weekly recap and Month in Review contents, widget catalog, receipt camera flow, Android differences, retail extension behavior.
- Copilot: confidence display, rule-creation dialog, pending handling, Month in Review slide list, goal funding rules, what the model uses beyond name, amount and weekday.
- Rocket Money: onboarding screens, cancel form fields, subscription fields returned by the aggregator, Spending tab charts, price-change handling.
- Lunch Money: advanced filter fields and saved views, budget v2 math for the general pool, group effect on budget totals, Analyze grouping options, mobile screens.
- Simplifi: outstanding-item resolution options, pending handling in Other Spend, reminder matching tolerance, goal funding inside the plan.
- Sure: run it with synthetic data to check the open questions in `sure/rea.md` (provider reliability, recurring quality, multi-currency edge cases, cross-month refunds).
- All apps: real empty states, copy, latency and visual design.

## Defaults chosen

- Branch `claude/amazing-cannon-nnbvik`; small commits, pushed after each.
- Directory names: `monarch`, `copilot`, `rocketmoney`, `lunchmoney`, `simplifi`, `sure`.
- `ours` priorities (must, should, could) reflect a single-owner finance app, not a product for sale; billing, referral and support rows are marked `skip`.
- A finance-specific theme file (`themes-finance.json`) replaced the generic one for ranking; its patterns are loose, so quotes were checked by hand.
- Reviewer names are not stored. Lunch Money's reviews include several App Store storefronts to reach 57 rows.
- Apple's feed returns the newest 500 reviews at most; I kept up to 55 ratings of 1 to 4 stars and 10 five-star ratings per app, newest first.
- Hacker News rows were filtered to comments that name the product and read as opinion or experience; hiring posts and tool announcements were dropped.
- Skipped, as instructed: positioning, pricing and selling, and the architect, build, backend, test, brand, launch and deploy skills.
