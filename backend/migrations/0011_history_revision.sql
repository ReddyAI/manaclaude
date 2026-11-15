-- Fixed-size optimistic fence. Triggers cover every SQL writer, including maintenance,
-- undo, raw/bulk writes and future callers. No financial rows are rewritten.
-- Random revisions avoid counter overflow and reuse after restoring a full backup.
CREATE TABLE history_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision TEXT NOT NULL CHECK (length(revision) = 64)
);
INSERT INTO history_revision VALUES (1, lower(hex(randomblob(32))));

CREATE TRIGGER history_revision_transactions_insert
AFTER INSERT ON transactions
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_transactions_update
AFTER UPDATE ON transactions
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_transactions_delete
AFTER DELETE ON transactions
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_bank_reviews_insert
AFTER INSERT ON history_bank_reviews
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_bank_reviews_update
AFTER UPDATE ON history_bank_reviews
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_bank_reviews_delete
AFTER DELETE ON history_bank_reviews
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_policy_insert
AFTER INSERT ON history_policy
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_policy_update
AFTER UPDATE ON history_policy
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_history_policy_delete
AFTER DELETE ON history_policy
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_accounts_insert
AFTER INSERT ON accounts
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_accounts_delete
AFTER DELETE ON accounts
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_accounts_update
AFTER UPDATE ON accounts WHEN OLD.id IS NOT NEW.id OR OLD.type IS NOT NEW.type OR OLD.currency IS NOT NEW.currency OR OLD.connection_id IS NOT NEW.connection_id OR OLD.external_id IS NOT NEW.external_id
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_imports_insert
AFTER INSERT ON imports WHEN NEW.status = 'committed'
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_imports_delete
AFTER DELETE ON imports WHEN OLD.status = 'committed'
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;

CREATE TRIGGER history_revision_imports_update
AFTER UPDATE ON imports WHEN (OLD.status = 'committed' OR NEW.status = 'committed') AND (OLD.status IS NOT NEW.status OR OLD.preview IS NOT NEW.preview)
BEGIN
  UPDATE history_revision SET revision = lower(hex(randomblob(32))) WHERE id = 1;
END;
