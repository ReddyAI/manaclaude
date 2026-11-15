import { beforeEach, describe, expect, it } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { applySyncResult } from '../src/sync/apply';
import { syncConnection, syncDueConnections, type ConnectionSyncReport } from '../src/sync/run';
import { saveCredentials } from '../src/sync/credentials';
import { createWorker, SYNC_CRON } from '../src/worker';
import { bankReviewList, resolveBankReview } from '../src/history/reviews';
import { previewHistoryPolicy } from '../src/history/service';
import { readPolicy } from '../src/history/store';
import { selectAll } from '../src/db/table';
import {
  accountsTable,
  activitiesTable,
  connectionsTable,
  holdingsTable,
  taxLotsTable,
} from '../src/db/tables';
import { meterDb } from '../src/db/meter';
import { addAccount, addTxn, allTxns, db, freshDb, testEnv } from './helpers';
import { client } from './worker';
import {
  NOW,
  activate,
  bank,
  beforeBatch,
  connection,
  policy,
  provider,
  result,
} from './history-fixtures';
beforeEach(freshDb);

describe('bank write policy', () => {
  it('filters replay, preserves repeated purchases and current balances', async () => {
    const c = await connection(),
      a = await bank();
    await activate({
      ...policy,
      accounts: [{ accountId: a.id, mode: 'default', replacementMonths: ['2024-02'] }],
    });
    const r = result(
      [a],
      ['2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01', '2024-04-14', '2024-04-15'].map(
        (d) => provider(a, d),
      ),
    );
    r.transactions.push(provider(a, '2024-04-15', -500, 'second-real-purchase'));
    const s = await applySyncResult(db, c, r, NOW);
    expect(s).toMatchObject({ inserted: 4, historyPolicy: { excluded: 3 } });
    expect((await applySyncResult(db, c, r, NOW)).inserted).toBe(0);
    expect(await allTxns()).toHaveLength(4);
    expect((await selectAll(db, accountsTable))[0]).toMatchObject({
      balance: 98765,
      balanceAsOf: NOW,
    });
  });
  it('uses distinct account rules and a Monefy-only exception', async () => {
    const c = await connection(),
      a = await bank(),
      b = await bank('Elm'),
      d = await bank('Pine');
    await activate({
      ...policy,
      accounts: [
        { accountId: b.id, mode: 'custom', cutoff: '2024-06-01', replacementMonths: [] },
        { accountId: d.id, mode: 'monefy_only' },
      ],
    });
    await applySyncResult(
      db,
      c,
      result(
        [a, b, d],
        [
          provider(a, '2024-05-01'),
          provider(b, '2024-05-01'),
          provider(d, '2024-05-01'),
          provider(b, '2024-06-01'),
        ],
      ),
      NOW,
    );
    expect((await allTxns()).map((t) => [t.accountId, t.date])).toEqual([
      [a.id, '2024-05-01'],
      [b.id, '2024-06-01'],
    ]);
    expect((await selectAll(db, accountsTable)).every((a) => a.balance === 98765)).toBe(true);
  });
  it('applies default to newly discovered banks and preserves investment transactions/holdings/lots/activity', async () => {
    const c = await connection();
    await activate();
    const a = await bank(),
      investment = await addAccount({
        type: 'brokerage',
        connectionId: c.id,
        externalId: 'brokerage',
      });
    await db.prepare('DELETE FROM accounts WHERE id = ?').bind(a.id).run();
    const r = result(
      [a, investment],
      [
        provider(a, '2024-01-01'),
        provider(a, '2024-04-15'),
        provider(investment, '2020-01-01', -10000),
      ],
    );
    r.holdings = [
      {
        accountExternalId: investment.externalId!,
        symbol: 'DEMO',
        name: 'Invented Fund',
        securityType: 'etf',
        exchange: null,
        quantity: '1',
        price: '100',
        currency: 'USD',
        costBasis: 10000,
        lots: [
          {
            externalId: 'lot',
            acquiredOn: '2020-01-01',
            quantity: '1',
            costBasis: 10000,
            currency: 'USD',
          },
        ],
      },
    ];
    r.activities = [
      {
        externalId: 'buy',
        accountExternalId: investment.externalId!,
        symbol: 'DEMO',
        type: 'buy',
        date: '2020-01-01',
        quantity: '1',
        price: '100',
        amount: -10000,
        fees: 0,
        currency: 'USD',
        splitRatio: null,
      },
    ];
    await applySyncResult(db, c, r, NOW);
    expect((await allTxns()).map((t) => t.date).sort()).toEqual(['2020-01-01', '2024-04-15']);
    expect(await selectAll(db, holdingsTable)).toHaveLength(1);
    expect(await selectAll(db, taxLotsTable)).not.toHaveLength(0);
    expect((await selectAll(db, activitiesTable))[0]?.date).toBe('2020-01-01');
  });
  it('holds boundary candidates for keep/skip, then replays without duplicates', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:purchase',
    });
    const r = result(
      [a],
      [provider(a, '2024-04-15', -500, 'first'), provider(a, '2024-04-16', -500, 'second')],
    );
    expect((await applySyncResult(db, c, r, NOW)).historyPolicy.pendingReview).toBe(2);
    expect(await allTxns()).toHaveLength(1);
    let list = await bankReviewList(db);
    expect(list.reviews).toHaveLength(2);
    const first = list.reviews[0]!;
    expect(first.candidates).toHaveLength(1);
    expect((await previewHistoryPolicy(db, policy)).pendingBankReviews).toBe(2);
    await resolveBankReview(
      db,
      first.id,
      { previewToken: first.previewToken, decision: 'keep' },
      NOW,
    );
    list = await bankReviewList(db);
    const second = list.reviews[0]!;
    await resolveBankReview(
      db,
      second.id,
      { previewToken: second.previewToken, decision: 'skip' },
      NOW,
    );
    await expect(
      resolveBankReview(
        db,
        second.id,
        { previewToken: second.previewToken, decision: 'skip' },
        NOW,
      ),
    ).resolves.toMatchObject({ replayed: true, decision: 'skip' });
    expect((await previewHistoryPolicy(db, policy)).allowed).toBe(true);
    await applySyncResult(db, c, r, NOW);
    expect(await allTxns()).toHaveLength(2);
    expect((await bankReviewList(db)).reviews).toEqual([]);
  });
  it('invalidates removed and newly excluded provider proposals', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:purchase',
    });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const old = (await bankReviewList(db)).reviews[0]!;
    await applySyncResult(
      db,
      c,
      result([a], [provider(a, '2024-04-14', -500, 'p-2024-04-15')]),
      NOW,
    );
    expect((await bankReviewList(db)).reviews).toEqual([]);
    await expect(
      resolveBankReview(db, old.id, { previewToken: old.previewToken, decision: 'keep' }, NOW),
    ).rejects.toMatchObject({ code: 'history_review_resolved' });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const removal = result([a], []);
    removal.removedTransactionExternalIds = ['p-2024-04-15'];
    await applySyncResult(db, c, removal, NOW);
    expect((await bankReviewList(db)).reviews).toEqual([]);
  });
  it('rechecks review tokens and rolls back a late review failure', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    const m = await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:purchase',
    });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const old = (await bankReviewList(db)).reviews[0]!;
    await db.prepare('UPDATE transactions SET amount = -600 WHERE id = ?').bind(m.id).run();
    await expect(
      resolveBankReview(db, old.id, { previewToken: old.previewToken, decision: 'keep' }, NOW),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    const fresh = (await bankReviewList(db)).reviews[0]!;
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return (s: D1PreparedStatement[]) =>
            target.batch([
              ...s,
              target.prepare("INSERT INTO history_write_guard (token,valid) VALUES ('fail',0)"),
            ]);
        const v: unknown = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await expect(
      resolveBankReview(
        broken,
        fresh.id,
        { previewToken: fresh.previewToken, decision: 'keep' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await allTxns()).toHaveLength(1);
    expect((await bankReviewList(db)).reviews).toHaveLength(1);
    await resolveBankReview(
      db,
      fresh.id,
      { previewToken: fresh.previewToken, decision: 'keep' },
      NOW,
    );
    expect(await allTxns()).toHaveLength(2);
  });
  it('reviews provider corrections without overwriting existing history or user notes', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:purchase',
    });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-20')]), NOW);
    const bankTxn = (await allTxns()).find((t) => t.source === 'connector')!;
    await db
      .prepare('UPDATE transactions SET notes = ? WHERE id = ?')
      .bind('Keep this note', bankTxn.id)
      .run();
    await applySyncResult(
      db,
      c,
      result([a], [provider(a, '2024-04-15', -500, 'p-2024-04-20')]),
      NOW,
    );
    const review = (await bankReviewList(db)).reviews[0]!;
    expect(review.existingTransaction?.date).toBe('2024-04-20');
    await resolveBankReview(
      db,
      review.id,
      { previewToken: review.previewToken, decision: 'keep' },
      NOW,
    );
    expect((await allTxns()).find((t) => t.id === bankTxn.id)).toMatchObject({
      date: '2024-04-15',
      notes: 'Keep this note',
    });
  });
  it('fences policy/import races in bank writes while keeping balances current', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await expect(
      applySyncResult(
        beforeBatch(() => activate({ ...policy, defaultCutoff: '2024-05-01' }), 2),
        c,
        result([a], [provider(a, '2024-04-15')]),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await allTxns()).toEqual([]);
    expect((await selectAll(db, accountsTable))[0]?.balance).toBe(98765);
    await activate(policy);
    await expect(
      applySyncResult(
        beforeBatch(
          () =>
            addTxn(a, {
              date: '2024-04-14',
              amount: -500,
              source: 'import',
              externalId: 'monefy:race',
            }),
          2,
        ),
        c,
        result([a], [provider(a, '2024-04-15')]),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect(await allTxns()).toHaveLength(1);
    expect(
      (await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW)).historyPolicy
        .pendingReview,
    ).toBe(1);
  });
});

describe('all bank sync entry paths with invented SimpleFIN responses', () => {
  const env = { ...testEnv, CREDENTIALS_SECRET: 'test-credentials-secret-0123456789' };
  const fakeFetch = (async () =>
    Response.json({
      errors: [],
      accounts: [
        {
          id: 'invented-account',
          name: 'Everyday Checking',
          currency: 'USD',
          balance: '123.45',
          'balance-date': Date.parse(NOW) / 1000,
          transactions: ['2024-01-01', '2024-02-10', '2024-04-15', '2024-04-16'].map((date, i) => ({
            id: `purchase-${i}`,
            posted: Date.parse(`${date}T12:00:00Z`) / 1000,
            amount: '-5.00',
            description: 'Invented purchase',
          })),
        },
      ],
    })) as typeof fetch;
  async function setup() {
    const c = await connection();
    await saveCredentials(env, c.id, {
      SIMPLEFIN_ACCESS_URL: 'https://demo:invented@bridge.example.invalid/simplefin',
    });
    await activate();
    return c;
  }
  it.each(['initial', 'manual', 'forced', 'repair', 'scheduled', 'cron', 'continuation', 'replay'])(
    'enforces periods on %s',
    async (path) => {
      const c = await setup();
      const meter = meterDb(db);
      const meteredEnv = { ...env, DB: meter.db };
      if (path === 'repair')
        await db
          .prepare("UPDATE connections SET status = 'syncing', last_error = NULL WHERE id = ?")
          .bind(c.id)
          .run();
      if (path === 'forced')
        await db
          .prepare("UPDATE connections SET status = 'needs_repair' WHERE id = ?")
          .bind(c.id)
          .run();
      if (path === 'continuation' || path === 'replay')
        await syncConnection(env, c.id, {
          fetch: fakeFetch,
          now: () => new Date(NOW),
          maxRows: path === 'continuation' ? 1 : 1200,
        });
      if (path === 'cron') {
        const worker = createWorker({ fetch: fakeFetch, now: () => new Date(NOW) });
        const ctx = createExecutionContext();
        await worker.scheduled(
          { cron: SYNC_CRON, scheduledTime: Date.parse(NOW) } as ScheduledController,
          meteredEnv,
          ctx,
        );
        await waitOnExecutionContext(ctx);
      } else if (path === 'scheduled')
        await syncDueConnections(meteredEnv, { fetch: fakeFetch, now: () => new Date(NOW) });
      else if (path === 'manual')
        expect(
          (
            await client(
              { fetch: fakeFetch, now: () => new Date(NOW) },
              meteredEnv,
            ).api<ConnectionSyncReport>('POST', `/v1/connections/${c.id}/sync`)
          ).body.outcome,
        ).toBe('ok');
      else
        expect(
          (
            await syncConnection(meteredEnv, c.id, {
              fetch: fakeFetch,
              force: path === 'forced',
              now: () => new Date(NOW),
            })
          ).outcome,
        ).toBe('ok');
      const txns = await allTxns();
      expect(txns.map((t) => t.date).sort()).toEqual(['2024-04-15', '2024-04-16']);
      expect(meter.used()).toBeLessThanOrEqual(50);
      expect((await selectAll(db, accountsTable))[0]?.balance).toBe(12345);
      expect((await readPolicy(db)).version).toBe(1);
    },
  );
  it('rechecks a policy changed while a provider response is in flight', async () => {
    const c = await setup();
    const fetch = (async () => {
      await activate({ ...policy, defaultCutoff: '2024-04-16' });
      return fakeFetch('https://fixture.invalid');
    }) as typeof globalThis.fetch;
    await syncConnection(env, c.id, { fetch, now: () => new Date(NOW) });
    expect((await allTxns()).map((t) => t.date)).toEqual(['2024-04-16']);
  });
  it('rolls back transactions and cursor on data failure and retries safely', async () => {
    const c = await setup();
    let batches = 0;
    const broken = new Proxy(db, {
      get(target, key) {
        if (key === 'batch')
          return (s: D1PreparedStatement[]) =>
            target.batch(
              ++batches === 2
                ? [
                    ...s,
                    target.prepare(
                      "INSERT INTO history_write_guard (token,valid) VALUES ('fail',0)",
                    ),
                  ]
                : s,
            );
        const v: unknown = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    expect(
      (
        await syncConnection({ ...env, DB: broken }, c.id, {
          fetch: fakeFetch,
          now: () => new Date(NOW),
        })
      ).outcome,
    ).toBe('error');
    expect(await allTxns()).toEqual([]);
    expect((await selectAll(db, connectionsTable))[0]?.syncCursor).toBeNull();
    expect(
      (await syncConnection(env, c.id, { fetch: fakeFetch, now: () => new Date(NOW) })).outcome,
    ).toBe('ok');
    expect(await allTxns()).toHaveLength(2);
  });
});

describe('review persistence, continuation and HTTP decisions', () => {
  it('pages held candidates without starving continuation or prematurely advancing the cursor', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:review',
    });
    const r = result(
      [a],
      Array.from({ length: 5 }, (_, i) => provider(a, '2024-04-15', -500, `real-purchase-${i}`)),
    );
    const first = await applySyncResult(db, c, r, NOW, { maxRows: 2 });
    expect(first).toMatchObject({ more: true, remaining: 3, historyPolicy: { pendingReview: 2 } });
    expect((await selectAll(db, connectionsTable))[0]?.syncCursor).toBeNull();
    const second = await applySyncResult(db, c, r, NOW, { maxRows: 2 });
    expect(second).toMatchObject({ more: true, remaining: 1, historyPolicy: { pendingReview: 4 } });
    const last = await applySyncResult(db, c, r, NOW, { maxRows: 2 });
    expect(last).toMatchObject({ more: false, remaining: 0, historyPolicy: { pendingReview: 5 } });
    expect((await bankReviewList(db)).reviews).toHaveLength(5);
    expect(await allTxns()).toHaveLength(1);
    expect((await selectAll(db, connectionsTable))[0]?.syncCursor).toBe('next');
  });
  it('returns review detail, validates decisions, and replays an uncertain keep exactly once', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:review',
    });
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-15')]), NOW);
    const api = client({ now: () => new Date(NOW) }).api;
    const list = await api<Awaited<ReturnType<typeof bankReviewList>>>(
      'GET',
      '/v1/history-policy/bank-reviews',
    );
    const review = list.body.reviews[0]!;
    expect((await api('GET', `/v1/history-policy/bank-reviews/${review.id}`)).body).toMatchObject({
      review: { status: 'pending', eligible: true },
    });
    expect(
      (await api('POST', `/v1/history-policy/bank-reviews/${review.id}`, { decision: 'keep' }))
        .status,
    ).toBe(400);
    const request = { previewToken: review.previewToken, decision: 'keep' };
    expect(
      (await api('POST', `/v1/history-policy/bank-reviews/${review.id}`, request)).body,
    ).toMatchObject({ transactionId: review.transaction.id, replayed: false });
    expect(
      (await api('POST', `/v1/history-policy/bank-reviews/${review.id}`, request)).body,
    ).toMatchObject({ transactionId: review.transaction.id, replayed: true });
    expect((await api('GET', `/v1/history-policy/bank-reviews/${review.id}`)).body).toMatchObject({
      review: { status: 'kept' },
    });
    expect(await allTxns()).toHaveLength(2);
  });
  it('does not expire or remove excluded bank rows when a provider corrects their date across ownership', async () => {
    const c = await connection(),
      a = await bank();
    await activate();
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-16', -500, 'stable')]), NOW);
    const original = (await allTxns())[0]!;
    await applySyncResult(db, c, result([a], [provider(a, '2024-04-14', -500, 'stable')]), NOW);
    expect((await allTxns())[0]).toEqual(original);
  });
});
