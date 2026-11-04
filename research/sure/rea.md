# Sure: REA research handoff (source review)

Reviewed November 4, 2026. Source: [we-promise/sure](https://github.com/we-promise/sure), commit `6bcb6268d39ad08183201b24e2fd8479ef73062e`.

All monetary amounts in the acceptance examples below are invented test values. No user account identifiers, balances, screenshots, credentials, or session captures are included.

Method: direct source inspection of selected models, controllers, and schema. Sure was not run, its tests were not executed, and no account or bank data was used. This is **source evidence, not an REA runtime teardown**. REA's own workflow recommends ordinary repository tools when complete source is available.

Sure is distributed under AGPLv3. This report describes behavior and suggests original requirements; it does not copy implementation code. Any later source reuse must preserve applicable license requirements. [License](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/LICENSE)

## SURE-001: Budget treatment needs more detail than a transfer flag

**Status: observed. Evidence type: source code.** The transaction model defines different kinds for regular transactions, movements of funds, credit-card payments, loan payments, one-time transactions, and investment contributions. Its budget exclusion list contains funds movements, one-time transactions, and credit-card payments. Loan payments and investment contributions are intentionally outside that exclusion list.

Source: [transaction.rb, kind definitions and exclusion lists](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/transaction.rb#L67).

**Recommendation:** keep transaction classification separate from budget inclusion. Decide explicitly whether investment contributions and loan principal should count toward the user's spending budget. Do not assume Sure's choices are the user's choices.

**Acceptance example:** a $200 purchase and the later $200 credit-card payment should not produce $400 of purchase spending. A brokerage contribution needs its own explicit budget policy.

**Limitation:** definitions and comments are observed; all downstream analytics call sites have not been audited.

## SURE-002: Splits preserve a parent and validate the total

**Status: observed. Evidence type: source code.** A split creates child entries, requires their amounts to equal the original amount, and marks the parent excluded. Undo removes the children and restores the parent. Guarded split, resplit, and unsplit methods serialize changes through a split lock. Initial eligibility excludes transfers, pending transactions, existing children/parents, and excluded entries.

Sources: [entry.rb split operations](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/entry.rb#L516), [eligibility](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/transaction/splittable.rb#L1), [controller](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/controllers/splits_controller.rb#L10).

**Recommendation:** make split changes atomic and reversible, and prevent a double click or concurrent rule run from duplicating children. Use exact decimal or minor-unit arithmetic.

**Acceptance example:** splitting $100 into $60 and $40 preserves $100 total spending; $60 and $50 is rejected; undo restores one original transaction. Two concurrent submissions must not create four children.

**Limitation:** race handling is visible in source, not verified by a running concurrency test in this pass.

## SURE-003: Import matching must preserve legitimate repeated purchases

**Status: observed. Evidence type: source code.** CSV import tracks existing entry IDs already matched within the current import. It updates matched entries rather than inserting duplicates and sets an import-protection flag. Its matching call supplies date, amount, currency, name, and already-claimed IDs. The adapter's default matcher uses the same account, transaction type, exact amount/currency/date, optional exact name, and entries without an external ID; it prefers the oldest candidate for exact-date matching.

Sources: [transaction_import.rb](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/transaction_import.rb#L2), [matching method](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/account/provider_import_adapter.rb#L784).

**Recommendation:** distinguish repeat imports from two legitimate identical purchases. Prefer stable provider IDs when present, and make heuristic matches explainable. Preserve user corrections during sync.

**Acceptance example:** two identical $5 coffee rows can represent two purchases. Importing that file again should not add two more. Transactions in different accounts must not merge merely because date and amount match.

**Limitation:** this pass inspected the CSV path and selected adapter sections, not every provider or historical import format.

## SURE-004: Provider identity and pending-to-posted reconciliation are explicit

**Status: observed. Evidence type: source code and schema.** The adapter looks up provider transactions by account, source, and external ID. The schema enforces a unique index for that tuple when source and external ID are present. The adapter includes pending-to-posted reconciliation using a provider's linking ID, with matching fallbacks. It has separate handling for locked financial fields.

Sources: [adapter](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/account/provider_import_adapter.rb#L37), [entry schema and indexes](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/db/schema.rb#L709).

**Recommendation:** implement idempotent provider imports and a pending-to-posted transition before enabling live bank sync. Store which fields the user has overridden. Require an explicit policy for changed amounts, tips, and changed provider IDs.

**Acceptance example:** a pending restaurant purchase followed by its posted version should become one transaction; a subsequent sync should preserve a user-edited category.

**Limitation:** this is an acceptance requirement proposal, not proof that every Sure provider passes the example.

## SURE-005: Category refunds are netted with a floor

**Status: observed. Evidence type: source code.** The budget category spending method subtracts category income/refund totals from expense totals and floors the result at zero.

Source: [budget.rb](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/app/models/budget.rb#L418).

**Recommendation:** define refund treatment for the user's app, including refunds received in a later month. A zero floor is a product choice; it is not universally the correct accounting rule.

**Acceptance example:** $100 of purchases and a $30 refund in the same category produce $70 net spending under this policy. A refund larger than current-period expense produces zero category spending under this particular method.

**Limitation:** classification feeding those totals and cross-period refund behavior remain unverified.

## SURE-006: Monetary values and operation identity are persistent data

**Status: observed. Evidence type: schema.** Entries store amounts in a decimal column with precision 19 and scale 4, a currency, account and source identifiers, parent-entry relationships, and override/import-protection metadata. An account-scoped unique idempotency-key index is also present.

Source: [entries schema](https://github.com/we-promise/sure/blob/6bcb6268d39ad08183201b24e2fd8479ef73062e/db/schema.rb#L709).

**Recommendation:** use exact money arithmetic and persist operation identities. Select the precision and currency conversion policy deliberately for our stack rather than copying the schema wholesale.

## Open questions

**Status: unknown.** Running UI behavior, provider reliability, animation, recurring-charge detection quality, multi-currency edge cases, and cross-month refund behavior were not established in this pass. Follow-up work should answer these with focused code traces and/or a demo containing synthetic data.

## Suggested immediate build checks

These are original acceptance checks derived from the findings, not a request to replace the settled architecture:

1. Prevent transfer and card-payment double counting.
2. Preserve legitimate duplicate purchases while making repeat imports idempotent.
3. Ensure split totals balance, split writes are atomic, and undo works.
4. Preserve explicit user overrides through subsequent imports.
5. Define refund and investment-contribution policies in the requirements.

Claude should reconcile these with the project's brief and requirements before implementing changes.

## Handoff and publication scope

Publish only `research/sure/rea.md` and `research/sure/features-chatgpt.csv` for this batch. Do not merge the older local `research/sure-first-pass` branch, which contains additional files outside the current publication scope. Do not modify the shared `research/features.csv`.

Use the user's verified personal GitHub connection. The computer's saved work Git credentials and default Chrome profile must not be used. Commit small batches to `main` and run `git pull --rebase` immediately before each push using the personal connection. If another agent has changed these files, preserve and reconcile its work before publishing. The initial source review is complete; all five-app research is not complete.
