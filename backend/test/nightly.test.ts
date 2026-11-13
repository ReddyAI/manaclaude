import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, DEFAULT_FX_QUOTES, type Recap } from '@manaclaude/shared';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { NIGHTLY_CRON, runNightlyStep, type NightlyState } from '../src/nightly';
import { LEASE_MS } from '../src/nightly/store';
import { meterDb } from '../src/db/meter';
import { bulkInsertSpecs, runSpecs } from '../src/db/bulk';
import { accountsTable, categoriesTable, transactionsTable } from '../src/db/tables';
import { insertStatement, selectAll } from '../src/db/table';
import { createWorker } from '../src/worker';
import { makeTransaction, getTransaction } from '../src/services/transactions';
import { updateSettings } from '../src/services/settings';
import { generateRecap, lastCompletePeriod } from '../src/ai/jobs/recap';
import { fetchScheduledLatest } from '../src/fx/latest';
import { addAccount, addRate, addTxn, db, freshDb, testEnv } from './helpers';
import { measureRows } from './d1-work';
import { fakeAi } from './fakes';

const NOW = new Date('2026-11-02T06:32:00Z');
const now = () => NOW;
const noFetch = (async () => {
  throw new Error('Unexpected network');
}) as typeof fetch;
async function state() {
  const row = await db.prepare('SELECT state FROM nightly_state').first<string>('state');
  return row ? (JSON.parse(row) as NightlyState) : null;
}
async function setPhase(phase: NightlyState['phase'], day = '2026-11-02') {
  const data: NightlyState = { day, phase, after: '', alert: null, categorize: null, recap: null };
  await db
    .prepare('INSERT OR REPLACE INTO nightly_state VALUES (1, ?, NULL, 0)')
    .bind(JSON.stringify(data))
    .run();
}
async function step(
  deps: Parameters<typeof runNightlyStep>[2] = {},
  database = db,
  scheduled = NOW,
) {
  const meter = meterDb(database);
  await runNightlyStep({ ...testEnv, DB: meter.db }, scheduled, { fetch: noFetch, now, ...deps });
  expect(meter.used()).toBeLessThanOrEqual(38);
  return meter.used();
}
async function complete(deps: Parameters<typeof runNightlyStep>[2] = {}, scheduled = NOW) {
  let runs = 0;
  let maxQueries = 0;
  while (runs++ < 2000) {
    maxQueries = Math.max(maxQueries, await step(deps, db, scheduled));
    if ((await state())!.phase === 'done') return { runs, maxQueries };
  }
  throw new Error(`Nightly did not finish: ${JSON.stringify(await state())}`);
}
function interrupted(mode: 'before' | 'during' | 'after') {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (mode === 'before') throw new Error('invented before');
          if (mode === 'during')
            return target.batch([
              ...statements,
              target.prepare('INSERT INTO absent_nightly_test VALUES (1)'),
            ]);
          await target.batch(statements);
          throw new Error('invented lost reply');
        };
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  await freshDb();
  await updateSettings(db, { aiEnabled: false });
});

describe('resumable nightly work', () => {
  it('finishes 1,463 invented USD/INR transactions within the full scheduled invocation budget', async () => {
    const accounts = [
      await addAccount({ type: 'checking', balance: 98765 }),
      await addAccount({ type: 'savings', currency: 'INR', balance: 543210 }),
    ];
    const txns = Array.from({ length: 1463 }, (_, i) =>
      makeTransaction({
        id: `txn_${String(i).padStart(5, '0')}`,
        accountId: accounts[i % 2]!.id,
        amount: -123,
        currency: accounts[i % 2]!.currency,
        date: addDays('2024-11-01', Math.floor(i / 2)),
        rawName: 'SQ *INVENTED GROCER',
        categoryId: 'cat_groceries',
        categorySource: 'user',
        userEditedFields: ['categoryId'],
        notes: 'Invented preserved note',
        source: 'manual',
      }),
    );
    await runSpecs(db, bulkInsertSpecs(transactionsTable, txns));
    await addRate('2024-01-01', 'INR', 80);
    let runs = 0;
    let maxQueries = 0;
    const started = Date.now();
    let maxRead = 0;
    let maxWritten = 0;
    let totalRead = 0;
    let totalWritten = 0;
    while (runs++ < 2000) {
      const rows = measureRows(db);
      const meter = meterDb(rows.db);
      const worker = createWorker({ now, fetch: noFetch });
      const ctx = createExecutionContext();
      await worker.scheduled(
        { cron: NIGHTLY_CRON, scheduledTime: NOW.getTime(), noRetry() {} },
        { ...testEnv, DB: meter.db },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      maxQueries = Math.max(maxQueries, meter.used());
      maxRead = Math.max(maxRead, rows.read());
      maxWritten = Math.max(maxWritten, rows.written());
      totalRead += rows.read();
      totalWritten += rows.written();
      expect(meter.used()).toBeLessThanOrEqual(38);
      if ((await state())?.phase === 'done') break;
    }
    expect((await state())?.phase).toBe('done');
    const stored = await selectAll(db, transactionsTable, '', [], 'id');
    expect(stored).toHaveLength(1463);
    expect(await selectAll(db, accountsTable, '', [], 'id')).toEqual(
      [...accounts].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(stored.every((t) => t.merchantId && t.name === 'Invented Grocer')).toBe(true);
    const financial = ({
      id,
      amount,
      currency,
      accountId,
      date,
      notes,
      categoryId,
      userEditedFields,
    }: (typeof txns)[number]) => ({
      id,
      amount,
      currency,
      accountId,
      date,
      notes,
      categoryId,
      userEditedFields,
    });
    expect(stored.map(financial)).toEqual(txns.map(financial));
    expect(await db.prepare('SELECT count(*) AS n FROM merchants').first('n')).toBe(1);
    expect(await db.prepare('SELECT count(*) AS n FROM nightly_rows').first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) AS n FROM recaps').first('n')).toBe(2);
    console.warn('Invented nightly measurements', {
      maxRead,
      maxWritten,
      totalRead,
      totalWritten,
      runs,
      maxQueries,
      localMs: Date.now() - started,
    });
  }, 60_000);

  it('matches whole-period recap facts across pages, refunds, FX, transfers and balance snapshots', async () => {
    const account = await addAccount({ type: 'checking', balance: 123456 });
    for (let i = 0; i < 25; i++)
      await addTxn(account, {
        id: `t_${i.toString().padStart(3, '0')}`,
        date: i < 12 ? '2026-10-27' : '2026-10-20',
        amount: i === 11 ? 20000 : -1000,
        currency: i % 2 ? 'USD' : 'INR',
        categoryId: 'cat_groceries',
        categorySource: 'user',
        userEditedFields: ['categoryId', 'name'],
        name: 'My grocery',
        rawName: 'MY GROCER',
        kind: i === 2 ? 'transfer' : 'regular',
      });
    await addRate('2026-10-01', 'INR', 80);
    await addRate('2026-10-25', 'INR', 90);
    await updateSettings(db, { moneyPolicies: { categoryFloor: 'zero' } });
    await db
      .prepare('INSERT INTO balance_snapshots VALUES (?, ?, ?, ?)')
      .bind(account.id, '2026-10-20', 10000, 'USD')
      .run();
    await db
      .prepare('INSERT INTO balance_snapshots VALUES (?, ?, ?, ?)')
      .bind(account.id, '2026-10-30', 12000, 'USD')
      .run();
    const expected = await generateRecap(
      testEnv,
      'weekly',
      lastCompletePeriod('weekly', '2026-11-02', 0),
    );
    await setPhase('recap_week');
    await complete();
    const result = JSON.parse(
      (await db.prepare("SELECT data FROM recaps WHERE kind = 'weekly'").first<string>('data'))!,
    ) as Recap;
    for (const key of [
      'spending',
      'income',
      'previousSpending',
      'topCategories',
      'netWorthChange',
      'headline',
      'highlights',
    ] as const)
      expect(result[key]).toEqual(expected[key]);
  });

  it('detects recurring series and does not duplicate price alerts on replay', async () => {
    const account = await addAccount({ type: 'checking' });
    for (const [i, date] of ['2026-07-12', '2026-08-12', '2026-09-12', '2026-10-12'].entries())
      await addTxn(account, {
        amount: i === 3 ? -1799 : -1549,
        date,
        rawName: 'STREAMFLIX.COM 866-555',
      });
    await complete();
    const first = await db.prepare('SELECT * FROM recurring_items').first();
    expect(first).toMatchObject({ expected_amount: -1799, next_due_date: '2026-11-12' });
    await db
      .prepare("UPDATE recurring_items SET decision = 'keep' WHERE id = ?")
      .bind(first!.id)
      .run();
    await complete({}, new Date('2026-11-03T06:32:00Z'));
    expect(await db.prepare('SELECT count(*) AS n FROM recurring_items').first('n')).toBe(1);
    expect(await db.prepare('SELECT decision FROM recurring_items').first('decision')).toBe('keep');
    expect(
      await db.prepare("SELECT count(*) AS n FROM alerts WHERE type = 'price_increase'").first('n'),
    ).toBe(1);
  });

  it('finds duplicates across pages and the exact median after multiple history pages', async () => {
    const account = await addAccount({ type: 'checking' });
    for (let i = 0; i < 140; i++)
      await addTxn(account, {
        id: `h_${i.toString().padStart(3, '0')}`,
        amount: -1000 - i,
        date: '2026-08-01',
        rawName: 'GROCER',
      });
    await addTxn(account, { id: 'recent_1', amount: -5000, date: '2026-10-20', rawName: 'GROCER' });
    await addTxn(account, { id: 'recent_2', amount: -5000, date: '2026-10-21', rawName: 'GROCER' });
    await complete();
    const alerts = await db
      .prepare('SELECT type, transaction_id, message FROM alerts ORDER BY type, transaction_id')
      .all();
    expect(alerts.results).toHaveLength(3);
    expect(alerts.results[0]).toMatchObject({ type: 'duplicate', transaction_id: 'recent_2' });
    expect(String(alerts.results[1]!.message)).toContain('usual 10.70');
  });

  it.each(['before', 'during', 'after'] as const)(
    'resumes after an interruption %s the atomic result/checkpoint batch',
    async (mode) => {
      const account = await addAccount({ type: 'checking' });
      const t = await addTxn(account, { amount: -1200, date: '2026-10-28', rawName: 'SQ *GROCER' });
      await setPhase('merchants');
      await expect(step({}, interrupted(mode))).rejects.toThrow();
      expect((await state())!.after).toBe(mode === 'after' ? t.id : '');
      expect((await getTransaction(db, t.id))!.merchantId === null).toBe(mode !== 'after');
      await complete();
      expect((await getTransaction(db, t.id))!.name).toBe('Grocer');
      expect(await db.prepare('SELECT count(*) AS n FROM merchants').first('n')).toBe(1);
    },
  );

  it('serializes overlapping AI work and fences an expired worker after replacement', async () => {
    await updateSettings(db, { aiEnabled: true });
    const account = await addAccount({ type: 'checking' });
    const t = await addTxn(account, {
      amount: -1200,
      date: '2026-10-28',
      rawName: 'AMZN MKTP US*2K4',
    });
    await setPhase('merchants');
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pending = step({
      client: {
        provider: 'workers_ai',
        complete: async () => {
          entered();
          return new Promise<string>((r) => {
            release = r;
          });
        },
      },
    });
    await started;
    expect(await step()).toBe(1);
    await step({
      now: () => new Date(NOW.getTime() + LEASE_MS + 1),
      ...fakeAi({ merchants: { 'AMZN MKTP US*2K4': 'Fresh merchant' } }).deps,
    });
    release(JSON.stringify({ results: [{ raw: t.rawName, name: 'Stale merchant' }] }));
    await expect(pending).rejects.toThrow();
    expect((await getTransaction(db, t.id))!.name).toBe('Fresh merchant');
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM merchants WHERE name = 'Stale merchant'")
        .first('n'),
    ).toBe(0);
  });

  it('does not overwrite a user edit made while an AI call is in flight', async () => {
    await updateSettings(db, { aiEnabled: true });
    const account = await addAccount({ type: 'checking' });
    const t = await addTxn(account, {
      amount: -1200,
      date: '2026-10-28',
      rawName: 'AMZN MKTP US*2K4',
    });
    await setPhase('merchants');
    await expect(
      step({
        client: {
          provider: 'workers_ai',
          complete: async () => {
            await db
              .prepare(
                "UPDATE transactions SET name='My name', user_edited_fields='[\"name\"]' WHERE id=?",
              )
              .bind(t.id)
              .run();
            return JSON.stringify({ results: [{ raw: t.rawName, name: 'Amazon' }] });
          },
        },
      }),
    ).rejects.toThrow();
    expect((await getTransaction(db, t.id))!.name).toBe('My name');
    expect((await state())!.after).toBe('');
  });

  it('visits all category vocabulary pages and never overwrites user categories', async () => {
    await updateSettings(db, { aiEnabled: true });
    const template = (await selectAll(db, categoriesTable))[0]!;
    for (let i = 0; i < 130; i++)
      await insertStatement(db, categoriesTable, {
        ...template,
        id: `zzz_${i.toString().padStart(3, '0')}`,
        name: `Invented category ${i}`,
        kind: 'expense',
      }).run();
    const account = await addAccount({ type: 'checking' });
    const t = await addTxn(account, { amount: -1200, date: '2026-10-28', rawName: 'UNKNOWN' });
    const protectedTxn = await addTxn(account, {
      amount: -1200,
      date: '2026-10-28',
      rawName: 'UNKNOWN',
      categoryId: 'cat_gifts',
      categorySource: 'user',
      userEditedFields: ['categoryId'],
    });
    await setPhase('categorize');
    const ai = fakeAi({
      categorize: { [t.id]: { category: 'Invented category 129', confidence: 0.99 } },
    });
    await complete(ai.deps);
    expect((await getTransaction(db, t.id))!.categoryId).toBe('zzz_129');
    expect((await getTransaction(db, protectedTxn.id))!.categoryId).toBe('cat_gifts');
    expect(ai.calls.length).toBeGreaterThan(2);
  });

  it('counts Workers AI usage and bounds a worst-case merchant page with eight distinct names', async () => {
    await updateSettings(db, { aiEnabled: true });
    const account = await addAccount({ type: 'checking' });
    for (let i = 0; i < 8; i++)
      await addTxn(account, { amount: -1000, date: '2026-10-20', rawName: `AMZN MKTP US*X${i}` });
    await setPhase('merchants');
    const meter = meterDb(db);
    let calls = 0;
    await runNightlyStep(
      {
        ...testEnv,
        DB: meter.db,
        AI: {
          run: async () => {
            calls++;
            return { response: { results: [] } };
          },
        },
      },
      NOW,
      { now, fetch: noFetch },
    );
    expect(calls).toBe(1);
    expect(meter.used()).toBeLessThanOrEqual(27);
    expect(await db.prepare('SELECT calls FROM ai_usage').first('calls')).toBe(1);
    expect(await db.prepare('SELECT count(*) AS n FROM merchants').first('n')).toBe(8);
  });

  it('refuses an expired lease even when nobody has replaced it', async () => {
    const account = await addAccount({ type: 'checking' });
    const t = await addTxn(account, { amount: -1000, date: '2026-10-20', rawName: 'SQ *GROCER' });
    await setPhase('merchants');
    let ticks = 0;
    await expect(
      step({ now: () => new Date(NOW.getTime() + (ticks++ ? LEASE_MS : 0)) }),
    ).rejects.toThrow('expired');
    expect((await state())!.after).toBe('');
    expect((await getTransaction(db, t.id))!.merchantId).toBeNull();
    await step();
    expect((await getTransaction(db, t.id))!.merchantId).not.toBeNull();
  });

  it('does not accept a recurring prefix of an oversized irregular group', async () => {
    const account = await addAccount({ type: 'checking' });
    const txns = Array.from({ length: 220 }, (_, i) =>
      makeTransaction({
        accountId: account.id,
        currency: 'USD',
        amount: -1000,
        source: 'manual',
        rawName: 'GROCER',
        date: i < 3 ? addDays('2026-01-01', i * 7) : '2026-10-20',
      }),
    );
    await runSpecs(db, bulkInsertSpecs(transactionsTable, txns));
    await setPhase('index');
    await complete();
    expect(await db.prepare('SELECT count(*) AS n FROM recurring_items').first('n')).toBe(0);
  });

  it('replays recap accumulation without double-counting after a lost response', async () => {
    const account = await addAccount({ type: 'checking' });
    for (let i = 0; i < 20; i++)
      await addTxn(account, {
        id: `txn_${i.toString().padStart(2, '0')}`,
        amount: -1000,
        date: '2026-10-28',
        categoryId: 'cat_groceries',
      });
    await setPhase('recap_week');
    await expect(step({}, interrupted('after'))).rejects.toThrow();
    expect((await state())!.recap!.after).toBe('txn_07');
    await complete();
    const recap = JSON.parse(
      (await db.prepare("SELECT data FROM recaps WHERE kind='weekly'").first<string>('data'))!,
    ) as Recap;
    expect(recap.spending).toBe(20000);
  });

  it('uses index seeks for work pages and FX lookups', async () => {
    const queries = [
      "SELECT * FROM transactions WHERE id > '' AND merchant_id IS NULL AND is_split_parent = 0 ORDER BY id LIMIT 8",
      "SELECT amount,id FROM nightly_rows WHERE alert_key='x' AND history=1 AND (amount,id) > (1,'') ORDER BY amount,id LIMIT 32",
      "SELECT data FROM nightly_rows WHERE alert_key='x' AND recent=1 AND id > '' ORDER BY id LIMIT 4",
      "SELECT data FROM nightly_rows WHERE recurring_key='x' AND recurring_usable=1 ORDER BY date,id LIMIT 216",
      "SELECT rowid FROM fx_rates WHERE base='USD' AND quote='INR' AND date <= '2026-11-01' ORDER BY date DESC,as_of DESC LIMIT 1",
    ];
    for (const sql of queries) {
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
      expect(
        plan.results.some((r) => r.detail.includes('SEARCH') && r.detail.includes('INDEX')),
      ).toBe(true);
      expect(plan.results.some((r) => r.detail.includes('TEMP B-TREE'))).toBe(false);
    }
  });

  it('does not count a transaction twice when its date moves ahead of an in-progress recap', async () => {
    const account = await addAccount({ type: 'checking' });
    for (let i = 0; i < 20; i++)
      await addTxn(account, {
        id: `txn_${i.toString().padStart(2, '0')}`,
        amount: -1000,
        date: '2026-10-26',
        categoryId: 'cat_groceries',
      });
    await setPhase('recap_week');
    await step();
    await db.prepare("UPDATE transactions SET date = '2026-10-30' WHERE id = 'txn_00'").run();
    await complete();
    const recap = JSON.parse(
      (await db.prepare("SELECT data FROM recaps WHERE kind='weekly'").first<string>('data'))!,
    ) as Recap;
    expect(recap.spending).toBe(20000);
  });

  it('catches up every missed recap period after a long pause', async () => {
    await setPhase('recap_week');
    await db
      .prepare(
        `UPDATE nightly_state SET state = json_set(state, '$.weeklyEnd', '2026-10-03', '$.monthlyEnd', '2026-08-31')`,
      )
      .run();
    await complete();
    const weekly = await db
      .prepare("SELECT period_start FROM recaps WHERE kind='weekly' ORDER BY period_start")
      .all<{ period_start: string }>();
    expect(weekly.results.map((r) => r.period_start)).toEqual([
      '2026-10-04',
      '2026-10-11',
      '2026-10-18',
      '2026-10-25',
    ]);
    const monthly = await db
      .prepare("SELECT period_start FROM recaps WHERE kind='monthly' ORDER BY period_start")
      .all<{ period_start: string }>();
    expect(monthly.results.map((r) => r.period_start)).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('keeps distinct provider charges separate while detecting a pending/posted pair in a large group', async () => {
    const account = await addAccount({ type: 'checking' });
    const txns = Array.from({ length: 220 }, (_, i) =>
      makeTransaction({
        id: `provider_${i.toString().padStart(3, '0')}`,
        externalId: `ext_${i}`,
        pendingExternalId: i === 219 ? 'ext_218' : null,
        accountId: account.id,
        currency: 'USD',
        amount: -1000,
        source: 'connector',
        rawName: 'GROCER',
        date: '2026-10-28',
      }),
    );
    await runSpecs(db, bulkInsertSpecs(transactionsTable, txns));
    await setPhase('index');
    await complete();
    const alerts = await db
      .prepare("SELECT transaction_id FROM alerts WHERE type='duplicate'")
      .all<{ transaction_id: string }>();
    expect(alerts.results).toEqual([{ transaction_id: 'provider_219' }]);
  });

  it('keeps the original day and recap period while continuation crosses midnight', async () => {
    await setPhase('recap_week');
    await step();
    const period = (await state())!.recap!.range;
    await step({}, db, new Date('2026-12-01T06:32:00Z'));
    expect((await state())!.day).toBe('2026-11-02');
    expect((await state())!.recap!.range).toEqual(period);
  });
});

describe('bounded scheduled latest FX', () => {
  it('stores supported latest rates when a default or discovered quote is unsupported', async () => {
    const f = (async (input: RequestInfo | URL) => {
      // Invented provider contract: a symbols filter containing AED rejects the whole request.
      if (new URL(String(input)).searchParams.get('symbols')?.includes('AED'))
        return new Response('{}', { status: 404 });
      return Response.json({
        amount: 1,
        base: 'USD',
        date: '2026-11-01',
        rates: { INR: 80, EUR: 0.9 },
      });
    }) as typeof fetch;
    expect(await fetchScheduledLatest(testEnv, 'frankfurter_ecb', f)).toBe(2);
    expect(await db.prepare("SELECT rate FROM fx_rates WHERE quote='INR'").first('rate')).toBe(80);
    expect(
      await db.prepare("SELECT count(*) AS n FROM fx_rates WHERE quote='AED'").first('n'),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT last_quote FROM fx_latest_progress WHERE source='frankfurter_ecb'")
        .first('last_quote'),
    ).toBe('AED');
  });

  it('discovers currencies cyclically, bounds request/write sizes and rejects oversized responses', async () => {
    const template = await addAccount({ type: 'checking' });
    const accounts = Array.from({ length: 1000 }, (_, i) => ({
      ...template,
      id: `a_${i}`,
      currency: `X${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${String.fromCharCode(65 + (i % 26))}`,
    }));
    await runSpecs(db, bulkInsertSpecs(accountsTable, accounts));
    let count = 0;
    const f = (async (input: RequestInfo | URL) => {
      count++;
      expect(new URL(String(input)).searchParams.has('symbols')).toBe(false);
      return Response.json({
        amount: 1,
        base: 'USD',
        date: '2026-11-01',
        rates: Object.fromEntries(
          [...DEFAULT_FX_QUOTES, ...accounts.map((a) => a.currency)].map((q) => [q, 1]),
        ),
      });
    }) as typeof fetch;
    for (let i = 0; i < 13; i++) {
      const meter = meterDb(db);
      expect(
        await fetchScheduledLatest({ ...testEnv, DB: meter.db }, 'frankfurter_ecb', f),
      ).toBeLessThanOrEqual(10);
      expect(meter.used()).toBeLessThanOrEqual(5);
    }
    expect(count).toBe(13);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM fx_rates WHERE quote LIKE 'X%'")
        .first<number>('n'),
    ).toBeGreaterThan(1);
    await expect(
      fetchScheduledLatest(
        testEnv,
        'frankfurter_ecb',
        (async () => new Response('x'.repeat(40000))) as typeof fetch,
      ),
    ).rejects.toThrow('too large');
  });
});
