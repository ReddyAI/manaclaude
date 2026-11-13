-- Bounded scheduled work. No financial records are rewritten by this migration.
CREATE TABLE nightly_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE nightly_guard (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valid INTEGER NOT NULL CHECK (valid = 1)
);
-- A paged, rebuilt index of JS-normalized names; never a second source of account data.
CREATE TABLE nightly_names (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  name_key TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX nightly_names_key ON nightly_names(kind, name_key, id);
CREATE TABLE nightly_rows (
  id TEXT PRIMARY KEY,
  recurring_key TEXT NOT NULL,
  alert_key TEXT NOT NULL,
  duplicate_key TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  data TEXT NOT NULL,
  history INTEGER NOT NULL,
  recent INTEGER NOT NULL,
  recurring_usable INTEGER NOT NULL
);
CREATE INDEX nightly_rows_recurring ON nightly_rows(recurring_key, recurring_usable, date, id);
CREATE INDEX nightly_rows_alert ON nightly_rows(alert_key, history, amount, id);
CREATE INDEX nightly_rows_recent ON nightly_rows(alert_key, recent, id);
CREATE INDEX nightly_rows_duplicate ON nightly_rows(duplicate_key, recent, date, json_extract(data, '$.createdAt'), id);
CREATE INDEX nightly_rows_unidentified ON nightly_rows(duplicate_key, recent,
  (json_extract(data, '$.source') = 'connector' AND COALESCE(json_extract(data, '$.externalId'), '') != ''),
  date, json_extract(data, '$.createdAt'), id);
CREATE INDEX nightly_rows_external ON nightly_rows(duplicate_key, recent,
  json_extract(data, '$.externalId'), date, json_extract(data, '$.createdAt'), id);
CREATE INDEX nightly_rows_pending ON nightly_rows(duplicate_key, recent,
  json_extract(data, '$.pendingExternalId'), date, json_extract(data, '$.createdAt'), id);
CREATE TABLE nightly_groups (
  key TEXT PRIMARY KEY,
  history_count INTEGER NOT NULL
);
CREATE TABLE nightly_categories (
  id TEXT PRIMARY KEY,
  current INTEGER NOT NULL,
  previous INTEGER NOT NULL
);
CREATE INDEX nightly_categories_current ON nightly_categories(current DESC, id);
CREATE INDEX transactions_nightly_merchant ON transactions(id) WHERE merchant_id IS NULL AND is_split_parent = 0;
CREATE INDEX transactions_nightly_category ON transactions(id) WHERE is_split_parent = 0 AND (category_id IS NULL OR category_source = 'ai');
CREATE INDEX fx_rates_nightly_lookup ON fx_rates(base, quote, date, as_of);
CREATE INDEX balance_snapshots_nightly_lookup ON balance_snapshots(account_id, date);
CREATE INDEX ai_examples_nightly_name ON ai_examples(normalized_name, created_at DESC);
CREATE TABLE fx_latest_progress (
  source TEXT PRIMARY KEY,
  last_quote TEXT NOT NULL DEFAULT ''
);
