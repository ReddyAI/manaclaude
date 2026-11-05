import {
  ACTIVE_TRANSFER_LINK_STATUSES,
  mergeRespectingUserEdits,
  type AiJobResponse,
  type Id,
  type Transaction,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { batchInChunks, selectAll, updateStatement } from '../../db/table';
import {
  categoriesTable,
  merchantsTable,
  transactionsTable,
  transferLinksTable,
} from '../../db/tables';
import { nowIso } from '../../util/ids';
import { getSettings } from '../../services/settings';
import { merchantKey } from '../merchant';
import { completeJson, tryGetAi, type AiDeps, type JsonSchema } from '../provider';

const SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['id', 'category', 'confidence'],
      },
    },
  },
  required: ['results'],
};

/** Confidence given to a category copied from the user's own earlier correction. */
export const LEARNED_CONFIDENCE = 0.95;
const BATCH = 40;

export interface CategorizeOptions {
  /** Specific transactions (after an import or sync). */
  ids?: Id[];
  /** Re-check every transaction, not only uncategorized and AI-set ones. */
  all?: boolean;
}

/**
 * Categorization with a confidence score:
 * 1. the user's own corrections (learned examples) for the same merchant
 * 2. the merchant's default category
 * 3. the AI for the rest, with few-shot examples from past corrections
 * Every change goes through mergeRespectingUserEdits, so a category the user
 * set is never touched. With AI off, steps 1 and 2 still run.
 */
export async function runCategorization(
  env: Env,
  options: CategorizeOptions = {},
  deps: AiDeps = {},
): Promise<AiJobResponse> {
  const db = env.DB;
  const settings = await getSettings(db);
  let candidates: Transaction[];
  if (options.ids) {
    candidates = [];
    for (let i = 0; i < options.ids.length; i += 90) {
      const chunk = options.ids.slice(i, i + 90);
      candidates.push(
        ...(await selectAll(
          db,
          transactionsTable,
          `id IN (${chunk.map(() => '?').join(',')})`,
          chunk,
        )),
      );
    }
  } else if (options.all) {
    candidates = await selectAll(db, transactionsTable, 'is_split_parent = 0');
  } else {
    candidates = await selectAll(
      db,
      transactionsTable,
      "is_split_parent = 0 AND (category_id IS NULL OR category_source = 'ai')",
    );
  }
  const activeLinks = new Set(
    (await selectAll(db, transferLinksTable))
      .filter((l) => ACTIVE_TRANSFER_LINK_STATUSES.includes(l.status))
      .map((l) => l.id),
  );
  candidates = candidates.filter(
    (t) =>
      t.amount !== 0 &&
      !t.isSplitParent &&
      !(t.transferLinkId && activeLinks.has(t.transferLinkId)),
  );
  if (candidates.length === 0) return { job: 'categorize', changed: 0, usedAi: false, note: null };

  const [categories, merchants, examples] = await Promise.all([
    selectAll(db, categoriesTable, 'archived = 0'),
    selectAll(db, merchantsTable),
    db
      .prepare(
        'SELECT normalized_name, raw_name, category_id, amount FROM ai_examples ORDER BY created_at DESC LIMIT 500',
      )
      .all<{ normalized_name: string; raw_name: string; category_id: string; amount: number }>(),
  ]);
  const learned = new Map<string, string>();
  for (const e of examples.results)
    if (!learned.has(e.normalized_name)) learned.set(e.normalized_name, e.category_id);
  const merchantDefault = new Map(
    merchants.filter((m) => m.defaultCategoryId).map((m) => [m.id, m.defaultCategoryId!]),
  );
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  const proposals = new Map<Id, { categoryId: Id; confidence: number }>();
  const forAi: Transaction[] = [];
  for (const t of candidates) {
    const fromLearned = learned.get(merchantKey(t.rawName));
    if (fromLearned) {
      proposals.set(t.id, { categoryId: fromLearned, confidence: LEARNED_CONFIDENCE });
    } else if (t.merchantId && merchantDefault.has(t.merchantId)) {
      proposals.set(t.id, { categoryId: merchantDefault.get(t.merchantId)!, confidence: 0.9 });
    } else if (!t.userEditedFields.includes('categoryId')) {
      forAi.push(t);
    }
  }

  const ai = tryGetAi(env, settings, deps);
  let usedAi = false;
  let note: string | null = ai
    ? null
    : 'AI is off; used your corrections and merchant defaults only.';
  if (ai && forAi.length > 0) {
    const fewShot = examples.results
      .slice(0, 30)
      .map(
        (e) => `"${e.raw_name}" -> ${categories.find((c) => c.id === e.category_id)?.name ?? '?'}`,
      )
      .join('\n');
    for (let i = 0; i < forAi.length; i += BATCH) {
      const batch = forAi.slice(i, i + BATCH);
      try {
        const reply = await completeJson<{
          results: { id: string; category: string; confidence: number }[];
        }>(ai, {
          system:
            'You categorize personal bank and card transactions. Pick exactly one category name from the list for each transaction. Give a confidence from 0 to 1; use below 0.6 when you are guessing. Money in (positive amounts) is usually income or a refund. Return JSON only.',
          prompt: `Categories: ${categories.map((c) => `${c.name} (${c.kind})`).join(', ')}\n\n${
            fewShot ? `The user corrected these before:\n${fewShot}\n\n` : ''
          }Transactions (id | description | signed amount):\n${batch
            .map((t) => `${t.id} | ${t.rawName} | ${(t.amount / 100).toFixed(2)} ${t.currency}`)
            .join('\n')}`,
          schema: SCHEMA,
          maxTokens: 4000,
        });
        usedAi = true;
        for (const r of reply.results ?? []) {
          const cat = categoryByName.get(String(r.category).toLowerCase());
          if (!cat || !batch.some((t) => t.id === r.id)) continue;
          proposals.set(r.id, {
            categoryId: cat.id,
            confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
          });
        }
      } catch (e) {
        note = e instanceof Error ? e.message : 'The AI call failed.';
        break;
      }
    }
  }

  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  const byId = new Map(candidates.map((t) => [t.id, t]));
  for (const [id, p] of proposals) {
    const t = byId.get(id);
    if (!t) continue;
    const { transaction } = mergeRespectingUserEdits(t, {
      categoryId: p.categoryId,
      categorySource: 'ai',
      aiCategoryConfidence: p.confidence,
    });
    if (
      transaction.categoryId === t.categoryId &&
      transaction.categorySource === t.categorySource &&
      transaction.aiCategoryConfidence === t.aiCategoryConfidence
    ) {
      continue;
    }
    statements.push(
      updateStatement(
        db,
        transactionsTable,
        { id },
        {
          categoryId: transaction.categoryId,
          categorySource: transaction.categorySource,
          aiCategoryConfidence: transaction.aiCategoryConfidence,
          updatedAt: now,
        },
      ),
    );
  }
  await batchInChunks(db, statements);
  return { job: 'categorize', changed: statements.length, usedAi, note };
}
