import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { CategoryBudget } from '@manaclaude/shared';
import type { Env } from '../env';
import type { AppDeps } from './app';
import { selectAll, selectOne } from '../db/table';
import { budgetsTable, receiptsTable, recurringTable } from '../db/tables';
import { bulkInsertSpecs, runSpecs } from '../db/bulk';
import { badRequest, notFound } from '../util/errors';
import { nowIso } from '../util/ids';

/**
 * Small edits the app makes that had no endpoint yet (session E2, so every
 * change in the app's features/*\/actions.ts reaches the backend): budgets
 * (session C's budget screen), subscription decisions and status (recurring),
 * and receipt line items and removal (session A's receipt sheet).
 */

type AppEnv = { Bindings: Env; Variables: { deps: AppDeps } };
type C = Context<AppEnv>;

async function parse<T extends z.ZodTypeAny>(c: C, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest('Send a JSON body.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
      'invalid_body',
    );
  }
  return parsed.data;
}

const month = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM.');
const money = z
  .number()
  .int()
  .refine((n) => Number.isSafeInteger(n));
const budgetId = (m: string, categoryId: string) => `bud_${m}_${categoryId}`;

export function registerEditRoutes<E extends AppEnv>(hono: Hono<E>): void {
  const app = hono as unknown as Hono<AppEnv>;

  // ---- Budgets ----------------------------------------------------------------
  app.put('/v1/budgets', async (c) => {
    const b = await parse(
      c,
      z.object({
        categoryId: z.string().min(1).max(100),
        month,
        amount: money,
        currency: z.string().regex(/^[A-Z]{3}$/),
        rollover: z.boolean(),
        flexType: z.enum(['fixed', 'flexible', 'non_monthly']).nullable(),
        applyToLaterMonths: z.boolean().optional(),
      }),
    );
    const fields = {
      amount: b.amount,
      currency: b.currency,
      rollover: b.rollover,
      flexType: b.flexType,
    };
    const rows: CategoryBudget[] = [
      { id: budgetId(b.month, b.categoryId), categoryId: b.categoryId, month: b.month, ...fields },
    ];
    if (b.applyToLaterMonths) {
      const later = await selectAll(c.env.DB, budgetsTable, 'category_id = ? AND month > ?', [
        b.categoryId,
        b.month,
      ]);
      for (const l of later) rows.push({ ...l, ...fields });
    }
    // Upsert on (category, month): the unique index decides, whatever the row id.
    await runSpecs(c.env.DB, [
      ...bulkInsertSpecs(budgetsTable, rows, 'ignore'),
      {
        sql: `UPDATE budgets SET amount = json_extract(j.value, '$[2]'), currency = json_extract(j.value, '$[3]'),
                rollover = json_extract(j.value, '$[4]'), flex_type = json_extract(j.value, '$[5]')
              FROM json_each(?) AS j
              WHERE budgets.category_id = json_extract(j.value, '$[0]') AND budgets.month = json_extract(j.value, '$[1]')`,
        params: [
          JSON.stringify(
            rows.map((r) => [
              r.categoryId,
              r.month,
              r.amount,
              r.currency,
              r.rollover ? 1 : 0,
              r.flexType,
            ]),
          ),
        ],
        rows: rows.length,
      },
    ]);
    return c.json({
      budgets: await selectAll(c.env.DB, budgetsTable, 'category_id = ? AND month >= ?', [
        b.categoryId,
        b.month,
      ]),
    });
  });

  app.delete('/v1/budgets/:month/:categoryId', async (c) => {
    const m = c.req.param('month');
    if (!/^\d{4}-\d{2}$/.test(m)) throw badRequest('Use YYYY-MM.');
    await c.env.DB.prepare('DELETE FROM budgets WHERE month = ? AND category_id = ?')
      .bind(m, c.req.param('categoryId'))
      .run();
    return c.json({ ok: true });
  });

  app.post('/v1/budgets/copy-previous', async (c) => {
    const b = await parse(c, z.object({ month }));
    const [y, mo] = b.month.split('-').map(Number) as [number, number];
    const prev = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
    const res = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO budgets (id, category_id, month, amount, currency, rollover, flex_type)
       SELECT 'bud_' || ?1 || '_' || category_id, category_id, ?1, amount, currency, rollover, flex_type
       FROM budgets WHERE month = ?2`,
    )
      .bind(b.month, prev)
      .run();
    return c.json({ copied: res.meta.changes ?? 0 });
  });

  // ---- Recurring ----------------------------------------------------------------
  app.patch('/v1/recurring/:id', async (c) => {
    const b = await parse(
      c,
      z
        .object({
          decision: z.enum(['keep', 'cancel', 'review']).nullable(),
          status: z.enum(['active', 'paused', 'cancelled']),
        })
        .partial()
        .strict(),
    );
    const item = await selectOne(c.env.DB, recurringTable, 'id = ?', [c.req.param('id')]);
    if (!item) throw notFound('Recurring item not found.');
    const decision =
      b.status === 'cancelled' ? 'cancel' : b.decision !== undefined ? b.decision : item.decision;
    const status = b.status ?? item.status;
    await c.env.DB.prepare('UPDATE recurring_items SET decision = ?, status = ? WHERE id = ?')
      .bind(decision, status, item.id)
      .run();
    return c.json({ recurring: { ...item, decision, status } });
  });

  // ---- Receipts -------------------------------------------------------------------
  app.patch('/v1/receipts/:id', async (c) => {
    const b = await parse(
      c,
      z.object({
        lineItems: z
          .array(
            z.object({
              id: z.string().min(1).max(100),
              description: z.string().max(200),
              quantity: z.string().max(30).nullable(),
              amount: money,
              categoryId: z.string().max(100).nullable(),
            }),
          )
          .max(200),
      }),
    );
    const r = await selectOne(c.env.DB, receiptsTable, 'id = ?', [c.req.param('id')]);
    if (!r) throw notFound('Receipt not found.');
    const now = nowIso();
    await c.env.DB.prepare('UPDATE receipts SET line_items = ?, updated_at = ? WHERE id = ?')
      .bind(JSON.stringify(b.lineItems), now, r.id)
      .run();
    return c.json({ receipt: { ...r, lineItems: b.lineItems, updatedAt: now } });
  });

  app.delete('/v1/receipts/:id', async (c) => {
    const r = await selectOne(c.env.DB, receiptsTable, 'id = ?', [c.req.param('id')]);
    if (!r) throw notFound('Receipt not found.');
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE transactions SET receipt_id = NULL, updated_at = ? WHERE receipt_id = ?',
      ).bind(now, r.id),
      c.env.DB.prepare('DELETE FROM receipts WHERE id = ?').bind(r.id),
    ]);
    await c.env.FILES.delete(r.r2Key).catch(() => undefined);
    return c.json({ ok: true });
  });
}
