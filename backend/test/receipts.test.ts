import { beforeEach, describe, expect, it } from 'vitest';
import receiptJson from './fixtures/ai/receipt-greenleaf.json';
import type { ReceiptResponse } from '@manaclaude/shared';
import { scoreReceiptMatches, splitByReceipt, uploadReceipt } from '../src/receipts/service';
import { fakeAi } from './fakes';
import { addAccount, addTxn, allTxns, db, freshDb, spending, testEnv } from './helpers';
import { client } from './worker';

beforeEach(freshDb);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]) as Uint8Array<ArrayBuffer>;

describe('receipts', () => {
  it('matches a restaurant charge that includes a tip', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-03',
      amount: -4_964,
      rawName: 'TST* GREENLEAF BISTRO',
      categoryId: 'cat_dining',
    });
    const ai = fakeAi({ receipt: receiptJson });
    const res = await uploadReceipt(testEnv, { bytes: JPEG, contentType: 'image/jpeg' }, ai.deps);
    expect(res.match).toMatchObject({ transactionId: t.id });
    expect(res.match?.reason).toContain('amount plus a tip');
    expect(res.receipt.status).toBe('matched');
  });

  it('does not match charges more than 3 days away or a different amount at a non-restaurant', async () => {
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-08', amount: -4_137, rawName: 'GREENLEAF BISTRO' });
    await addTxn(card, { date: '2026-11-02', amount: -4_500, rawName: 'HARDWARE STORE' });
    const res = await uploadReceipt(
      testEnv,
      { bytes: JPEG, contentType: 'image/jpeg' },
      fakeAi({ receipt: { ...receiptJson, merchant: 'Hardware Store' } }).deps,
    );
    expect(res.match).toBeNull();
    expect(res.candidates).toEqual([]);
  });

  it('leaves two equally good candidates for the user to pick', async () => {
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-02', amount: -4_137, rawName: 'SQ *SHOP ONE' });
    await addTxn(card, { date: '2026-11-02', amount: -4_137, rawName: 'SQ *SHOP TWO' });
    const res = await uploadReceipt(
      testEnv,
      { bytes: JPEG, contentType: 'image/jpeg' },
      fakeAi({ receipt: { ...receiptJson, merchant: 'Corner Shop' } }).deps,
    );
    expect(res.match).toBeNull();
    expect(res.candidates).toHaveLength(2);
    expect(res.receipt.status).toBe('needs_review');
  });

  it('splits the matched charge by line items, spreading tax so the lines add up exactly', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-02',
      amount: -4_137,
      rawName: 'GREENLEAF BISTRO',
      categoryId: 'cat_dining',
    });
    const res = await uploadReceipt(
      testEnv,
      { bytes: JPEG, contentType: 'image/jpeg' },
      fakeAi({ receipt: receiptJson }).deps,
    );
    expect(res.receipt.matchedTransactionId).toBe(t.id);
    const split = await splitByReceipt(db, res.receipt.id, 'rcpt-split-1');
    expect(split.children.map((c) => c.amount)).toEqual([-2_395, -871, -871]);
    expect(split.children.reduce((s, c) => s + c.amount, 0)).toBe(-4_137);
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.byCategory).toEqual({ cat_dining: 3_266, cat_gifts: 871 });
    expect((await splitByReceipt(db, res.receipt.id, 'rcpt-split-1')).replayed).toBe(true);
    expect((await allTxns()).filter((x) => x.splitParentId === t.id)).toHaveLength(3);
  });

  it('accepts uploads over HTTP, attaches by hand and serves the image back', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, { date: '2026-11-02', amount: -9_999, rawName: 'SOMEWHERE' });
    const { api, raw } = client(fakeAi({ receipt: receiptJson }).deps);
    const form = new FormData();
    form.set('file', new File([JPEG], 'r.jpg', { type: 'image/jpeg' }));
    form.set('transactionId', t.id);
    const res = await api<ReceiptResponse>('POST', '/v1/receipts', form);
    expect(res.status).toBe(201);
    expect(res.body.receipt.matchedTransactionId).toBe(t.id);
    const img = await raw(`/v1/receipts/${res.body.receipt.id}/image`, {
      headers: { authorization: 'Bearer test-app-token' },
    });
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    const bad = new FormData();
    bad.set('file', new File(['x'], 'r.txt', { type: 'text/plain' }));
    expect((await api('POST', '/v1/receipts', bad)).status).toBe(400);
  });

  it('scores pure matches the same way the API does', () => {
    const r = {
      ...receiptJson,
      id: 'r',
      r2Key: 'k',
      total: 4_137,
      subtotal: null,
      tax: null,
      tip: null,
      lineItems: [],
      matchedTransactionId: null,
      status: 'parsed' as const,
      aiConfidence: 1,
      createdAt: '',
      updatedAt: '',
    };
    expect(scoreReceiptMatches(r, [])).toEqual([]);
  });
});
