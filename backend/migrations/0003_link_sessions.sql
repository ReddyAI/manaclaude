-- Account linking in progress (session E2). One row per attempt: which
-- connector, which connection it repairs (if any), where the browser goes back
-- to, and when it expires. Anything secret about the attempt (a Sophtron job,
-- SnapTrade state) is stored encrypted in connection_credentials under
-- 'link_<id>', never here.
CREATE TABLE link_sessions (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL,
  connection_id TEXT,
  status TEXT NOT NULL,
  institution_name TEXT,
  return_url TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX link_sessions_expires ON link_sessions (expires_at);
