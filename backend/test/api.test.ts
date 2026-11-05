import { beforeEach, describe, expect, it } from 'vitest';
import type {
  FinanceDataset,
  ImportResponse,
  Settings,
  SplitResponse,
  Transaction,
  TransferLink,
} from '@manaclaude/shared';
import lakeshoreCsv from './fixtures/imports/lakeshore-checking.csv?raw';
import { addAccount, addRate, addTxn, freshDb, spending } from './helpers';
import { client, upload } from './worker';

beforeEach(freshDb);

describe('API for the app', () => {
  it('GET /v1/dataset returns a FinanceDataset with default categories and settings', async () => {
    await addAccount({ type: 'checking', name: 'Everyday Checking' });
    const res = await client().api<FinanceDataset>('GET', '/v1/dataset');
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a) => a.name)).toEqual(['Everyday Checking']);
    expect(res.body.categories.length).toBeGreaterThan(20);
    expect(res.body.settings.moneyPolicies.transfers).toBe('exclude');
    expect(Object.keys(res.body).sort()).toEqual(
      [
        'accounts',
        'activities',
        'balanceHistory',
        'budgets',
        'categories',
        'categoryGroups',
        'connections',
        'connectorSlotsUsed',
        'fxRates',
        'goals',
        'holdings',
        'merchants',
        'prices',
        'receipts',
        'recurring',
        'rules',
        'securities',
        'settings',
        'tags',
        'taxLots',
        'transactions',
        'transferLinks',
      ].sort(),
    );
  });

  it('PATCH, review, split, undo, link and unlink work over HTTP', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    const t = await addTxn(checking, {
      date: '2026-11-02',
      amount: -10_000,
      categoryId: 'cat_shopping',
    });
    const { api } = client();
    const patched = await api<{ transaction: Transaction }>('PATCH', `/v1/transactions/${t.id}`, {
      categoryId: 'cat_gifts',
      notes: 'for Asha',
    });
    expect(patched.body.transaction.userEditedFields.sort()).toEqual(['categoryId', 'notes']);
    const reviewed = await api<{ transaction: Transaction }>(
      'POST',
      `/v1/transactions/${t.id}/review`,
      { reviewed: true },
    );
    expect(reviewed.body.transaction.reviewed).toBe(true);

    const bad = await api('POST', `/v1/transactions/${t.id}/split`, {
      idempotencyKey: 'x1',
      lines: [
        { amount: -6_000, categoryId: 'cat_gifts' },
        { amount: -5_000, categoryId: 'cat_dining' },
      ],
    });
    expect(bad.status).toBe(400);
    const split = await api<SplitResponse>('POST', `/v1/transactions/${t.id}/split`, {
      idempotencyKey: 'x2',
      lines: [
        { amount: -6_000, categoryId: 'cat_gifts' },
        { amount: -4_000, categoryId: 'cat_dining' },
      ],
    });
    expect(split.status).toBe(201);
    const again = await api<SplitResponse>('POST', `/v1/transactions/${t.id}/split`, {
      idempotencyKey: 'x2',
      lines: [
        { amount: -6_000, categoryId: 'cat_gifts' },
        { amount: -4_000, categoryId: 'cat_dining' },
      ],
    });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect((await api('DELETE', `/v1/transactions/${t.id}/split`)).status).toBe(200);

    const out = await addTxn(checking, { date: '2026-11-03', amount: -25_000, rawName: 'MOVE' });
    const into = await addTxn(savings, { date: '2026-11-20', amount: 25_000, rawName: 'IN' });
    const link = await api<{ link: TransferLink }>('POST', `/v1/transactions/${out.id}/link`, {
      otherTransactionId: into.id,
    });
    expect(link.status).toBe(201);
    expect(link.body.link).toMatchObject({
      status: 'confirmed',
      matchedBy: 'user',
      kind: 'transfer',
    });
    const unlinked = await api<{ link: TransferLink }>(
      'POST',
      `/v1/transactions/${into.id}/unlink`,
    );
    expect(unlinked.body.link.status).toBe('rejected');
  });

  it('suggested links can be listed and confirmed', async () => {
    const checking = await addAccount({ type: 'checking' });
    const savings = await addAccount({ type: 'savings' });
    await addTxn(checking, { date: '2026-11-02', amount: -50_000, rawName: 'TRANSFER' });
    await addTxn(savings, { date: '2026-11-02', amount: 50_000 });
    await addTxn(savings, { date: '2026-11-03', amount: 50_000 });
    const { api } = client();
    expect((await api('POST', '/v1/transfer-links/run')).body).toEqual({ linked: 0, suggested: 2 });
    const list = await api<{ links: TransferLink[] }>('GET', '/v1/transfer-links?status=suggested');
    expect(list.body.links).toHaveLength(2);
    const ok = await api<{ link: TransferLink }>(
      'POST',
      `/v1/transfer-links/${list.body.links[0]!.id}/confirm`,
    );
    expect(ok.body.link.status).toBe('confirmed');
  });

  it('POST /v1/cash adds a cash transaction to the default cash account for that currency', async () => {
    const { api } = client();
    const res = await api<{ transaction: Transaction }>('POST', '/v1/cash', {
      amount: -45_000,
      currency: 'INR',
      categoryId: 'cat_dining',
      name: 'Dosa',
      date: '2026-11-04',
    });
    expect(res.status).toBe(201);
    const accounts = await api<{
      accounts: {
        id: string;
        type: string;
        currency: string;
        balance: number;
        isDefaultCash: boolean;
      }[];
    }>('GET', '/v1/accounts');
    const cash = accounts.body.accounts.find((a) => a.type === 'cash')!;
    expect(cash).toMatchObject({ currency: 'INR', balance: -45_000, isDefaultCash: true });
    expect(res.body.transaction.accountId).toBe(cash.id);
    const s = await spending('2026-11-01', '2026-11-30', undefined, 'INR');
    expect(s.byCategory.cat_dining).toBe(45_000);
    expect((await api('POST', '/v1/cash', { amount: 12.5, currency: 'USD' })).status).toBe(400);
  });

  it('rules: create applies to existing rows; settings change the policy totals', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, { date: '2026-11-02', amount: -1_299, rawName: 'STREAMFLIX.COM' });
    const { api } = client();
    const rule = await api<{ applied: number }>('POST', '/v1/rules', {
      name: 'Streaming',
      conditions: [{ field: 'rawName', op: 'contains', value: 'streamflix' }],
      actions: [{ type: 'set_category', categoryId: 'cat_subscriptions' }],
    });
    expect(rule.status).toBe(201);
    expect(rule.body.applied).toBe(1);
    expect(
      (await api<{ transaction: Transaction }>('GET', `/v1/transactions/${t.id}`)).body.transaction
        .categoryId,
    ).toBe('cat_subscriptions');

    const s = await api<Settings>('PATCH', '/v1/settings', {
      moneyPolicies: { cardPayments: 'count' },
      aiEnabled: false,
    });
    expect(s.body.moneyPolicies).toMatchObject({ cardPayments: 'count', transfers: 'exclude' });
    expect(s.body.aiEnabled).toBe(false);
    expect(
      (await api('PATCH', '/v1/settings', { moneyPolicies: { cardPayments: 'sometimes' } })).status,
    ).toBe(400);
  });

  it('imports a bank CSV with a preamble, saves the mapping and reuses it next time', async () => {
    const checking = await addAccount({ type: 'checking' });
    await addRate('2026-10-15', 'INR', 88.0);
    const { api } = client();
    const first = await api<ImportResponse>(
      'POST',
      '/v1/imports',
      upload(
        { accountId: checking.id, skipRows: '2', commit: 'true' },
        lakeshoreCsv,
        'lakeshore.csv',
      ),
    );
    expect(first.status).toBe(201);
    // 5 rows; the ATM withdrawal gets its cash-side deposit and link.
    expect(first.body.result).toMatchObject({ added: 5, linked: 1 });
    const mappings = await api<{ mappings: { signature: string }[] }>('GET', '/v1/import-mappings');
    expect(mappings.body.mappings).toHaveLength(1);
    const second = await api<ImportResponse>(
      'POST',
      '/v1/imports',
      upload({ accountId: checking.id, skipRows: '2' }, lakeshoreCsv, 'lakeshore-again.csv'),
    );
    expect(second.body.preview.csv?.usedSavedMapping).toBe(true);
    expect(second.body.preview.counts).toMatchObject({ new: 0, alreadyImported: 5 });
    const vault = await api<{ files: { id: string; status: string }[] }>('GET', '/v1/vault');
    expect(vault.body.files).toHaveLength(2);
    const original = await client().raw(`/v1/vault/${vault.body.files[1]!.id}/file`, {
      headers: { authorization: 'Bearer test-app-token' },
    });
    expect(await original.text()).toBe(lakeshoreCsv);
  });

  it('dev seed loads the invented sample dataset', async () => {
    const res = await client().api<{ accounts: number; transactions: number }>(
      'POST',
      '/v1/dev/seed',
    );
    expect(res.status).toBe(201);
    expect(res.body.transactions).toBeGreaterThan(100);
    const ds = await client().api<FinanceDataset>('GET', '/v1/dataset');
    expect(ds.body.transactions.length).toBe(res.body.transactions);
  });
});
