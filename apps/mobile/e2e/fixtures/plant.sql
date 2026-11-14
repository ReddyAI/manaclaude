-- Rows no route can make, planted after POST /v1/dev/seed. Invented data only.
-- The local Worker's sample rates cover USD, INR and EUR, so CHF has no rate.

-- Blocks O and R: VTI held, bought and priced in CHF.
UPDATE holdings SET currency = 'CHF' WHERE id = 'hold_brokerage_vti';
UPDATE tax_lots SET currency = 'CHF' WHERE holding_id = 'hold_brokerage_vti';
UPDATE investment_activities SET currency = 'CHF' WHERE security_id = 'sec_vti';

-- Block O: a bill in CHF.
UPDATE recurring_items SET currency = 'CHF' WHERE id = 'rec_internet';

-- Look for transfers now: two halves of a transfer between own accounts, not yet linked.
INSERT INTO transactions (
  id, account_id, date, amount, currency, original_amount, original_currency,
  name, raw_name, kind, source, created_at, updated_at
) VALUES
  ('txn_e2e_move_out', 'acc_checking', date('now', '-2 day'), -43210, 'USD', -43210, 'USD',
   'E2E move to savings', 'E2E MOVE TO SAVINGS', 'regular', 'manual',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('txn_e2e_move_in', 'acc_savings', date('now', '-2 day'), 43210, 'USD', 43210, 'USD',
   'E2E move from checking', 'E2E MOVE FROM CHECKING', 'regular', 'manual',
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
