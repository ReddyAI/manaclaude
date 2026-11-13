-- FX-only progress. No existing history or rates imply verified coverage.
CREATE TABLE fx_backfill_progress (
  quote TEXT PRIMARY KEY NOT NULL,
  start_date TEXT NOT NULL,
  next_date TEXT NOT NULL,
  CHECK (start_date < next_date)
);
CREATE TABLE fx_backfill_scheduler (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_quote TEXT NOT NULL DEFAULT '',
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
-- Allow discovery by indexed minimum seeks, without enumerating financial rows.
CREATE INDEX accounts_fx_currency ON accounts (currency);
CREATE INDEX transactions_fx_currency ON transactions (currency);
