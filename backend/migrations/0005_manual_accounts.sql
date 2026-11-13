-- Explicit balance provenance and retry identity for the manual creation API.
-- No history-derived balances or changes to existing accounts.
CREATE TABLE manual_account_details (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  opening_balance INTEGER,
  opening_date TEXT,
  current_balance_known INTEGER NOT NULL CHECK (current_balance_known IN (0, 1)),
  CHECK ((opening_balance IS NULL) = (opening_date IS NULL))
);
