# Data model

The one model lives in `packages/shared/src/model/` and is imported as `@manaclaude/shared` by the app, the backend and the connectors. `FinanceDataset` (in `dataset.ts`) bundles everything; the sample data and, later, the backend's sync endpoint both produce it.

Change the model only by adding things (a field, a type, a union member). Don't rename or remove fields other sessions use. If the type you need is already here, use it.

## Conventions

| Thing                      | Rule                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Money                      | `MinorUnits` integer plus `CurrencyCode`. USD 12.34 is `1234`, INR 1,00,000.00 is `10000000`. Helpers: `formatMoney`, `parseMoneyInput`, `allocate`, `fromMajor`, `toMajor` (charts only). |
| Quantities and unit prices | `DecimalString` ("0.15", "104250.00"). Exact BigInt helpers in `money/decimal.ts`: `addDec`, `mulDec`, `valueInMinor`, `proRateMinor`.                                                     |
| Dates                      | `LocalDate` "2026-11-04", `YearMonth` "2026-11", `IsoDateTime` UTC. Helpers in `dates/dates.ts`.                                                                                           |
| Ids                        | Strings. Sample data uses readable ids (`acc_checking`); the backend may use UUIDs.                                                                                                        |
| Colours in data            | `ColorSlot` ("c1" to "c12"). The theme maps slots to real colours, so data never holds a colour value.                                                                                     |

## Sign rules

- `Transaction.amount`: negative = money left the account, positive = money arrived. A card purchase is negative on the card; the payment to the card is positive on the card and negative on checking. Plaid reports the opposite sign; connectors flip it.
- `Account.balance`: assets are what you have; liabilities are what you owe, as a positive number. Net worth = assets minus liabilities (`currentNetWorth` in `apps/mobile/src/data/metrics.ts`).
- `originalAmount` / `originalCurrency`: always set. They equal `amount` / `currency` unless the merchant charged in another currency (EUR 42.50 on a USD card).

## Entities

| Entity                                                                  | File             | Notes                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                                                                 | `account.ts`     | `type` includes `cash`; every account has a `currency`. `subtype` covers `nre`, `nro`, `401k`, `demat` and more. `isDefaultCash` marks the quick-add target per currency.                                                                                                              |
| BalanceSnapshot                                                         | `account.ts`     | Balance history for net worth charts.                                                                                                                                                                                                                                                  |
| Transaction                                                             | `transaction.ts` | `kind` (regular, transfer, card_payment, loan_payment, investment_contribution), `transferLinkId`, `receiptId`, `aiCategoryConfidence` 0 to 1, `reviewed`, `userEditedFields`, provider identity (`source`, `externalId`, `pendingExternalId`), import identity (`importFingerprint`). |
| TransferLink                                                            | `transaction.ts` | Both sides of a transfer with both amounts and `impliedRate`. Status `auto`, `suggested`, `confirmed`, `rejected`. Only `auto` and `confirmed` hide the pair from spending and income.                                                                                                 |
| SplitRequest / SplitLineInput                                           | `transaction.ts` | Split children are transactions with `splitParentId`; the parent gets `isSplitParent` and is left out of reports.                                                                                                                                                                      |
| Merchant                                                                | `transaction.ts` | Clean name, default category, raw aliases.                                                                                                                                                                                                                                             |
| Category, CategoryGroup, Tag                                            | `category.ts`    | `kind` expense, income or transfer. Icons are keys the app maps to Lucide icons.                                                                                                                                                                                                       |
| Rule                                                                    | `rule.ts`        | Conditions and actions; `source: 'learned'` for rules made from AI corrections.                                                                                                                                                                                                        |
| CategoryBudget, Goal                                                    | `budget.ts`      | Monthly budget per category with `rollover` and optional `flexType`.                                                                                                                                                                                                                   |
| RecurringItem                                                           | `recurring.ts`   | Bills, subscriptions, income; `decision` keep/cancel/review; `priceHistory` for price-increase alerts.                                                                                                                                                                                 |
| Security, Holding, TaxLot, InvestmentActivity, RealizedGain, PricePoint | `investment.ts`  | Lots come from the broker (`source: 'broker'`) or are derived from activities (`'derived'`, FIFO in `investments/lots.ts`). NSE and BSE are exchange codes.                                                                                                                            |
| Receipt                                                                 | `receipt.ts`     | `r2Key`, merchant, date, total, tip, line items, `matchedTransactionId`, status.                                                                                                                                                                                                       |
| FxRate                                                                  | `fx.ts`          | Stored with base USD. `source` openexchangerates (hourly latest) or frankfurter_ecb (daily).                                                                                                                                                                                           |
| Settings, MoneyPolicies                                                 | `settings.ts`    | `displayCurrencyMode` USD/INR/BOTH/NATIVE, `aiEnabled`, `aiProvider`, `look` midnight/warm/compact, haptics, dashboard layout, policies.                                                                                                                                               |
| ConnectorDefinition, Connection, adapter contract                       | `connector.ts`   | Registry entries; one Connection per login; `ConnectorAdapter.sync()` returns `SyncResult` with amounts already in the model's sign rule.                                                                                                                                              |

## Money policies (defaults from the brief)

`DEFAULT_MONEY_POLICIES` in `settings.ts`, applied by `reportTreatment` in `policy/treatment.ts`:

- Transfers between own accounts, credit card payments and brokerage/retirement contributions are not spending or income.
- Loan payments are split: principal (`kind: 'loan_payment'`) is excluded, interest (a regular line in an interest category) is spending.
- A refund (money in, expense category) reduces that category in the month it posts. A category can go negative (`categoryFloor: 'none'`).
- Pending transactions count until they post.
- Spending reports convert each transaction with the rate on its date; balances use the latest rate; a linked cross-currency transfer keeps its own rate.

Each option has an alternative value so Settings can change it later; tests cover both.

## What protects data integrity

These map to the build checks in `research/sure/rea.md` (see `docs/backend-plan.md`):

- One transaction per provider id: `(accountId, source, externalId)` is unique.
- Re-imports of files without ids match on `importFingerprint`, which includes an occurrence number, so two identical coffees stay two rows and a second import adds nothing.
- `userEditedFields` lists fields the user changed; sync, rules and AI leave them alone.
- Splits must add up to the parent exactly (`validateSplit`), carry an `idempotencyKey`, and are written in one D1 batch.
- Rejected transfer links stay stored so the matcher never proposes them again.
