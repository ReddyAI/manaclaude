import {
  mergeRespectingUserEdits,
  normalizeDescription,
  type AiJobResponse,
  type Merchant,
} from '@manaclaude/shared';
import type { Env } from '../../env';
import { batchInChunks, insertStatement, selectAll, updateStatement } from '../../db/table';
import { merchantsTable, transactionsTable } from '../../db/tables';
import { newId, nowIso } from '../../util/ids';
import { getSettings } from '../../services/settings';
import { cleanMerchantName } from '../merchant';
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
        properties: { raw: { type: 'string' }, name: { type: 'string' } },
        required: ['raw', 'name'],
      },
    },
  },
  required: ['results'],
};

/** Still looks like a bank code after the rule-based cleanup. */
function looksRaw(name: string): boolean {
  return (
    /\d/.test(name) ||
    name.split(' ').some((w) => w.length >= 3 && !/[aeiouy]/i.test(w)) ||
    (name === name.toUpperCase() && /[A-Z]{4,}/.test(name)) ||
    name.length > 28
  );
}

/**
 * Merchant name cleanup: rules first ("SQ *GREENLEAF FLORIST" -> "Greenleaf
 * Florist"), the AI for names that still look like bank codes. Builds the
 * merchants table with raw aliases. Never renames a transaction the user renamed.
 */
export async function runMerchantCleanup(env: Env, deps: AiDeps = {}): Promise<AiJobResponse> {
  const db = env.DB;
  const settings = await getSettings(db);
  const txns = (
    await selectAll(db, transactionsTable, 'merchant_id IS NULL AND is_split_parent = 0')
  ).filter((t) => t.rawName.trim().length > 0);
  if (txns.length === 0) return { job: 'merchants', changed: 0, usedAi: false, note: null };
  const raws = [...new Set(txns.map((t) => t.rawName))];
  const cleaned = new Map(raws.map((r) => [r, cleanMerchantName(r)]));
  const ai = tryGetAi(env, settings, deps);
  let usedAi = false;
  const hard = raws.filter((r) => looksRaw(cleaned.get(r)!)).slice(0, 200);
  if (ai && hard.length > 0) {
    for (let i = 0; i < hard.length; i += 50) {
      const batch = hard.slice(i, i + 50);
      try {
        const reply = await completeJson<{ results: { raw: string; name: string }[] }>(ai, {
          system:
            'You turn bank transaction descriptions into the merchant name a person would recognise ("AMZN MKTP US*2K4" -> "Amazon"). Keep it short. If there is no merchant (a transfer or fee), return a short plain description. Return JSON only.',
          prompt: batch.map((r) => `- ${r}`).join('\n'),
          schema: SCHEMA,
          maxTokens: 3000,
        });
        usedAi = true;
        for (const r of reply.results ?? []) {
          if (batch.includes(r.raw) && r.name?.trim())
            cleaned.set(r.raw, r.name.trim().slice(0, 60));
        }
      } catch {
        break;
      }
    }
  }
  const merchants = await selectAll(db, merchantsTable);
  const byKey = new Map(merchants.map((m) => [normalizeDescription(m.name), m]));
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  const touched = new Map<string, Merchant>();
  let changed = 0;
  for (const t of txns) {
    const name = cleaned.get(t.rawName)!;
    const key = normalizeDescription(name);
    if (!key) continue;
    let merchant = byKey.get(key);
    if (!merchant) {
      merchant = { id: newId('mer'), name, defaultCategoryId: null, aliases: [] };
      byKey.set(key, merchant);
    }
    if (!merchant.aliases.includes(t.rawName))
      merchant.aliases = [...merchant.aliases, t.rawName].slice(-20);
    touched.set(merchant.id, merchant);
    const fields: Record<string, unknown> = { merchantId: merchant.id };
    if (t.name === t.rawName) fields.name = name;
    const { transaction } = mergeRespectingUserEdits(t, fields);
    if (transaction.merchantId !== t.merchantId || transaction.name !== t.name) {
      statements.push(
        updateStatement(
          db,
          transactionsTable,
          { id: t.id },
          { merchantId: transaction.merchantId, name: transaction.name, updatedAt: now },
        ),
      );
      changed += 1;
    }
  }
  await batchInChunks(db, [
    ...[...touched.values()].map((m) => insertStatement(db, merchantsTable, m, 'upsert')),
    ...statements,
  ]);
  return {
    job: 'merchants',
    changed,
    usedAi,
    note: ai ? null : 'AI is off; used the built-in cleanup rules only.',
  };
}
