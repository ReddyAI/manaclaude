-- Current inventory evidence is independent of bank transaction-history policy.
CREATE TABLE investment_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision TEXT NOT NULL
);
INSERT INTO investment_revision VALUES (1, lower(hex(randomblob(32))));
CREATE TABLE investment_write_guard (
  token TEXT PRIMARY KEY,
  investment_valid INTEGER NOT NULL CHECK (investment_valid = 1)
);
-- Immutable copies of replaced/removed basis and positions. These are observations,
-- not closed tax lots or fabricated sales. Original IDs and every field are retained.
CREATE TABLE investment_archive (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  holding_id TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('holding', 'lot')),
  record_json TEXT NOT NULL
);
CREATE INDEX investment_archive_holding ON investment_archive (holding_id);
CREATE TRIGGER investment_revision_holdings_insert AFTER INSERT ON holdings
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_holdings_update AFTER UPDATE ON holdings
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_holdings_delete AFTER DELETE ON holdings
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_tax_lots_insert AFTER INSERT ON tax_lots
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_tax_lots_update AFTER UPDATE ON tax_lots
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_tax_lots_delete AFTER DELETE ON tax_lots
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_investment_activities_insert AFTER INSERT ON investment_activities
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_investment_activities_update AFTER UPDATE ON investment_activities
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
CREATE TRIGGER investment_revision_investment_activities_delete AFTER DELETE ON investment_activities
BEGIN
  UPDATE investment_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
