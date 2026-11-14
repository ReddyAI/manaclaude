-- Balance provenance for previously imported/legacy accounts after an explicit edit.
CREATE TABLE manual_balance_overrides (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  current_balance_known INTEGER NOT NULL CHECK (current_balance_known IN (0, 1)),
  cash_generation INTEGER NOT NULL DEFAULT 0
);

-- Preserve creation retry identity even after intentional account deletion.
CREATE TABLE deleted_manual_accounts (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  account_id TEXT NOT NULL
);

-- Ephemeral constraint guard: inserted and removed in the same atomic D1 batch.
CREATE TABLE account_write_guard (
  token TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

-- Record the balance effect independently of editable transaction amounts.
-- Old amount edits cannot be reconstructed: NULL means refuse reversal until
-- an explicit cash balance establishes a new baseline.
CREATE TABLE cash_entry_effects (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  amount INTEGER,
  generation INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cash_entry_effects_account ON cash_entry_effects(account_id);
INSERT INTO cash_entry_effects (transaction_id, account_id, amount)
SELECT t.id, t.account_id,
  CASE WHEN EXISTS (SELECT 1 FROM json_each(t.user_edited_fields) WHERE value = 'amount')
    THEN NULL ELSE t.amount END
FROM transactions t JOIN accounts a ON a.id = t.account_id
WHERE a.type = 'cash' AND t.source = 'manual' AND t.external_id IS NULL
  AND t.connection_id IS NULL AND t.import_id IS NULL AND t.import_fingerprint IS NULL
  AND t.split_parent_id IS NULL;

CREATE INDEX recurring_account ON recurring_items(account_id);
CREATE INDEX holdings_account ON holdings(account_id);
CREATE INDEX activities_account ON investment_activities(account_id);
CREATE INDEX imports_account ON imports(account_id);
CREATE INDEX import_mappings_account ON import_mappings(account_id);
CREATE INDEX receipts_transaction ON receipts(matched_transaction_id);
CREATE INDEX transfer_links_out ON transfer_links(out_transaction_id);
CREATE INDEX transfer_links_in ON transfer_links(in_transaction_id);
