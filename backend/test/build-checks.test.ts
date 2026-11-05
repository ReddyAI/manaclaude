import { describe, it } from 'vitest';

/**
 * The five build checks from research/sure/rea.md, as test cases for the
 * D1-backed backend. Session B turns each `it.todo` into a real test against a
 * local D1 database. Full cases with amounts are in docs/backend-plan.md.
 * The pure parts already pass in packages/shared/test/policy.test.ts.
 */

describe('check 1: no double counting of transfers and card payments', () => {
  it.todo('a $200 card purchase plus its $200 payment from checking reports $200 of spending');
  it.todo('the matcher links checking -$200 and card +$200 within 5 days as one card_payment link');
  it.todo(
    'USD 2,000 out and INR 1,76,240 in two days later links as one transfer with impliedRate 88.12',
  );
  it.todo('an ATM withdrawal links to the cash account deposit as atm_withdrawal');
  it.todo(
    're-running the matcher never creates a second link and never re-proposes a rejected pair',
  );
  it.todo('several candidates create suggested links that do not count until confirmed');
});

describe('check 2: repeat imports are idempotent, real duplicates are kept', () => {
  it.todo('a CSV with two identical $5.75 coffees on one day imports two rows');
  it.todo('importing the same CSV again adds nothing');
  it.todo('the same date and amount in a different account is never merged');
  it.todo('a provider transaction with a known externalId updates the row instead of inserting');
  it.todo('a posted transaction replaces its pending version via pendingExternalId');
});

describe('check 3: splits balance exactly, write atomically and undo cleanly', () => {
  it.todo('$100 split into $60 + $40 keeps $100 of spending across two categories');
  it.todo('$60 + $50 for a $100 transaction is rejected and nothing is written');
  it.todo('two concurrent requests with the same idempotency key create one set of children');
  it.todo('undo removes the children and restores the parent in one D1 batch');
});

describe('check 4: user edits survive later syncs', () => {
  it.todo('a user-set category stays after the next sync sends a different category');
  it.todo('a renamed transaction keeps its name after sync; untouched fields still update');
  it.todo('rules and AI never overwrite fields listed in userEditedFields');
});

describe('check 5: refund and investment-contribution policies are explicit', () => {
  it.todo('a $30 refund on a $100 category purchase reports $70 in that category');
  it.todo('a refund in a later month reduces that month and can make the category negative');
  it.todo(
    'a $500 brokerage contribution is excluded from spending by default and counted when the policy says so',
  );
  it.todo('loan principal is excluded and loan interest counts as spending');
});
