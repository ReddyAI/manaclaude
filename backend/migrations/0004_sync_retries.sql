-- Retry scheduling stays backend-only; connection status and the provider cursor keep their meaning.
CREATE TABLE sync_retries (
  connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 5),
  next_retry_at INTEGER NOT NULL
);
