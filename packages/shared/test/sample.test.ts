import { describe, expect, it } from 'vitest';
import { ACTIVE_TRANSFER_LINK_STATUSES, buildTreatmentContext, summarizeSpending } from '../src';
import { createSampleData } from '../src/sample';

const data = createSampleData({ today: '2026-11-04', now: new Date('2026-11-04T18:00:00.000Z') });
const accountsById = new Map(data.accounts.map((a) => [a.id, a]));
const txById = new Map(data.transactions.map((t) => [t.id, t]));

describe('sample data', () => {
  it('is deterministic for a given date', () => {
    const again = createSampleData({
      today: '2026-11-04',
      now: new Date('2026-11-04T18:00:00.000Z'),
    });
    expect(again.transactions.length).toBe(data.transactions.length);
    expect(again.transactions.map((t) => t.amount)).toEqual(data.transactions.map((t) => t.amount));
  });

  it('uses integer minor units and the account currency everywhere', () => {
    expect(data.transactions.length).toBeGreaterThan(200);
    for (const t of data.transactions) {
      expect(Number.isSafeInteger(t.amount)).toBe(true);
      expect(Number.isSafeInteger(t.originalAmount)).toBe(true);
      expect(t.currency).toBe(accountsById.get(t.accountId)?.currency);
      expect(Math.sign(t.originalAmount)).toBe(Math.sign(t.amount));
    }
    for (const a of data.accounts) expect(Number.isSafeInteger(a.balance)).toBe(true);
  });

  it('has cash accounts in USD and INR', () => {
    const cash = data.accounts.filter((a) => a.type === 'cash');
    expect(cash.map((a) => a.currency).sort()).toEqual(['INR', 'USD']);
  });

  it('links each transfer pair with opposite signs and both amounts', () => {
    expect(data.transferLinks.length).toBeGreaterThan(10);
    for (const l of data.transferLinks) {
      const out = txById.get(l.outTransactionId);
      const into = txById.get(l.inTransactionId);
      expect(out?.amount).toBeLessThan(0);
      expect(into?.amount).toBeGreaterThan(0);
      expect(out?.accountId).not.toBe(into?.accountId);
      expect(out?.transferLinkId).toBe(l.id);
      expect(into?.transferLinkId).toBe(l.id);
      expect(l.outAmount).toBe(Math.abs(out?.amount ?? 0));
      expect(l.inAmount).toBe(Math.abs(into?.amount ?? 0));
      expect(ACTIVE_TRANSFER_LINK_STATUSES).toContain(l.status);
    }
    const crossCurrency = data.transferLinks.filter((l) => l.outCurrency !== l.inCurrency);
    expect(crossCurrency.length).toBeGreaterThan(0);
    for (const l of crossCurrency) expect(l.impliedRate).toBeGreaterThan(80);
  });

  it('has split children that add up to their parents', () => {
    const parents = data.transactions.filter((t) => t.isSplitParent);
    expect(parents.length).toBeGreaterThan(1);
    for (const p of parents) {
      const children = data.transactions.filter((t) => t.splitParentId === p.id);
      expect(children.length).toBeGreaterThanOrEqual(2);
      expect(children.reduce((s, c) => s + c.amount, 0)).toBe(p.amount);
    }
  });

  it('keeps two identical coffees on the same day as two purchases', () => {
    const a = txById.get('txn_coffee_a');
    const b = txById.get('txn_coffee_b');
    expect(a && b).toBeTruthy();
    expect([a?.date, a?.amount, a?.rawName]).toEqual([b?.date, b?.amount, b?.rawName]);
  });

  it('has receipts whose line items add up', () => {
    for (const r of data.receipts.filter((x) => x.lineItems.length > 0)) {
      const items = r.lineItems.reduce((s, li) => s + li.amount, 0);
      expect(items + (r.tax ?? 0)).toBe(r.total);
    }
  });

  it('values investment accounts from their holdings', () => {
    const brokerage = accountsById.get('acc_brokerage');
    const held = data.holdings.filter((h) => h.accountId === 'acc_brokerage');
    expect(brokerage?.balance).toBe(held.reduce((s, h) => s + h.marketValue, 0) + 120_418);
    expect(data.taxLots.some((l) => l.source === 'broker')).toBe(true);
    expect(data.taxLots.some((l) => l.source === 'derived')).toBe(true);
  });

  it('produces believable monthly spending in USD', () => {
    const ctx = buildTreatmentContext(
      data.settings.moneyPolicies,
      data.categories,
      data.transferLinks,
    );
    const october = summarizeSpending(data.transactions, ctx, {
      from: '2026-10-01',
      to: '2026-10-31',
      currency: 'USD',
      rates: data.fxRates,
    });
    expect(october.missingRate).toBe(0);
    // Rent alone is $2,350; transfers and card payments must not inflate it past ~$10k.
    expect(october.spending).toBeGreaterThan(400_000);
    expect(october.spending).toBeLessThan(1_000_000);
    expect(october.byCategory.cat_rent).toBe(235_000);
    expect(october.byCategory.cat_card_payment).toBeUndefined();
    expect(october.byCategory.cat_transfer).toBeUndefined();
  });
});
