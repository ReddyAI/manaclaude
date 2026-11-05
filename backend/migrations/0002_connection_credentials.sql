-- Per-login credentials (access tokens, API keys) for connector syncs.
-- Values are encrypted with AES-GCM using a key derived from the Worker secret
-- CREDENTIALS_SECRET, so a copy of the database alone reveals nothing.
CREATE TABLE connection_credentials (
  connection_id TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
