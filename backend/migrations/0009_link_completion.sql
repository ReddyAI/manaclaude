-- Completed results contain app connection IDs only, never provider credentials.
ALTER TABLE link_sessions ADD COLUMN completion_json TEXT;
ALTER TABLE link_sessions ADD COLUMN lease_token TEXT;
ALTER TABLE link_sessions ADD COLUMN lease_expires_at TEXT;

-- Inserted and removed inside one atomic D1 batch to fence stale finalizers.
CREATE TABLE link_write_guard (
  token TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
