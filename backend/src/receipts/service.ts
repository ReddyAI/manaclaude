import {
  daysBetween,
  normalizeDescription,
  parseAmountText,
  type Id,
  type Receipt,
  type ReceiptLineItem,
  type Transaction,
  type ReceiptMatch,
  type ReceiptResponse,
} from '@manaclaude/shared';
import type { Env } from '../env';
import { completeJson, getAi, type AiDeps, type JsonSchema } from '../ai/provider';
import { cleanMerchantName } from '../ai/merchant';
import { guardedWrite } from '../services/account-writes';
import { insertStatement, selectAll, selectOne, updateStatement } from '../db/table';
import { categoriesTable, receiptsTable, transactionsTable } from '../db/tables';
import { badRequest, notFound } from '../util/errors';
import { newId, nowIso } from '../util/ids';
import { getSettings } from '../services/settings';
import { splitTransaction } from '../services/splits';

const RECEIPT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    merchant: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    currency: { type: ['string', 'null'], description: 'ISO code' },
    subtotal: { type: ['string', 'null'] },
    tax: { type: ['string', 'null'] },
    tip: { type: ['string', 'null'] },
    total: { type: ['string', 'null'] },
    confidence: { type: 'number', description: '0 to 1' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          quantity: { type: ['string', 'null'] },
          amount: { type: 'string' },
          category: { type: ['string', 'null'] },
        },
        required: ['description', 'quantity', 'amount', 'category'],
      },
    },
  },
  required: [
    'merchant',
    'date',
    'currency',
    'subtotal',
    'tax',
    'tip',
    'total',
    'confidence',
    'lineItems',
  ],
};

interface ReceiptJson {
  merchant: string | null;
  date: string | null;
  currency: string | null;
  subtotal: string | null;
  tax: string | null;
  tip: string | null;
  total: string | null;
  confidence: number;
  lineItems: {
    description: string;
    quantity: string | null;
    amount: string;
    category: string | null;
  }[];
}

const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Restaurants get a tip window when matching a receipt to a card charge. */
const TIP_CATEGORIES = new Set(['cat_dining', 'cat_coffee']);
const MAX_TIP_RATE = 0.3;

function similarity(a: string, b: string): number {
  const ta = new Set(
    normalizeDescription(cleanMerchantName(a))
      .split(' ')
      .filter((w) => w.length > 1),
  );
  const tb = new Set(
    normalizeDescription(cleanMerchantName(b))
      .split(' ')
      .filter((w) => w.length > 1),
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const w of ta)
    if (tb.has(w) || [...tb].some((x) => x.startsWith(w) || w.startsWith(x))) common += 1;
  return common / Math.min(ta.size, tb.size);
}

/**
 * Scores transactions for a receipt: amount (exact, or within a tip range for
 * restaurants), date within 3 days, merchant similarity.
 */
export function scoreReceiptMatches(
  receipt: Receipt,
  txns: readonly Transaction[],
): ReceiptMatch[] {
  if (receipt.total === null || !receipt.date) return [];
  const out: ReceiptMatch[] = [];
  for (const t of txns) {
    if (t.amount >= 0 || t.isSplitParent || t.receiptId) continue;
    if (
      receipt.currency &&
      t.currency !== receipt.currency &&
      t.originalCurrency !== receipt.currency
    )
      continue;
    const days = Math.abs(daysBetween(t.date, receipt.date));
    if (days > 3) continue;
    const charged = t.originalCurrency === receipt.currency ? -t.originalAmount : -t.amount;
    const exact = charged === receipt.total;
    const tipOk =
      !exact &&
      charged > receipt.total &&
      charged <= Math.round(receipt.total * (1 + MAX_TIP_RATE)) &&
      ((t.categoryId !== null && TIP_CATEGORIES.has(t.categoryId)) ||
        receipt.tip !== null ||
        /restaurant|cafe|bar|grill|kitchen|pizza|coffee/i.test(
          `${t.rawName} ${receipt.merchant ?? ''}`,
        ));
    if (!exact && !tipOk) continue;
    const sim = receipt.merchant ? similarity(receipt.merchant, t.rawName) : 0;
    const score = Math.min(1, (exact ? 0.6 : 0.4) + (3 - days) * 0.05 + sim * 0.3);
    const reasons = [
      exact ? 'same amount' : 'amount plus a tip',
      days === 0 ? 'same day' : `${days} day${days === 1 ? '' : 's'} apart`,
    ];
    if (sim >= 0.5) reasons.push('merchant matches');
    out.push({
      transactionId: t.id,
      score: Math.round(score * 100) / 100,
      reason: reasons.join(', '),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function readReceipt(
  env: Env,
  image: Uint8Array<ArrayBuffer>,
  mediaType: string,
  aiDeps: AiDeps,
) {
  const settings = await getSettings(env.DB);
  const ai = getAi(env, settings, aiDeps);
  const categories = await selectAll(env.DB, categoriesTable, "kind = 'expense' AND archived = 0");
  const json = await completeJson<ReceiptJson>(ai, {
    system:
      'You read photos of shopping and restaurant receipts. Return JSON only. Copy amounts as printed (strings, no currency symbols). Use null when a value is not printed. Do not invent line items.',
    prompt: `Extract the merchant, date (YYYY-MM-DD), currency, subtotal, tax, tip, total and every line item. For each line item pick the closest category from: ${categories
      .map((c) => c.name)
      .join(', ')}.`,
    schema: RECEIPT_SCHEMA,
    image: { data: image, mediaType },
    maxTokens: 2000,
  });
  const currency = (json.currency ?? 'USD').toUpperCase().slice(0, 3);
  const amount = (v: string | null) => (v ? parseAmountText(v, currency) : null);
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
  const lineItems: ReceiptLineItem[] = json.lineItems
    .map((l) => ({
      id: newId('rli'),
      description: l.description,
      quantity: l.quantity,
      amount: Math.abs(amount(l.amount) ?? 0),
      categoryId: l.category ? (byName.get(l.category.toLowerCase()) ?? null) : null,
    }))
    .filter((l) => l.amount > 0);
  return {
    merchant: json.merchant,
    date: json.date && /^\d{4}-\d{2}-\d{2}$/.test(json.date) ? json.date : null,
    currency,
    total: amount(json.total) === null ? null : Math.abs(amount(json.total)!),
    subtotal: amount(json.subtotal),
    tax: amount(json.tax),
    tip: amount(json.tip),
    lineItems,
    aiConfidence: Math.max(0, Math.min(1, Number(json.confidence) || 0)),
  };
}

/**
 * Stores a receipt image in R2, reads it with the AI layer (Workers AI vision
 * by default), and matches it to a transaction. When the AI is off the
 * receipt is stored as "uploaded" and can be attached by hand.
 */
export async function uploadReceipt(
  env: Env,
  input: { bytes: Uint8Array<ArrayBuffer>; contentType: string; transactionId?: Id },
  aiDeps: AiDeps = {},
): Promise<ReceiptResponse> {
  if (!MEDIA_TYPES.includes(input.contentType))
    throw badRequest('Send a JPEG, PNG, WebP or GIF image.');
  if (input.bytes.byteLength > 10 * 1024 * 1024) throw badRequest('Receipt images up to 10 MB.');
  const now = nowIso();
  const id = newId('rcpt');
  const r2Key = `receipts/${now.slice(0, 7)}/${id}`;
  await env.FILES.put(r2Key, input.bytes, { httpMetadata: { contentType: input.contentType } });
  let receipt: Receipt = {
    id,
    r2Key,
    merchant: null,
    date: null,
    total: null,
    subtotal: null,
    tax: null,
    tip: null,
    currency: null,
    lineItems: [],
    matchedTransactionId: null,
    status: 'uploaded',
    aiConfidence: null,
    createdAt: now,
    updatedAt: now,
  };
  const settings = await getSettings(env.DB);
  if (settings.aiEnabled) {
    try {
      receipt = {
        ...receipt,
        ...(await readReceipt(env, input.bytes, input.contentType, aiDeps)),
        status: 'parsed',
      };
    } catch {
      receipt.status = 'failed';
    }
  }
  await insertStatement(env.DB, receiptsTable, receipt).run();
  if (input.transactionId) {
    const attached = await attachReceipt(env.DB, id, input.transactionId);
    return {
      receipt: attached,
      match: { transactionId: input.transactionId, score: 1, reason: 'attached by you' },
      candidates: [],
    };
  }
  return matchReceipt(env.DB, receipt);
}

export async function matchReceipt(db: D1Database, receipt: Receipt): Promise<ReceiptResponse> {
  if (!receipt.date || receipt.total === null) return { receipt, match: null, candidates: [] };
  const txns = await selectAll(
    db,
    transactionsTable,
    "date >= date(?, '-3 days') AND date <= date(?, '+3 days') AND amount < 0",
    [receipt.date, receipt.date],
  );
  const candidates = scoreReceiptMatches(receipt, txns);
  const best = candidates[0];
  // Auto-match only a clear winner.
  const clear =
    best &&
    best.score >= 0.6 &&
    (candidates.length === 1 || best.score - candidates[1]!.score >= 0.15);
  if (best && clear) {
    const attached = await attachReceipt(db, receipt.id, best.transactionId, 'matched');
    return { receipt: attached, match: best, candidates: candidates.slice(1, 4) };
  }
  const status = candidates.length > 0 ? 'needs_review' : receipt.status;
  if (status !== receipt.status) {
    await updateStatement(
      db,
      receiptsTable,
      { id: receipt.id },
      { status, updatedAt: nowIso() },
    ).run();
  }
  return { receipt: { ...receipt, status }, match: null, candidates: candidates.slice(0, 4) };
}

export async function attachReceipt(
  db: D1Database,
  receiptId: Id,
  transactionId: Id,
  status: Receipt['status'] = 'matched',
): Promise<Receipt> {
  const receipt = await selectOne(db, receiptsTable, 'id = ?', [receiptId]);
  if (!receipt) throw notFound('Receipt not found.');
  const txn = await selectOne(db, transactionsTable, 'id = ?', [transactionId]);
  if (!txn) throw notFound('Transaction not found.');
  const now = nowIso();
  await guardedWrite(
    db,
    [
      {
        sql: "SELECT CASE WHEN EXISTS (SELECT 1 FROM transactions WHERE id = ?1) THEN 'present' ELSE 'missing' END",
        id: transactionId,
        state: 'present',
      },
    ],
    [
      db
        .prepare('UPDATE transactions SET receipt_id = NULL, updated_at = ? WHERE receipt_id = ?')
        .bind(now, receiptId),
      db
        .prepare('UPDATE transactions SET receipt_id = ?, updated_at = ? WHERE id = ?')
        .bind(receiptId, now, transactionId),
      updateStatement(
        db,
        receiptsTable,
        { id: receiptId },
        { matchedTransactionId: transactionId, status, updatedAt: now },
      ),
    ],
  );
  return { ...receipt, matchedTransactionId: transactionId, status, updatedAt: now };
}

/**
 * "Split by items": splits the matched transaction using the receipt's line
 * items. Tax and tip are spread over the items in proportion so the lines add
 * up to the charge exactly (validateSplit checks it).
 */
export async function splitByReceipt(db: D1Database, receiptId: Id, idempotencyKey: string) {
  const receipt = await selectOne(db, receiptsTable, 'id = ?', [receiptId]);
  if (!receipt?.matchedTransactionId)
    throw badRequest('Attach the receipt to a transaction first.');
  if (receipt.lineItems.length < 2)
    throw badRequest('The receipt needs at least two line items to split.');
  const txn = await selectOne(db, transactionsTable, 'id = ?', [receipt.matchedTransactionId]);
  if (!txn) throw notFound('Transaction not found.');
  const total = -txn.amount;
  const itemsTotal = receipt.lineItems.reduce((s, l) => s + l.amount, 0);
  if (itemsTotal <= 0) throw badRequest('The line items have no amounts.');
  // Largest-remainder allocation of the charged total over the items.
  const shares = receipt.lineItems.map((l) => (l.amount * total) / itemsTotal);
  const floors = shares.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - floors[i]!, i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i]! += 1;
    left -= 1;
  }
  return splitTransaction(db, {
    parentTransactionId: txn.id,
    idempotencyKey,
    lines: receipt.lineItems.map((l, i) => ({
      amount: -floors[i]!,
      categoryId: l.categoryId ?? txn.categoryId,
      name: l.description,
    })),
  });
}

export async function searchReceipts(
  db: D1Database,
  q: { query?: string; from?: string; to?: string },
): Promise<Receipt[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (q.query) {
    where.push('(merchant LIKE ? OR line_items LIKE ?)');
    params.push(`%${q.query}%`, `%${q.query}%`);
  }
  if (q.from) {
    where.push('date >= ?');
    params.push(q.from);
  }
  if (q.to) {
    where.push('date <= ?');
    params.push(q.to);
  }
  return selectAll(db, receiptsTable, where.join(' AND '), params, 'date DESC LIMIT 100');
}
