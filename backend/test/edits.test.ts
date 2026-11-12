import { beforeEach, describe, expect, it } from 'vitest';
import { insertStatement, selectAll } from '../src/db/table';
import { budgetsTable, receiptsTable, recurringTable, transactionsTable } from '../src/db/tables';
import { makeTransaction } from '../src/services/transactions';
import { freshDb, testEnv } from './helpers';
import { client } from './worker';

const db = testEnv.DB;
beforeEach(freshDb);

describe('budget, recurring and receipt edits from the app', () => {
  it('saves, extends, copies and removes budgets', async () => {
    const api = client().api;
    const save = (month: string, amount: number, later = false) =>
      api('PUT', '/v1/budgets', {
        categoryId: 'cat_food',
        month,
        amount,
        currency: 'USD',
        rollover: false,
        flexType: 'flexible',
        applyToLaterMonths: later,
      });
    expect((await save('2026-10', 40_000)).status).toBe(200);
    expect((await save('2026-11', 40_000)).status).toBe(200);
    await save('2026-10', 45_000, true);
    const rows = await selectAll(db, budgetsTable, '', [], 'month');
    expect(rows.map((r) => [r.month, r.amount])).toEqual([
      ['2026-10', 45_000],
      ['2026-11', 45_000],
    ]);
    const copied = await api('POST', '/v1/budgets/copy-previous', { month: '2026-12' });
    expect(copied.body).toEqual({ copied: 1 });
    await api('DELETE', '/v1/budgets/2026-11/cat_food');
    expect((await selectAll(db, budgetsTable)).map((r) => r.month).sort()).toEqual([
      '2026-10',
      '2026-12',
    ]);
  });

  it('records a subscription decision and a cancellation', async () => {
    await insertStatement(db, recurringTable, {
      id: 'rec_1',
      name: 'StreamBox',
      merchantId: null,
      categoryId: null,
      accountId: null,
      kind: 'subscription',
      frequency: 'monthly',
      expectedAmount: -999,
      currency: 'USD',
      isVariable: false,
      lastDate: '2026-10-04',
      nextDueDate: '2026-11-04',
      status: 'active',
      decision: null,
      priceHistory: [],
      detectedBy: 'rules',
      aiConfidence: null,
    } as never).run();
    const api = client().api;
    expect((await api('PATCH', '/v1/recurring/rec_1', { decision: 'review' })).body).toMatchObject({
      recurring: { decision: 'review', status: 'active' },
    });
    expect((await api('PATCH', '/v1/recurring/rec_1', { status: 'cancelled' })).body).toMatchObject(
      {
        recurring: { decision: 'cancel', status: 'cancelled' },
      },
    );
    expect((await api('PATCH', '/v1/recurring/nope', { status: 'paused' })).status).toBe(404);
  });

  it('edits receipt line items and removes a receipt from its transaction', async () => {
    const now = '2026-11-05T12:00:00.000Z';
    await insertStatement(db, receiptsTable, {
      id: 'rcp_1',
      r2Key: 'receipts/2026-11/rcp_1',
      merchant: 'Hillside Grocer',
      date: '2026-11-02',
      total: 4_217,
      subtotal: null,
      tax: null,
      tip: null,
      currency: 'USD',
      lineItems: [],
      matchedTransactionId: null,
      status: 'parsed',
      aiConfidence: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    const txn = makeTransaction(
      {
        accountId: 'acc_1',
        date: '2026-11-02',
        amount: -4_217,
        currency: 'USD',
        rawName: 'HILLSIDE',
        source: 'manual',
        receiptId: 'rcp_1',
      },
      now,
    );
    await insertStatement(db, transactionsTable, txn).run();
    const api = client().api;
    const items = [
      { id: 'li_1', description: 'Apples', quantity: '2', amount: 420, categoryId: null },
    ];
    expect((await api('PATCH', '/v1/receipts/rcp_1', { lineItems: items })).body).toMatchObject({
      receipt: { lineItems: items },
    });
    expect((await api('DELETE', '/v1/receipts/rcp_1')).status).toBe(200);
    expect(await selectAll(db, receiptsTable)).toHaveLength(0);
    expect((await selectAll(db, transactionsTable))[0]?.receiptId).toBeNull();
  });
});
