import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, DEFAULT_FX_QUOTES } from '@manaclaude/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { backfillMissingHistory } from '../src/fx/service';
import { FX_BACKFILL_DAYS, FX_BACKFILL_LEASE_MS } from '../src/fx/backfill';
import { bulkInsertSpecs, runSpecs } from '../src/db/bulk';
import { meterDb } from '../src/db/meter';
import { transactionsTable } from '../src/db/tables';
import { makeTransaction } from '../src/services/transactions';
import { createWorker } from '../src/worker';
import { updateSettings } from '../src/services/settings';
import { addAccount, addTxn, addRate, freshDb, testEnv } from './helpers';

const db = testEnv.DB;
const NOW = new Date('2026-11-05T06:30:00Z');
const now = () => NOW;
const through = '2022-01-01';
const options = { now, through };
type Fetcher = Parameters<typeof backfillMissingHistory>[1];

/** Invented published calendar: weekends and Jan 1 have no new rate. */
function dayResponse(url: string) {
  const u = new URL(url);
  let date = u.pathname.split('/').at(-1)!;
  while ([0, 6].includes(new Date(date).getUTCDay()) || date.endsWith('-01-01'))
    date = addDays(date, -1);
  const quote = u.searchParams.get('symbols')!;
  return { amount: 1, base: 'USD', date, rates: { [quote]: quote === 'INR' ? 80 : 0.9 } };
}
function provider() {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return Response.json(dayResponse(url));
  };
  return { calls, fetcher };
}
async function seed(date = '2020-01-01') {
  const account = await addAccount({ type: 'savings', currency: 'INR', balance: 12345 });
  await addTxn(account, { amount: -100, date, notes: 'Invented preserved note' });
  await chooseInr();
  return account;
}
async function chooseInr() {
  await db
    .prepare(
      "INSERT INTO fx_backfill_scheduler (id, last_quote) VALUES (1, 'GBP') ON CONFLICT (id) DO UPDATE SET last_quote = 'GBP'",
    )
    .run();
}
async function checkpoint(quote = 'INR') {
  return db.prepare('SELECT * FROM fx_backfill_progress WHERE quote = ?').bind(quote).first();
}
async function invoke(fetcher: Fetcher = provider().fetcher, opts = options, database = db) {
  const meter = meterDb(database);
  const stored = await backfillMissingHistory({ ...testEnv, DB: meter.db }, fetcher, opts);
  return { stored, queries: meter.used() };
}

/** Interruption at the atomic batch boundary; can also fail its second statement. */
function interruptBatch(mode: 'before' | 'during' | 'after') {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch')
        return async (stmts: D1PreparedStatement[]) => {
          if (mode === 'before') throw new Error('invented interruption before writes');
          if (mode === 'during')
            return target.batch([
              stmts[0]!,
              target.prepare('INSERT INTO missing_fx_test_table VALUES (1)'),
              ...stmts.slice(1),
            ]);
          await target.batch(stmts);
          throw new Error('invented lost commit response');
        };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(freshDb);

describe('bounded historical FX', () => {
  it('replaces the reproduced multi-year request and old-EUR false completion with a bounded INR chunk', async () => {
    await seed();
    await addRate('2020-01-01', 'EUR', 0.9);
    await addRate('2020-01-02', 'INR', 70);
    const f = provider();
    const result = await invoke(f.fetcher);
    expect(result.queries).toBe(7);
    expect(f.calls).toHaveLength(FX_BACKFILL_DAYS);
    expect(f.calls[0]).toContain('/2020-01-01?');
    expect(f.calls.at(-1)).toContain('/2020-01-28?');
    expect(await checkpoint()).toMatchObject({ start_date: '2020-01-01', next_date: '2020-01-29' });
    expect(result.stored).toBeLessThan(FX_BACKFILL_DAYS);
    expect(
      await db
        .prepare("SELECT rate FROM fx_rates WHERE quote='INR' AND date='2020-01-02'")
        .first('rate'),
    ).toBe(80);
    expect(
      await db
        .prepare("SELECT date FROM fx_rates WHERE quote='INR' ORDER BY date LIMIT 1")
        .first('date'),
    ).toBe('2019-12-31');
  });

  it('completes invented multi-year USD/INR history over bounded invocations and preserves financial records', async () => {
    const inr = await seed();
    const usd = await addAccount({ type: 'checking', currency: 'USD', balance: 654321 });
    const transactions = [];
    for (let date = '2020-01-02'; date <= through; date = addDays(date, 1))
      for (const account of [inr, usd])
        transactions.push(
          makeTransaction({
            accountId: account.id,
            currency: account.currency,
            date,
            amount: -123,
            rawName: 'Invented purchase',
            notes: 'Preserve me',
            source: 'manual',
          }),
        );
    await runSpecs(db, bulkInsertSpecs(transactionsTable, transactions));
    await db
      .prepare('INSERT INTO balance_snapshots VALUES (?, ?, ?, ?)')
      .bind(inr.id, '2020-01-01', 12345, 'INR')
      .run();
    const financial = async () =>
      Promise.all(
        ['accounts', 'transactions', 'balance_snapshots'].map((table) =>
          db
            .prepare(`SELECT * FROM ${table} ORDER BY 1, 2`)
            .all()
            .then((r) => r.results),
        ),
      );
    const before = await financial();
    let runs = 0;
    let maxQueries = 0;
    let requests = 0;
    const started = Date.now();
    while (runs++ < 300) {
      const f = provider();
      const result = await invoke(f.fetcher);
      maxQueries = Math.max(maxQueries, result.queries);
      requests += f.calls.length;
      expect(f.calls.length).toBeLessThanOrEqual(28);
      expect(result.queries).toBeLessThanOrEqual(8);
      const complete = await db
        .prepare('SELECT count(*) AS n FROM fx_backfill_progress WHERE next_date = ?')
        .bind(addDays(through, 1))
        .first<number>('n');
      if (complete === DEFAULT_FX_QUOTES.length) break;
    }
    expect(runs).toBeLessThan(300);
    expect(await financial()).toEqual(before);
    expect(
      await db.prepare('SELECT count(*) AS n FROM fx_rates').first<number>('n'),
    ).toBeGreaterThan(4000);
    await chooseInr();
    const idle = provider();
    expect(await invoke(idle.fetcher)).toEqual({ stored: 0, queries: 5 });
    expect(idle.calls).toEqual([]);
    console.warn('Invented FX backfill measurement', {
      runs,
      maxQueries,
      requests,
      elapsedMs: Date.now() - started,
      transactions: transactions.length + 1,
    });
  }, 60_000);

  it.each(['before', 'during', 'after'] as const)(
    'retries interruption %s atomic writes without partial coverage or duplicate rates',
    async (mode) => {
      await seed();
      await expect(invoke(provider().fetcher, options, interruptBatch(mode))).rejects.toThrow();
      const committed = mode === 'after';
      expect(Boolean(await checkpoint())).toBe(committed);
      const count = await db.prepare('SELECT count(*) AS n FROM fx_rates').first<number>('n');
      expect(count === 0).toBe(!committed);
      await chooseInr();
      const f = provider();
      await invoke(f.fetcher);
      expect(f.calls[0]).toContain(committed ? '/2020-01-29?' : '/2020-01-01?');
      const duplicates = await db
        .prepare(
          'SELECT base, quote, date, source FROM fx_rates GROUP BY base, quote, date, source HAVING count(*) > 1',
        )
        .all();
      expect(duplicates.results).toEqual([]);
    },
  );

  it('counts checkpoint, lease and lost-response cleanup queries in the worst case', async () => {
    await seed();
    await db.prepare("UPDATE fx_backfill_scheduler SET last_quote = 'ZZZ'").run();
    const meter = meterDb(interruptBatch('after'));
    await expect(
      backfillMissingHistory({ ...testEnv, DB: meter.db }, provider().fetcher, options),
    ).rejects.toThrow('lost commit response');
    expect(meter.used()).toBe(9);
    expect(await checkpoint('AED')).toMatchObject({ next_date: '2020-01-29' });
  });

  it('refuses to commit an expired owner even before another invocation takes over', async () => {
    await seed();
    let clock = NOW;
    const f = provider();
    await expect(
      invoke(
        async (url, init) => {
          clock = new Date(NOW.getTime() + FX_BACKFILL_LEASE_MS);
          return f.fetcher!(url, init);
        },
        { through, now: () => clock },
      ),
    ).rejects.toThrow('lease expired');
    expect(await checkpoint()).toBeNull();
    expect(await db.prepare('SELECT count(*) AS n FROM fx_rates').first('n')).toBe(0);
    await chooseInr();
    expect((await invoke()).stored).toBeGreaterThan(0);
  });

  it('does one lease query for an overlap and fences a stalled worker after lease takeover', async () => {
    await seed();
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    const stale = invoke(async (url) => {
      if (first) {
        first = false;
        entered();
        await blocked;
      }
      const json = dayResponse(url);
      json.rates.INR = 999;
      return Response.json(json);
    });
    await started;
    const overlap = provider();
    expect(await invoke(overlap.fetcher)).toEqual({ stored: 0, queries: 1 });
    expect(overlap.calls).toHaveLength(0);
    const replacement = await invoke(provider().fetcher, {
      through,
      now: () => new Date(NOW.getTime() + FX_BACKFILL_LEASE_MS),
    });
    expect(replacement.stored).toBeGreaterThan(0);
    unblock();
    expect((await stale).stored).toBe(0);
    expect(await db.prepare('SELECT count(*) AS n FROM fx_rates WHERE rate = 999').first('n')).toBe(
      0,
    );
    expect(await checkpoint()).toMatchObject({ next_date: '2020-01-29' });
  });

  it('recovers an abandoned lease without skipping its unfinished date range', async () => {
    await seed();
    await db
      .prepare("UPDATE fx_backfill_scheduler SET lease_token='dead', lease_until=?")
      .bind(NOW.getTime())
      .run();
    const f = provider();
    await invoke(f.fetcher);
    expect(f.calls[0]).toContain('/2020-01-01?');
  });

  it.each([
    'http',
    'empty',
    'missing quote',
    'missing date',
    'future',
    'stale',
    'wrong base',
    'wrong amount',
    'negative',
    'truncated',
    'oversized',
  ])('keeps required work pending after a %s response halfway through a chunk', async (kind) => {
    await seed();
    let calls = 0;
    await expect(
      invoke(async (url) => {
        const data: Record<string, unknown> = dayResponse(url);
        if (++calls !== 10) return Response.json(data);
        switch (kind) {
          case 'http':
            return new Response('', { status: 503 });
          case 'empty':
            return Response.json({});
          case 'missing quote':
            data.rates = { EUR: 0.9 };
            break;
          case 'missing date':
            delete data.date;
            break;
          case 'future':
            data.date = '2027-01-01';
            break;
          case 'stale':
            data.date = '2019-01-01';
            break;
          case 'wrong base':
            data.base = 'EUR';
            break;
          case 'wrong amount':
            data.amount = 2;
            break;
          case 'negative':
            data.rates = { INR: -1 };
            break;
          case 'truncated':
            return new Response('{"rates":');
          case 'oversized':
            return new Response(' '.repeat(4097));
        }
        return Response.json(data);
      }),
    ).rejects.toThrow();
    expect(await checkpoint()).toBeNull();
    expect(await db.prepare('SELECT count(*) AS n FROM fx_rates').first('n')).toBe(0);
    await chooseInr();
    const f = provider();
    await invoke(f.fetcher);
    expect(f.calls[0]).toContain('/2020-01-01?');
  });

  it('restarts on older imports after completion and discovers a new transaction-only currency', async () => {
    const account = await seed('2021-12-25');
    await invoke();
    expect(await checkpoint()).toMatchObject({ next_date: '2022-01-02' });
    await addTxn(account, { amount: -300, date: '2018-06-01' });
    await chooseInr();
    const f = provider();
    await invoke(f.fetcher);
    expect(f.calls[0]).toContain('/2018-06-01?');
    expect(await checkpoint()).toMatchObject({ start_date: '2018-06-01', next_date: '2018-06-29' });
    await addTxn(account, { amount: -400, date: '2020-01-01', currency: 'NOK' });
    await db.prepare("UPDATE fx_backfill_scheduler SET last_quote = 'JPY'").run();
    const gap = provider();
    await invoke(gap.fetcher);
    expect(gap.calls[0]).toContain('symbols=NOK');
    expect(await checkpoint('NOK')).toMatchObject({ start_date: '2018-06-01' });
  });

  it('detects older history imported while a chunk is in flight on its next visit', async () => {
    const account = await seed();
    let imported = false;
    await invoke(async (url) => {
      if (!imported) {
        imported = true;
        await addTxn(account, { amount: -500, date: '2017-01-01' });
      }
      return Response.json(dayResponse(url));
    });
    await chooseInr();
    const f = provider();
    await invoke(f.fetcher);
    expect(f.calls[0]).toContain('/2017-01-01?');
    expect(await checkpoint()).toMatchObject({ start_date: '2017-01-01', next_date: '2017-01-29' });
  });

  it('does no provider work without past transactions and releases its lease', async () => {
    const f = provider();
    expect(await invoke(f.fetcher)).toEqual({ stored: 0, queries: 3 });
    expect(f.calls).toHaveLength(0);
    expect(
      await db.prepare('SELECT lease_token FROM fx_backfill_scheduler').first('lease_token'),
    ).toBeNull();
  });

  it('rotates failed/unsupported currencies, and bounds wraparound discovery', async () => {
    await seed();
    await db.prepare("UPDATE fx_backfill_scheduler SET last_quote = 'ZZZ'").run();
    const meter = meterDb(db);
    await expect(
      backfillMissingHistory(
        { ...testEnv, DB: meter.db },
        async () => new Response('', { status: 404 }),
        options,
      ),
    ).rejects.toThrow('404');
    expect(meter.used()).toBe(6);
    expect(await checkpoint('AED')).toBeNull();
    const f = provider();
    await invoke(f.fetcher);
    expect(f.calls[0]).toContain('symbols=AUD');
  });

  it('uses indexed seeks for currency and oldest-date discovery', async () => {
    await seed();
    for (const sql of [
      "SELECT min(currency) FROM accounts WHERE currency > 'GBP'",
      "SELECT min(currency) FROM transactions WHERE currency > 'GBP'",
      'SELECT min(date) FROM transactions',
    ]) {
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      expect(plan.results.some((r) => /USING COVERING INDEX/.test(r.detail))).toBe(true);
    }
  });

  it.each([200, 503])(
    'continues history on the existing hourly path after OXR HTTP %s',
    async (status) => {
      await seed('2026-11-01');
      const f = provider();
      const meter = meterDb(db);
      const ctx = createExecutionContext();
      const worker = createWorker({
        now,
        fetch: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes('openexchangerates'))
            return Response.json(
              { base: 'USD', timestamp: NOW.getTime() / 1000, rates: { INR: 81 } },
              { status },
            );
          return f.fetcher!(url);
        }) as typeof fetch,
      });
      await worker.scheduled(
        { cron: '0 * * * *', scheduledTime: NOW.getTime(), noRetry() {} },
        { ...testEnv, OXR_APP_ID: 'invented-app-id', DB: meter.db },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(await checkpoint()).toMatchObject({ next_date: '2026-11-05' });
      expect(f.calls).toHaveLength(4);
      expect(meter.used()).toBe(status === 200 ? 11 : 10);
      expect(
        await db
          .prepare("SELECT rate FROM fx_rates WHERE source='openexchangerates' AND quote='INR'")
          .first('rate'),
      ).toBe(status === 200 ? 81 : null);
    },
  );

  it('uses the scheduled date for the history horizon and measures the whole daily invocation', async () => {
    await seed('2026-11-01');
    await updateSettings(db, { aiEnabled: false });
    const f = provider();
    const meter = meterDb(db);
    const ctx = createExecutionContext();
    const worker = createWorker({
      now,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/latest'))
          return Response.json({ amount: 1, base: 'USD', date: '2026-11-04', rates: { INR: 80 } });
        return f.fetcher!(url);
      }) as typeof fetch,
    });
    await worker.scheduled(
      { cron: '30 6 * * *', scheduledTime: NOW.getTime(), noRetry() {} },
      { ...testEnv, DB: meter.db },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(f.calls).toHaveLength(4);
    expect(await checkpoint()).toMatchObject({ next_date: '2026-11-05' });
    console.warn('Invented daily invocation queries (AI disabled, small history)', meter.used());
    expect(meter.used()).toBe(11);
  });
});
