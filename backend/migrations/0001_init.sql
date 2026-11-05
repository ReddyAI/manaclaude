-- Mana D1 schema. Money is INTEGER minor units next to a TEXT currency code.
-- Quantities and prices are TEXT decimals. Booleans are INTEGER 0/1.
-- JSON columns hold arrays and small objects.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  institution_name TEXT NOT NULL,
  status TEXT NOT NULL,
  last_sync_at TEXT,
  last_successful_sync_at TEXT,
  last_error TEXT,
  sync_cursor TEXT,
  account_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE connector_slots (
  connector_id TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  institution_name TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  currency TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  balance_as_of TEXT NOT NULL,
  available_balance INTEGER,
  credit_limit INTEGER,
  mask TEXT,
  connection_id TEXT,
  external_id TEXT,
  include_in_net_worth INTEGER NOT NULL DEFAULT 1,
  hidden INTEGER NOT NULL DEFAULT 0,
  is_default_cash INTEGER NOT NULL DEFAULT 0,
  interest_rate TEXT,
  opened_on TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX accounts_provider ON accounts (connection_id, external_id)
  WHERE connection_id IS NOT NULL AND external_id IS NOT NULL;

CREATE TABLE balance_snapshots (
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  balance INTEGER NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (account_id, date)
);

CREATE TABLE category_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  exclude_from_budget INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  "order" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_category_id TEXT,
  aliases TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  match TEXT NOT NULL,
  conditions TEXT NOT NULL,
  actions TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  original_amount INTEGER NOT NULL,
  original_currency TEXT NOT NULL,
  name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  merchant_id TEXT,
  category_id TEXT,
  category_source TEXT,
  ai_category_confidence REAL,
  kind TEXT NOT NULL DEFAULT 'regular',
  pending INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tag_ids TEXT NOT NULL DEFAULT '[]',
  excluded INTEGER NOT NULL DEFAULT 0,
  transfer_link_id TEXT,
  receipt_id TEXT,
  recurring_id TEXT,
  split_parent_id TEXT,
  is_split_parent INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  reviewed_at TEXT,
  user_edited_fields TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  connection_id TEXT,
  external_id TEXT,
  pending_external_id TEXT,
  import_id TEXT,
  import_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One transaction per provider id (research/sure/rea.md SURE-004).
CREATE UNIQUE INDEX transactions_provider_id ON transactions (account_id, source, external_id)
  WHERE external_id IS NOT NULL;
-- Repeat imports of files without ids match on the fingerprint (SURE-003).
CREATE UNIQUE INDEX transactions_fingerprint ON transactions (account_id, import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;
CREATE INDEX transactions_date ON transactions (date);
CREATE INDEX transactions_account_date ON transactions (account_id, date);
CREATE INDEX transactions_split_parent ON transactions (split_parent_id)
  WHERE split_parent_id IS NOT NULL;

CREATE TABLE transfer_links (
  id TEXT PRIMARY KEY,
  out_transaction_id TEXT NOT NULL,
  in_transaction_id TEXT NOT NULL,
  out_amount INTEGER NOT NULL,
  out_currency TEXT NOT NULL,
  in_amount INTEGER NOT NULL,
  in_currency TEXT NOT NULL,
  implied_rate REAL NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  match_score REAL,
  matched_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- A pair is stored once, whatever its status, so a rejected pair is never proposed again.
CREATE UNIQUE INDEX transfer_links_pair ON transfer_links (out_transaction_id, in_transaction_id);
-- A transaction is in at most one active link.
CREATE UNIQUE INDEX transfer_links_active_out ON transfer_links (out_transaction_id)
  WHERE status IN ('auto', 'confirmed');
CREATE UNIQUE INDEX transfer_links_active_in ON transfer_links (in_transaction_id)
  WHERE status IN ('auto', 'confirmed');

CREATE TABLE split_locks (
  parent_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  subject_id TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  rollover INTEGER NOT NULL DEFAULT 0,
  flex_type TEXT
);
CREATE UNIQUE INDEX budgets_category_month ON budgets (category_id, month);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  target_date TEXT,
  account_ids TEXT NOT NULL DEFAULT '[]',
  manual_progress INTEGER,
  color TEXT NOT NULL
);

CREATE TABLE recurring_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  merchant_id TEXT,
  category_id TEXT,
  account_id TEXT,
  kind TEXT NOT NULL,
  frequency TEXT NOT NULL,
  expected_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  is_variable INTEGER NOT NULL DEFAULT 0,
  last_date TEXT,
  next_due_date TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  price_history TEXT NOT NULL DEFAULT '[]',
  detected_by TEXT NOT NULL,
  ai_confidence REAL
);

CREATE TABLE securities (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  exchange TEXT,
  currency TEXT NOT NULL,
  isin TEXT,
  asset_class TEXT NOT NULL,
  is_benchmark INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE holdings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  security_id TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT NOT NULL,
  price_as_of TEXT NOT NULL,
  market_value INTEGER NOT NULL,
  cost_basis INTEGER,
  currency TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE TABLE tax_lots (
  id TEXT PRIMARY KEY,
  holding_id TEXT NOT NULL,
  acquired_on TEXT NOT NULL,
  quantity TEXT NOT NULL,
  cost_basis INTEGER NOT NULL,
  currency TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT
);

CREATE TABLE investment_activities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  security_id TEXT,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  quantity TEXT,
  price TEXT,
  amount INTEGER NOT NULL,
  fees INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  split_ratio TEXT,
  external_id TEXT,
  source TEXT NOT NULL
);
CREATE UNIQUE INDEX activities_provider_id ON investment_activities (account_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE prices (
  security_id TEXT NOT NULL,
  date TEXT NOT NULL,
  close TEXT NOT NULL,
  currency TEXT NOT NULL,
  PRIMARY KEY (security_id, date)
);

CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  merchant TEXT,
  date TEXT,
  total INTEGER,
  subtotal INTEGER,
  tax INTEGER,
  tip INTEGER,
  currency TEXT,
  line_items TEXT NOT NULL DEFAULT '[]',
  matched_transaction_id TEXT,
  status TEXT NOT NULL,
  ai_confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fx_rates (
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  rate REAL NOT NULL,
  as_of TEXT NOT NULL,
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (base, quote, date, source)
);
CREATE INDEX fx_rates_pair_date ON fx_rates (base, quote, date);

-- File imports and the statement vault. The original file stays in R2 under r2_key.
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  account_id TEXT,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_added INTEGER NOT NULL DEFAULT 0,
  rows_matched INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  preview TEXT,
  error TEXT,
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX imports_sha ON imports (sha256);

-- Saved CSV column mappings, keyed by the file's header signature.
CREATE TABLE import_mappings (
  signature TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT,
  mapping TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Category corrections the AI learns from (also kept as learned rules).
CREATE TABLE ai_examples (
  id TEXT PRIMARY KEY,
  normalized_name TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  category_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX ai_examples_name ON ai_examples (normalized_name);

-- Duplicate, unusual-charge and price-change alerts.
CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  transaction_id TEXT,
  recurring_id TEXT,
  message TEXT NOT NULL,
  amount INTEGER,
  currency TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT
);
CREATE UNIQUE INDEX alerts_unique ON alerts (type, transaction_id) WHERE transaction_id IS NOT NULL;

-- Weekly recaps and Month in Review (the shared Recap shape, stored whole in data).
CREATE TABLE recaps (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX recaps_period ON recaps (kind, period_start);

-- AI calls per day and provider, to stay inside the free Workers AI allowance.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);
