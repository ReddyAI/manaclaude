import type { Receipt, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { toBase64 } from '../../../data/backend/client';
import { attachCandidates, receiptsToAttach, waitingReason } from '../receiptInbox';

/** All data is invented. */
const base = createSampleData();
const sample = base.receipts[0]!;
const receipt = (over: Partial<Receipt>): Receipt => ({ ...sample, ...over });

describe('receipts to attach', () => {
  const list = [
    receipt({ id: 'r_matched', matchedTransactionId: 'x', status: 'matched' }),
    receipt({
      id: 'r_none',
      matchedTransactionId: null,
      status: 'parsed',
      createdAt: '2026-11-02',
    }),
    receipt({
      id: 'r_review',
      matchedTransactionId: null,
      status: 'needs_review',
      createdAt: '2026-11-03',
    }),
    receipt({ id: 'r_unsure', matchedTransactionId: 'y', status: 'needs_review' }),
    receipt({ id: 'r_local', matchedTransactionId: null, r2Key: 'pending-upload/r_local.jpg' }),
  ];

  it('lists receipts with no transaction or needing review, newest first, and only the Worker’s', () => {
    expect(receiptsToAttach({ receipts: list }).map((r) => r.id)).toEqual(
      expect.arrayContaining(['r_none', 'r_review', 'r_unsure']),
    );
    const ids = receiptsToAttach({ receipts: list }).map((r) => r.id);
    expect(ids).not.toContain('r_matched');
    expect(ids).not.toContain('r_local');
    expect(ids.indexOf('r_review')).toBeLessThan(ids.indexOf('r_none'));
  });

  it('says why each one is waiting', () => {
    expect(waitingReason(list[2]!)).toMatch(/old one was deleted/);
    expect(waitingReason(list[3]!)).toMatch(/not sure/);
  });
});

describe('transactions a receipt can go to', () => {
  const t = (over: Partial<Transaction>): Transaction => ({
    ...base.transactions.find((x) => x.amount < 0 && !x.receiptId && !x.transferLinkId)!,
    ...over,
  });
  const r = receipt({
    id: 'r1',
    matchedTransactionId: null,
    total: 25_00,
    currency: 'USD',
    date: '2026-11-10',
  });
  const txns = [
    t({ id: 'far', amount: -25_00, currency: 'USD', date: '2026-10-01', name: 'Far' }),
    t({ id: 'near', amount: -24_00, currency: 'USD', date: '2026-11-10', name: 'Near' }),
    t({ id: 'same', amount: -25_00, currency: 'USD', date: '2026-11-09', name: 'Same' }),
    t({ id: 'has', amount: -25_00, currency: 'USD', receiptId: 'other', name: 'Has' }),
    t({ id: 'split', amount: -25_00, currency: 'USD', isSplitParent: true, name: 'Split' }),
    t({ id: 'part', amount: -25_00, currency: 'USD', splitParentId: 'p', name: 'Part' }),
    t({ id: 'xfer', amount: -25_00, currency: 'USD', transferLinkId: 'l', name: 'Xfer' }),
    t({ id: 'in', amount: 25_00, currency: 'USD', name: 'In' }),
  ];

  it('offers money out without a receipt, not split or linked, same amount and nearest first', () => {
    expect(attachCandidates(r, txns, '').map((x) => x.id)).toEqual(['same', 'far', 'near']);
  });

  it('puts the transaction an unsure match points at first', () => {
    const unsure = { ...r, matchedTransactionId: 'near', status: 'needs_review' as const };
    const list = txns.map((x) => (x.id === 'near' ? { ...x, receiptId: 'r1' } : x));
    expect(attachCandidates(unsure, list, '')[0]!.id).toBe('near');
  });

  it('narrows by name', () => {
    expect(attachCandidates(r, txns, 'nea').map((x) => x.id)).toEqual(['near']);
  });
});

describe('base64 for images read from the Worker', () => {
  it('matches the standard encoding', () => {
    for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'])
      expect(toBase64(new TextEncoder().encode(s))).toBe(Buffer.from(s).toString('base64'));
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
