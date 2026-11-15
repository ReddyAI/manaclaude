import { beforeEach, describe, expect, it } from 'vitest';
import { bankOwns, monthEnd, normalizePolicy, sourcePeriods } from '../src/history/model';
import { getHistoryPolicy, previewHistoryPolicy, saveHistoryPolicy } from '../src/history/service';
import { readPolicy } from '../src/history/store';
import { commitImport, getImport, previewImport, undoImport } from '../src/imports/service';
import { addAccount, addTxn, allTxns, db, freshDb, testEnv } from './helpers';
import { client } from './worker';
import { NOW, activate, bank, beforeBatch, historyFile, policy } from './history-fixtures';
beforeEach(freshDb);
describe('policy calendar and authenticated contract', () => {
  it.each([
    ['2024-02', '2024-02-29'],
    ['2023-02', '2023-02-28'],
    ['2024-12', '2024-12-31'],
  ])('ends %s on %s', (m, last) => expect(monthEnd(m)).toBe(last));
  it('uses strict cutoff and whole leap months with account exceptions and independent cash', async () => {
    const a = await bank(),
      b = await bank('Elm'),
      cash = await addAccount({ type: 'cash' });
    const p = normalizePolicy(
      {
        ...policy,
        accounts: [
          { accountId: a.id, mode: 'default', replacementMonths: ['2024-02'] },
          { accountId: b.id, mode: 'custom', cutoff: '2024-06-01', replacementMonths: [] },
        ],
      },
      [a, b, cash],
    );
    expect(
      ['2024-01-31', '2024-02-01', '2024-02-29', '2024-03-01', '2024-04-14', '2024-04-15'].map(
        (d) => bankOwns(p, a, d),
      ),
    ).toEqual([false, true, true, false, false, true]);
    expect(bankOwns(p, b, '2024-04-15')).toBe(false);
    expect(bankOwns(p, cash, '2024-06-01')).toBeNull();
    expect(sourcePeriods(p, a)).toEqual([
      { source: 'monefy', from: null, to: '2024-01-31' },
      { source: 'bank', from: '2024-02-01', to: '2024-02-29' },
      { source: 'monefy', from: '2024-03-01', to: '2024-04-14' },
      { source: 'bank', from: '2024-04-15', to: null },
    ]);
  });
  it('authenticates all new routes', async () => {
    for (const [method, path] of [
      ['GET', '/v1/history-policy'],
      ['POST', '/v1/history-policy/preview'],
      ['PUT', '/v1/history-policy'],
      ['GET', '/v1/history-policy/bank-reviews'],
      ['POST', '/v1/history-policy/bank-reviews/unknown'],
      ['GET', '/v1/history-policy/bank-reviews/unknown'],
    ])
      expect(
        (await client().api(method!, path!, method === 'GET' ? undefined : {}, null)).status,
      ).toBe(401);
  });
  it('previews without activation and deliberately saves with lost-response replay', async () => {
    await bank();
    const api = client({ now: () => new Date(NOW) }).api;
    const p = await api<Awaited<ReturnType<typeof previewHistoryPolicy>>>(
      'POST',
      '/v1/history-policy/preview',
      { policy },
    );
    expect(p.status).toBe(200);
    expect(p.body).not.toHaveProperty('snapshot');
    expect((await readPolicy(db)).version).toBe(0);
    const input = {
      policy,
      expectedVersion: p.body.expectedVersion,
      previewToken: p.body.previewToken,
    };
    expect((await api('PUT', '/v1/history-policy', input)).body).toMatchObject({
      version: 1,
      replayed: false,
    });
    expect((await api('PUT', '/v1/history-policy', input)).body).toMatchObject({
      version: 1,
      replayed: true,
    });
    expect((await api('GET', '/v1/history-policy')).body).toMatchObject({
      version: 1,
      policy,
      accounts: [{ coverage: { status: 'unavailable', complete: false } }],
    });
  });
  it.each(['2024-02-30', '2024-13-01', '04/15/2024'])(
    'rejects invalid cutoff %s',
    async (defaultCutoff) => {
      expect(
        (
          await client().api('POST', '/v1/history-policy/preview', {
            policy: { ...policy, defaultCutoff },
          })
        ).status,
      ).toBe(400);
    },
  );
  it('rejects overlapping/duplicate months, duplicate configurations, unsupported and unknown accounts', async () => {
    const a = await bank(),
      cash = await addAccount({ type: 'cash' });
    for (const accounts of [
      [{ accountId: a.id, mode: 'default', replacementMonths: ['2024-04'] }],
      [{ accountId: a.id, mode: 'default', replacementMonths: ['2024-02', '2024-02'] }],
      [{ accountId: cash.id, mode: 'monefy_only' }],
      [{ accountId: 'missing', mode: 'monefy_only' }],
      [
        { accountId: a.id, mode: 'monefy_only' },
        { accountId: a.id, mode: 'monefy_only' },
      ],
    ])
      expect(
        (
          await client().api('POST', '/v1/history-policy/preview', {
            policy: { ...policy, accounts },
          })
        ).status,
      ).toBe(400);
  });
  it('refuses existing-data transition with transaction/import IDs without deleting or hiding', async () => {
    const a = await bank();
    const m = await addTxn(a, {
      date: '2024-05-01',
      amount: -900,
      source: 'import',
      externalId: 'monefy:fixture',
      importId: 'imp_old',
    });
    const b = await addTxn(a, {
      date: '2024-01-01',
      amount: -500,
      source: 'connector',
      externalId: 'bank-old',
    });
    const p = await previewHistoryPolicy(db, policy);
    expect(p.allowed).toBe(false);
    expect(p.conflicts.map((c) => c.transactionId).sort()).toEqual([m.id, b.id].sort());
    await expect(
      saveHistoryPolicy(db, { policy, expectedVersion: 0, previewToken: p.previewToken }, NOW),
    ).rejects.toMatchObject({ code: 'history_transition_conflict' });
    expect(await allTxns()).toHaveLength(2);
    expect((await readPolicy(db)).version).toBe(0);
    expect((await allTxns()).every((t) => !t.excluded)).toBe(true);
  });
  it('fences transaction writes racing activation and simultaneous policy saves', async () => {
    const a = await bank();
    const p = await previewHistoryPolicy(db, policy);
    const input = { policy, expectedVersion: 0, previewToken: p.previewToken };
    await expect(
      saveHistoryPolicy(
        beforeBatch(() =>
          addTxn(a, {
            date: '2024-04-20',
            amount: -500,
            source: 'import',
            externalId: 'monefy:race',
          }),
        ),
        input,
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
    expect((await readPolicy(db)).version).toBe(0);
    await db.prepare('DELETE FROM transactions').run();
    const p2 = await previewHistoryPolicy(db, policy);
    const request = { ...input, previewToken: p2.previewToken };
    const answers = await Promise.allSettled([
      saveHistoryPolicy(db, request, NOW),
      saveHistoryPolicy(db, request, NOW),
    ]);
    expect(answers.some((a) => a.status === 'fulfilled')).toBe(true);
    expect((await readPolicy(db)).version).toBe(1);
    await expect(
      saveHistoryPolicy(
        db,
        { ...request, policy: { ...policy, defaultCutoff: '2024-06-01' } },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'history_policy_changed' });
  });
  it('reports existing boundary candidates and never infers month completeness', async () => {
    const a = await bank();
    await addTxn(a, {
      date: '2024-04-14',
      amount: -500,
      source: 'import',
      externalId: 'monefy:one',
    });
    await addTxn(a, { date: '2024-04-15', amount: -500, source: 'connector', externalId: 'bank' });
    const p = await previewHistoryPolicy(db, policy);
    expect(p.allowed).toBe(false);
    expect(p.boundaryCandidates).toHaveLength(1);
    expect(p.accounts[0]?.coverage.complete).toBe(false);
    expect((await getHistoryPolicy(db)).policy.accounts).toEqual([]);
  });
});
describe('complete Monefy exports', () => {
  it('replaces partial months wholly, keeps cash, repeated purchases, repeat imports and undo', async () => {
    const a = await bank(),
      cash = await addAccount({ type: 'cash', name: 'Pocket' });
    await activate({
      ...policy,
      accounts: [{ accountId: a.id, mode: 'default', replacementMonths: ['2024-02'] }],
    });
    const input = {
      ...historyFile([
        '01-31-24,Orchard,Books,-5,USD,-5,USD,One',
        '02-01-24,Orchard,Books,-6,USD,-6,USD,Scattered one',
        '02-29-24,Orchard,Books,-7,USD,-7,USD,Scattered two',
        '04-14-24,Orchard,Books,-8,USD,-8,USD,Last Monefy day',
        '04-14-24,Orchard,Books,-8,USD,-8,USD,Last Monefy day',
        '04-15-24,Orchard,Books,-9,USD,-9,USD,First bank day',
        '05-01-24,Pocket,Books,-10,USD,-10,USD,Cash stays',
      ]),
      preferDayFirst: false,
      accountMappings: { Orchard: a.id, Pocket: cash.id },
    };
    const p = await previewImport(testEnv, input);
    expect(p.rows).toHaveLength(4);
    expect(p.historyPolicy).toMatchObject({
      excludedCount: 3,
      excludedTotals: [{ count: 3, outflow: 2200, inflow: 0 }],
    });
    expect(p.errors).toEqual([]);
    expect(await commitImport(testEnv, p.importId)).toMatchObject({
      added: 4,
      skipped: 3,
      policyExcluded: 3,
    });
    const rec = await getImport(db, p.importId);
    expect(await (await testEnv.FILES.get(rec.r2Key))!.text()).toBe(
      new TextDecoder().decode(input.bytes),
    );
    const again = await previewImport(testEnv, input);
    expect(again.counts.alreadyImported).toBe(4);
    expect((await commitImport(testEnv, again.importId)).added).toBe(0);
    expect(await undoImport(db, p.importId)).toBe(4);
    expect(await undoImport(db, p.importId)).toBe(0);
    const fresh = await previewImport(testEnv, input);
    expect((await commitImport(testEnv, fresh.importId)).added).toBe(4);
  });
  it('requires explicit error acknowledgement even when every readable row is excluded', async () => {
    const a = await bank();
    await activate();
    const p = await previewImport(testEnv, {
      ...historyFile([
        '05-01-24,Orchard,Books,-5,USD,-5,USD,Excluded',
        '05-02-24,Orchard,Transfer,-5,USD,-5,USD,Unsupported',
        'broken,Orchard,Books,-5,USD,-5,USD,Bad',
      ]),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    });
    expect(p.historyPolicy?.excludedCount).toBe(1);
    expect(p.errors).toHaveLength(2);
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_parse_errors',
    });
    expect(
      await commitImport(testEnv, p.importId, { skipLines: p.errors.map((e) => e.line) }),
    ).toMatchObject({ added: 0, skipped: 3, policyExcluded: 1 });
  });
  it('does not silently attach matching Monefy labels to connected accounts', async () => {
    const a = await bank();
    await activate();
    const p = await previewImport(testEnv, {
      ...historyFile(['05-01-24,Orchard,Books,-5,USD,-5,USD,History']),
      preferDayFirst: false,
    });
    expect(p.rows[0]?.accountId).toBeNull();
    const saved = await commitImport(testEnv, p.importId);
    expect(saved.accountsCreated).not.toContain(a.id);
    expect((await allTxns())[0]?.accountId).not.toBe(a.id);
  });
  it('rejects stale previews and policy activation inside a commit batch', async () => {
    const a = await bank();
    const input = {
      ...historyFile(['04-14-24,Orchard,Books,-5,USD,-5,USD,History']),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    };
    const old = await previewImport(testEnv, input);
    await activate();
    await expect(commitImport(testEnv, old.importId)).rejects.toMatchObject({
      code: 'history_policy_changed',
    });
    const p = await previewImport(testEnv, input);
    const raced = beforeBatch(() => activate({ ...policy, defaultCutoff: '2024-04-01' }));
    await expect(commitImport({ ...testEnv, DB: raced }, p.importId)).rejects.toMatchObject({
      code: 'history_policy_changed',
    });
    expect(await allTxns()).toEqual([]);
    expect((await getImport(db, p.importId)).status).toBe('preview');
  });
});

describe('policy review and import race regressions', () => {
  it('records deliberate import-side boundary decisions and rejects new stale candidates', async () => {
    const a = await bank();
    await activate();
    const b = await addTxn(a, {
      date: '2024-04-15',
      amount: -500,
      source: 'connector',
      externalId: 'bank-posting',
    });
    const input = {
      ...historyFile(['04-14-24,Orchard,Books,-5,USD,-5,USD,Purchase']),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    };
    const p = await previewImport(testEnv, input);
    expect(p.duplicateCandidates?.[0]?.transactionIds).toEqual([b.id]);
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_duplicates_require_review',
    });
    await commitImport(testEnv, p.importId, { keepLines: [2] });
    expect((await previewHistoryPolicy(db, policy)).allowed).toBe(true);
    await undoImport(db, p.importId);
    const stale = await previewImport(testEnv, input);
    await addTxn(a, {
      date: '2024-04-16',
      amount: -500,
      source: 'connector',
      externalId: 'another-bank-posting',
    });
    await expect(commitImport(testEnv, stale.importId, { keepLines: [2] })).rejects.toMatchObject({
      code: 'import_preview_changed',
    });
  });
  it('keeps mixed-currency rows as explicit errors even in bank-owned months', async () => {
    const a = await bank();
    await activate();
    const p = await previewImport(testEnv, {
      ...historyFile([
        '05-01-24,Orchard,Books,-5,USD,-5,USD,One',
        '05-02-24,Orchard,Books,-50,INR,-1,USD,Other currency',
      ]),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    });
    expect(p.errors.length).toBeGreaterThan(0);
    await expect(commitImport(testEnv, p.importId)).rejects.toMatchObject({
      code: 'import_parse_errors',
    });
  });
  it('keeps all Monefy-only and unconnected history independently importable', async () => {
    const a = await bank(),
      manual = await addAccount({ type: 'savings', name: 'Independent' });
    await activate({ ...policy, accounts: [{ accountId: a.id, mode: 'monefy_only' }] });
    const p = await previewImport(testEnv, {
      ...historyFile([
        '05-01-24,Orchard,Books,-5,USD,-5,USD,One',
        '05-02-24,Independent,Books,-6,USD,-6,USD,Other',
      ]),
      accountMappings: { Orchard: a.id, Independent: manual.id },
      preferDayFirst: false,
    });
    expect(p.historyPolicy?.excludedCount).toBe(0);
    expect((await commitImport(testEnv, p.importId)).added).toBe(2);
  });
  it('can safely replace an imported month by refusing first, undoing, and previewing the unchanged original', async () => {
    const a = await bank();
    const input = {
      ...historyFile([
        '02-10-24,Orchard,Books,-5,USD,-5,USD,Scattered',
        '03-10-24,Orchard,Books,-6,USD,-6,USD,Keep',
      ]),
      accountMappings: { Orchard: a.id },
      preferDayFirst: false,
    };
    const old = await previewImport(testEnv, input);
    await commitImport(testEnv, old.importId);
    const wanted = {
      ...policy,
      accounts: [{ accountId: a.id, mode: 'default' as const, replacementMonths: ['2024-02'] }],
    };
    expect((await previewHistoryPolicy(db, wanted)).allowed).toBe(false);
    await undoImport(db, old.importId);
    await activate(wanted);
    const next = await previewImport(testEnv, input);
    expect((await commitImport(testEnv, next.importId)).added).toBe(1);
    expect((await allTxns())[0]?.date).toBe('2024-03-10');
  });
});
