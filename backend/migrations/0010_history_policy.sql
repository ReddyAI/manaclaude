-- Additive only. No financial history is rewritten or hidden.
CREATE TABLE history_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  review_token TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE history_bank_reviews (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  previous TEXT,
  signature TEXT NOT NULL,
  candidate_ids TEXT NOT NULL,
  decision_token TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'kept', 'skipped', 'obsolete')),
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, external_id)
);
CREATE TABLE history_write_guard (
  token TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
