import type { FinanceDataset } from '@manaclaude/shared';
import { SAMPLE_CATEGORIES, SAMPLE_CATEGORY_GROUPS, SAMPLE_TAGS } from '@manaclaude/shared/sample';
import { batchInChunks, insertStatement } from '../db/table';
import {
  accountsTable,
  activitiesTable,
  balanceSnapshotsTable,
  budgetsTable,
  categoriesTable,
  categoryGroupsTable,
  connectionsTable,
  fxRatesTable,
  goalsTable,
  holdingsTable,
  merchantsTable,
  pricesTable,
  receiptsTable,
  recurringTable,
  rulesTable,
  securitiesTable,
  tagsTable,
  taxLotsTable,
  transactionsTable,
  transferLinksTable,
} from '../db/tables';
import { updateSettings } from './settings';

/**
 * Default categories, groups and tags on an empty database. They are generic
 * labels (Groceries, Rent, Transfers...) and safe to ship in a public repo.
 */
export async function ensureDefaultCategories(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT count(*) AS n FROM categories').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) return false;
  await batchInChunks(db, [
    ...SAMPLE_CATEGORY_GROUPS.map((g) => insertStatement(db, categoryGroupsTable, g, 'ignore')),
    ...SAMPLE_CATEGORIES.map((c) => insertStatement(db, categoriesTable, c, 'ignore')),
    ...SAMPLE_TAGS.map((t) => insertStatement(db, tagsTable, t, 'ignore')),
  ]);
  return true;
}

/** Loads a whole dataset (the invented sample data) into an empty database. Local dev only. */
export async function loadDatasetIntoDb(db: D1Database, data: FinanceDataset): Promise<void> {
  const s = (statements: D1PreparedStatement[]) => statements;
  await batchInChunks(db, [
    ...s(data.categoryGroups.map((x) => insertStatement(db, categoryGroupsTable, x, 'upsert'))),
    ...s(data.categories.map((x) => insertStatement(db, categoriesTable, x, 'upsert'))),
    ...s(data.tags.map((x) => insertStatement(db, tagsTable, x, 'upsert'))),
    ...s(data.merchants.map((x) => insertStatement(db, merchantsTable, x, 'upsert'))),
    ...s(data.rules.map((x) => insertStatement(db, rulesTable, x, 'upsert'))),
    ...s(data.connections.map((x) => insertStatement(db, connectionsTable, x, 'upsert'))),
    ...s(data.accounts.map((x) => insertStatement(db, accountsTable, x, 'upsert'))),
    ...s(data.balanceHistory.map((x) => insertStatement(db, balanceSnapshotsTable, x, 'upsert'))),
    ...s(data.transactions.map((x) => insertStatement(db, transactionsTable, x, 'upsert'))),
    ...s(data.transferLinks.map((x) => insertStatement(db, transferLinksTable, x, 'upsert'))),
    ...s(data.budgets.map((x) => insertStatement(db, budgetsTable, x, 'upsert'))),
    ...s(data.goals.map((x) => insertStatement(db, goalsTable, x, 'upsert'))),
    ...s(data.recurring.map((x) => insertStatement(db, recurringTable, x, 'upsert'))),
    ...s(data.securities.map((x) => insertStatement(db, securitiesTable, x, 'upsert'))),
    ...s(data.holdings.map((x) => insertStatement(db, holdingsTable, x, 'upsert'))),
    ...s(data.taxLots.map((x) => insertStatement(db, taxLotsTable, x, 'upsert'))),
    ...s(data.activities.map((x) => insertStatement(db, activitiesTable, x, 'upsert'))),
    ...s(data.prices.map((x) => insertStatement(db, pricesTable, x, 'upsert'))),
    ...s(data.receipts.map((x) => insertStatement(db, receiptsTable, x, 'upsert'))),
    ...s(data.fxRates.map((x) => insertStatement(db, fxRatesTable, x, 'upsert'))),
    ...Object.entries(data.connectorSlotsUsed).map(([id, used]) =>
      db
        .prepare(
          'INSERT INTO connector_slots (connector_id, used) VALUES (?, ?) ON CONFLICT (connector_id) DO UPDATE SET used = excluded.used',
        )
        .bind(id, used),
    ),
  ]);
  await updateSettings(db, data.settings);
}
