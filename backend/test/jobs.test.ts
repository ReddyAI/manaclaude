import { beforeEach, describe, expect, it } from 'vitest';
import type { Recap } from '@manaclaude/shared';
import { selectAll } from '../src/db/table';
import { merchantsTable, recurringTable, rulesTable } from '../src/db/tables';
import { cleanMerchantName } from '../src/ai/merchant';
import { runAlerts } from '../src/ai/jobs/alerts';
import { runCategorization } from '../src/ai/jobs/categorize';
import { runMerchantCleanup } from '../src/ai/jobs/merchants';
import { generateRecap, lastCompletePeriod } from '../src/ai/jobs/recap';
import { runRecurringDetection } from '../src/ai/jobs/recurring';
import { editTransaction } from '../src/services/edits';
import { runRules } from '../src/services/rules';
import { getTransaction } from '../src/services/transactions';
import { updateSettings } from '../src/services/settings';
import { fakeAi } from './fakes';
import { addAccount, addTxn, db, freshDb, testEnv } from './helpers';
import { client } from './worker';

beforeEach(freshDb);

describe('merchant cleanup', () => {
  it('cleans common bank prefixes and store numbers without AI', () => {
    expect(cleanMerchantName('SQ *GREENLEAF FLORIST')).toBe('Greenleaf Florist');
    expect(cleanMerchantName('STARBUCKS STORE 04412')).toBe('Starbucks');
    expect(cleanMerchantName('TST* CORNER BISTRO 123 NY')).toBe('Corner Bistro');
    expect(cleanMerchantName('UPI-CHAI POINT-8812@okbank')).toBe('Chai Point-8812');
  });

  it('builds merchants with aliases and asks the AI only about names that still look raw', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const a = await addTxn(card, {
      date: '2026-11-01',
      amount: -575,
      rawName: 'STARBUCKS STORE 04412',
    });
    const b = await addTxn(card, {
      date: '2026-11-02',
      amount: -575,
      rawName: 'STARBUCKS STORE 09121',
    });
    const c = await addTxn(card, {
      date: '2026-11-03',
      amount: -2_399,
      rawName: 'AMZN MKTP US*2K4',
    });
    const ai = fakeAi({ merchants: { 'AMZN MKTP US*2K4': 'Amazon' } });
    const res = await runMerchantCleanup(testEnv, ai.deps);
    expect(res.usedAi).toBe(true);
    expect(ai.calls[0]!.prompt).not.toContain('STARBUCKS');
    expect((await getTransaction(db, a.id))?.name).toBe('Starbucks');
    expect((await getTransaction(db, c.id))?.name).toBe('Amazon');
    const merchants = await selectAll(db, merchantsTable);
    const sb = merchants.find((m) => m.name === 'Starbucks')!;
    expect(sb.aliases.sort()).toEqual(['STARBUCKS STORE 04412', 'STARBUCKS STORE 09121']);
    expect((await getTransaction(db, b.id))?.merchantId).toBe(sb.id);
  });
});

describe('categorization that learns from corrections', () => {
  it('a correction becomes an example and a learned rule; the next charge from that merchant follows it', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const first = await addTxn(card, {
      date: '2026-10-01',
      amount: -1_500,
      rawName: 'SQ *GREENLEAF FLORIST',
      categoryId: 'cat_shopping',
      categorySource: 'ai',
      aiCategoryConfidence: 0.55,
    });
    await editTransaction(db, first.id, { categoryId: 'cat_gifts' });
    const rules = await selectAll(db, rulesTable);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      source: 'learned',
      actions: [{ type: 'set_category', categoryId: 'cat_gifts' }],
    });
    const next = await addTxn(card, {
      date: '2026-11-01',
      amount: -2_200,
      rawName: 'SQ *GREENLEAF FLORIST',
    });
    const ai = fakeAi({ categorize: { [next.id]: { category: 'Shopping', confidence: 0.9 } } });
    const res = await runCategorization(testEnv, {}, ai.deps);
    expect(res.changed).toBe(1);
    expect(ai.calls).toHaveLength(0); // the learned example answered it
    expect(await getTransaction(db, next.id)).toMatchObject({
      categoryId: 'cat_gifts',
      aiCategoryConfidence: 0.95,
    });
    // The learned rule does the same at import/sync time.
    const third = await addTxn(card, {
      date: '2026-11-05',
      amount: -900,
      rawName: 'SQ *GREENLEAF FLORIST',
    });
    await runRules(db, [third.id]);
    expect((await getTransaction(db, third.id))?.categoryId).toBe('cat_gifts');
  });

  it('sends earlier corrections as examples and keeps low confidence for the review queue', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const corrected = await addTxn(card, {
      date: '2026-10-01',
      amount: -1_000,
      rawName: 'PET PALACE',
      categoryId: 'cat_shopping',
      categorySource: 'ai',
    });
    await editTransaction(db, corrected.id, { categoryId: 'cat_household' });
    const t = await addTxn(card, { date: '2026-11-02', amount: -3_000, rawName: 'MYSTERY LLC' });
    const ai = fakeAi({ categorize: { [t.id]: { category: 'Shopping', confidence: 0.41 } } });
    await runCategorization(testEnv, {}, ai.deps);
    expect(ai.calls[0]!.prompt).toContain('"PET PALACE" -> Household');
    expect(await getTransaction(db, t.id)).toMatchObject({
      categoryId: 'cat_shopping',
      categorySource: 'ai',
      aiCategoryConfidence: 0.41,
    });
  });

  it('with AI off it still uses corrections and says so', async () => {
    await updateSettings(db, { aiEnabled: false });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-02', amount: -3_000, rawName: 'MYSTERY LLC' });
    const res = await runCategorization(testEnv, {}, fakeAi().deps);
    expect(res).toMatchObject({ usedAi: false, changed: 0 });
    expect(res.note).toMatch(/AI is off/);
  });
});

describe('recurring detection and price-change alerts', () => {
  it('finds a monthly subscription and alerts when the price goes up', async () => {
    const card = await addAccount({ type: 'credit_card' });
    for (const [date, amount] of [
      ['2026-07-12', -1_549],
      ['2026-08-12', -1_549],
      ['2026-09-12', -1_549],
      ['2026-10-12', -1_799],
    ] as const) {
      await addTxn(card, { date, amount, rawName: 'STREAMFLIX.COM 866-555' });
    }
    const res = await runRecurringDetection(testEnv);
    expect(res.changed).toBe(1);
    const [item] = await selectAll(db, recurringTable);
    expect(item).toMatchObject({
      frequency: 'monthly',
      expectedAmount: -1_799,
      nextDueDate: '2026-11-12',
      kind: 'bill',
    });
    expect(item!.priceHistory).toHaveLength(4);
    const alerts = await client().api<{ alerts: { type: string; message: string }[] }>(
      'GET',
      '/v1/alerts',
    );
    expect(alerts.body.alerts.map((a) => a.type)).toEqual(['price_increase']);
    expect(alerts.body.alerts[0]!.message).toContain('15.49 to 17.99');
    // Running again doesn't duplicate anything.
    await runRecurringDetection(testEnv);
    expect(await selectAll(db, recurringTable)).toHaveLength(1);
    expect(
      (await client().api<{ alerts: unknown[] }>('GET', '/v1/alerts')).body.alerts,
    ).toHaveLength(1);
  });

  it('ignores irregular charges', async () => {
    const card = await addAccount({ type: 'credit_card' });
    for (const date of ['2026-07-01', '2026-07-19', '2026-09-30', '2026-10-02']) {
      await addTxn(card, { date, amount: -2_000, rawName: 'HARDWARE STORE' });
    }
    await runRecurringDetection(testEnv);
    expect(await selectAll(db, recurringTable)).toHaveLength(0);
  });
});

describe('duplicate and unusual charge alerts', () => {
  it('flags a same-day duplicate and a charge far above the usual amount', async () => {
    const card = await addAccount({ type: 'credit_card' });
    for (const date of ['2026-07-03', '2026-08-03', '2026-09-03']) {
      await addTxn(card, { date, amount: -3_000, rawName: 'CORNER GROCER' });
    }
    await addTxn(card, { date: '2026-10-20', amount: -15_000, rawName: 'CORNER GROCER' });
    await addTxn(card, { date: '2026-10-21', amount: -899, rawName: 'APP STORE' });
    await addTxn(card, { date: '2026-10-21', amount: -899, rawName: 'APP STORE' });
    const res = await runAlerts(testEnv, '2026-10-25');
    expect(res.changed).toBe(2);
    const alerts = await client().api<{ alerts: { type: string }[] }>('GET', '/v1/alerts');
    expect(alerts.body.alerts.map((a) => a.type).sort()).toEqual(['duplicate', 'unusual']);
  });
});

describe('recaps', () => {
  async function seedWeek() {
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, {
      date: '2026-10-26',
      amount: -4_000,
      rawName: 'GROCER',
      categoryId: 'cat_groceries',
    });
    await addTxn(card, {
      date: '2026-10-28',
      amount: -2_500,
      rawName: 'BISTRO',
      categoryId: 'cat_dining',
    });
    await addTxn(card, {
      date: '2026-10-20',
      amount: -5_000,
      rawName: 'GROCER',
      categoryId: 'cat_groceries',
    });
  }

  it('writes a template recap in the shared Recap shape when AI is off', async () => {
    await updateSettings(db, { aiEnabled: false });
    await seedWeek();
    const range = lastCompletePeriod('weekly', '2026-11-04', 0);
    expect(range).toEqual({ start: '2026-10-25', end: '2026-10-31' });
    const recap = await generateRecap(testEnv, 'weekly', range);
    expect(recap).toMatchObject({
      kind: 'weekly',
      source: 'local',
      currency: 'USD',
      spending: 6_500,
      previousSpending: 5_000,
      topCategories: [
        { categoryId: 'cat_groceries', amount: 4_000, previous: 5_000 },
        { categoryId: 'cat_dining', amount: 2_500, previous: 0 },
      ],
      headline: 'You spent $65.00 this week, 30% more than the week before.',
      highlights: [
        'Most went to Groceries ($40.00), Restaurants ($25.00).',
        'The largest charge was GROCER at $40.00.',
      ],
    });
    expect(recap.biggestTransactions[0]?.amount).toBe(4_000);
  });

  it('lets the AI write the headline and highlights, keeps one recap per period and serves it', async () => {
    await seedWeek();
    const ai = fakeAi({
      text: JSON.stringify({
        headline: 'A calm week.',
        highlights: ['$65.00 spent, mostly groceries.'],
      }),
    });
    await generateRecap(testEnv, 'weekly', { start: '2026-10-25', end: '2026-10-31' }, ai.deps);
    await generateRecap(testEnv, 'weekly', { start: '2026-10-25', end: '2026-10-31' }, ai.deps);
    const res = await client().api<{ recaps: Recap[] }>('GET', '/v1/recaps?kind=weekly');
    expect(res.body.recaps).toHaveLength(1);
    expect(res.body.recaps[0]).toMatchObject({
      headline: 'A calm week.',
      highlights: ['$65.00 spent, mostly groceries.'],
      source: 'ai',
    });
    expect(ai.calls[0]!.prompt).toContain('You spent $65.00 this week');
  });
});
