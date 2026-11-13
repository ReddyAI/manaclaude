import {
  ACTIVE_TRANSFER_LINK_STATUSES,
  mergeRespectingUserEdits,
  normalizeDescription,
  type Merchant,
  type Transaction,
} from '@manaclaude/shared';
import { runMerchantCleanup } from '../ai/jobs/merchants';
import { runCategorization, type CategorizeScope } from '../ai/jobs/categorize';
import { merchantKey } from '../ai/merchant';
import type { AiDeps } from '../ai/provider';
import { updateStatement } from '../db/table';
import {
  categoriesTable,
  merchantsTable,
  transactionsTable,
  transferLinksTable,
} from '../db/tables';
import type { Env } from '../env';
import { byIds, nameWrites, named, page, PAGE, unchanged } from './store';

export async function cleanPage(env: Env, after: string, deps: AiDeps) {
  const transactions = await page(
    env.DB,
    transactionsTable,
    after,
    PAGE,
    'merchant_id IS NULL AND is_split_parent = 0',
  );
  const writes: D1PreparedStatement[] = [];
  let touched: Merchant[] = [];
  await runMerchantCleanup(env, deps, {
    transactions: transactions.filter((t) => !t.merchantId && !t.isSplitParent),
    merchants: async (names) => {
      const merchants = await named(
        env.DB,
        merchantsTable,
        'merchant',
        names.map(normalizeDescription),
      );
      writes.push(unchanged(env.DB, merchantsTable, merchants));
      return merchants.filter((m) =>
        names.some((n) => normalizeDescription(n) === normalizeDescription(m.name)),
      );
    },
    touched: (merchants) => {
      touched = merchants;
    },
    save: async (statements) => {
      writes.push(...statements);
    },
  });
  writes.push(
    ...nameWrites(
      env.DB,
      'merchant',
      touched.map((m) => ({ id: m.id, key: normalizeDescription(m.name) })),
    ),
  );
  return { transactions, writes };
}

export interface CategorizeCursor {
  categoryAfter: string;
  versions: string;
  proposals: Record<string, { categoryId: string; confidence: number }>;
}
export async function categorizePage(
  env: Env,
  after: string,
  deps: AiDeps,
  cursor: CategorizeCursor | null,
) {
  const transactions = await page(
    env.DB,
    transactionsTable,
    after,
    PAGE,
    "is_split_parent = 0 AND (category_id IS NULL OR category_source = 'ai')",
  );
  const candidates = transactions.filter(
    (t) => !t.isSplitParent && (!t.categoryId || t.categorySource === 'ai'),
  );
  const writes: D1PreparedStatement[] = [];
  if (!candidates.length) return { transactions, writes, cursor: null };
  const versions = JSON.stringify(candidates.map((t) => [t.id, t.updatedAt, t.userEditedFields]));
  if (!cursor || cursor.versions !== versions)
    cursor = { categoryAfter: '', versions, proposals: {} };
  const links = await byIds(
    env.DB,
    transferLinksTable,
    candidates.map((t) => t.transferLinkId),
  );
  const merchants = await byIds(
    env.DB,
    merchantsTable,
    candidates.map((t) => t.merchantId),
  );
  const keys = [...new Set(candidates.map((t) => merchantKey(t.rawName)))];
  // Exact latest correction per candidate, not the newest N corrections globally.
  const examples = await env.DB.prepare(
    `SELECT e.normalized_name, e.raw_name, e.category_id, e.amount
    FROM json_each(?) j JOIN ai_examples e ON e.rowid = (
      SELECT rowid FROM ai_examples WHERE normalized_name = j.value ORDER BY created_at DESC LIMIT 1)`,
  )
    .bind(JSON.stringify(keys))
    .all<CategorizeScope['examples'][number]>();
  // Visit every vocabulary page, keeping only the best proposal per transaction.
  // No unbounded category list and no permanent first-page-only vocabulary.
  const vocabulary = await page(env.DB, categoriesTable, cursor.categoryAfter, 64);
  const exact = await byIds(env.DB, categoriesTable, [
    ...examples.results.map((e) => e.category_id),
    ...merchants.map((m) => m.defaultCategoryId),
  ]);
  const categories = [...new Map([...vocabulary, ...exact].map((c) => [c.id, c])).values()].filter(
    (c) => !c.archived,
  );
  await runCategorization(env, {}, deps, {
    candidates,
    categories,
    merchants,
    examples: examples.results,
    activeLinks: new Set(
      links.filter((l) => ACTIVE_TRANSFER_LINK_STATUSES.includes(l.status)).map((l) => l.id),
    ),
    proposed: (proposals, authoritative) => {
      for (const [id, p] of proposals)
        if (
          authoritative.has(id) ||
          !cursor!.proposals[id] ||
          p.confidence > cursor!.proposals[id]!.confidence
        )
          cursor!.proposals[id] = p;
    },
    save: async () => {},
  });
  if (vocabulary.length === 64) {
    cursor.categoryAfter = vocabulary.at(-1)!.id;
    return { transactions, writes, cursor };
  }
  const validCategories = new Set(
    (
      await byIds(
        env.DB,
        categoriesTable,
        Object.values(cursor.proposals).map((p) => p.categoryId),
      )
    )
      .filter((c) => !c.archived)
      .map((c) => c.id),
  );
  for (const t of candidates) {
    const p = cursor.proposals[t.id];
    if (!p || !validCategories.has(p.categoryId)) continue;
    const { transaction } = mergeRespectingUserEdits(t, {
      categoryId: p.categoryId,
      categorySource: 'ai',
      aiCategoryConfidence: p.confidence,
    });
    if (
      transaction.categoryId === t.categoryId &&
      transaction.aiCategoryConfidence === t.aiCategoryConfidence &&
      transaction.categorySource === t.categorySource
    )
      continue;
    writes.push(
      updateStatement(
        env.DB,
        transactionsTable,
        { id: t.id },
        {
          categoryId: transaction.categoryId,
          categorySource: transaction.categorySource,
          aiCategoryConfidence: transaction.aiCategoryConfidence,
          updatedAt: new Date().toISOString(),
        },
      ),
    );
  }
  return { transactions, writes, cursor: null };
}

export function recurringKey(t: Transaction) {
  return JSON.stringify([t.accountId, merchantKey(t.rawName), Math.sign(t.amount)]);
}
export function alertKey(t: Transaction) {
  return JSON.stringify([t.currency, merchantKey(t.rawName)]);
}
export function duplicateKey(t: Transaction) {
  return JSON.stringify([t.accountId, t.amount, normalizeDescription(t.rawName)]);
}
export function recurringNameKey(accountId: string, name: string, amount: number) {
  return JSON.stringify([accountId, merchantKey(name), Math.sign(amount)]);
}
