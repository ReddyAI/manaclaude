import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { coordinator, readRequest, tracked } from '../src/maintenance';
import { createWorker } from '../src/worker';
import { client } from './worker';
import { freshDb, testEnv, db, addAccount } from './helpers';
import { previewImport } from '../src/imports/service';

const operatorEnv = {
  ...testEnv,
  RECOVERY_OPERATOR_TOKEN: 'invented-operator-token',
  RELEASE_COMMIT: 'a'.repeat(40),
};
const status = async () =>
  (await (await coordinator(testEnv, 'status')).json()) as {
    on: boolean;
    active: number;
    drained: boolean;
    generation: number;
  };
const off = async () => {
  const current = (await (await coordinator(testEnv, 'status')).json()) as { generation: number };
  return coordinator(testEnv, 'off', { generation: current.generation });
};
beforeEach(async () => {
  await freshDb();
  await off();
});

describe('maintenance admission and drain', () => {
  it('refuses every mutation verb, GET callbacks/polling and OAuth mutations before provider work', async () => {
    await coordinator(testEnv, 'on');
    const network = vi.fn();
    const c = client({ fetch: network }, operatorEnv);
    for (const [method, path] of [
      ['POST', '/v1/imports'],
      ['POST', '/v1/connections/unknown/sync'],
      ['PATCH', '/v1/settings'],
      ['PUT', '/v1/history-policy'],
      ['DELETE', '/v1/accounts/unknown'],
      ['POST', '/register'],
      ['POST', '/token'],
      ['GET', '/authorize'],
      ['GET', '/v1/link/sophtron/unknown'],
      ['GET', '/v1/link/snaptrade/callback'],
      ['GET', '/v1/link/zerodha_kite/callback'],
      ['POST', '/mcp'],
    ]) {
      const response = await c.raw(path!, { method });
      expect(response.status, method + ' ' + path).toBe(503);
      if (path!.startsWith('/v1/'))
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.json()).toMatchObject({ error: 'maintenance' });
    }
    expect(network).not.toHaveBeenCalled();
    expect((await status()).active).toBe(0);
    await off();
    expect((await c.api('PATCH', '/v1/settings', { aiEnabled: false })).status).toBe(200);
  });
  it('keeps authenticated originals and reads available without seeding or changing D1', async () => {
    const account = await addAccount({ type: 'checking' });
    const bytes = new TextEncoder().encode('Date,Description,Amount\n2026-11-01,Invented,-1.00\n');
    const imported = await previewImport(testEnv, {
      bytes,
      fileName: 'invented.csv',
      contentType: 'text/csv',
      accountId: account.id,
    });
    await db.prepare('DELETE FROM categories').run();
    await coordinator(testEnv, 'on');
    const c = client({}, operatorEnv);
    for (const path of ['/health', '/v1/accounts', '/v1/dataset', '/v1/categories', '/v1/settings'])
      expect((await c.api('GET', path)).status).toBe(200);
    const original = await c.raw(`/v1/vault/${imported.importId}/file`, {
      headers: { authorization: 'Bearer test-app-token' },
    });
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(bytes);
    expect((await c.raw(`/v1/vault/${imported.importId}/file`)).status).toBe(401);
    expect(await db.prepare('SELECT count(*) AS n FROM categories').first('n')).toBe(0);
    await off();
    expect((await c.api('GET', '/v1/categories')).status).toBe(200);
    expect(await db.prepare('SELECT count(*) AS n FROM categories').first('n')).toBeGreaterThan(0);
  });
  it('makes every cron exit without a query, provider call or job state change', async () => {
    await coordinator(testEnv, 'on');
    const network = vi.fn();
    const worker = createWorker({ fetch: network });
    for (const cron of ['*/5 * * * *', '0 * * * *', '30 6 * * *', '2-57/5 * * * *']) {
      const ctx = createExecutionContext();
      await worker.scheduled(
        { cron, scheduledTime: Date.now() } as ScheduledController,
        operatorEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
    }
    expect(network).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT count(*) AS n FROM nightly_state').first('n')).toBe(0);
    expect((await status()).active).toBe(0);
  });
  it('waits for admitted work and nested waitUntil tasks and refuses new writers atomically', async () => {
    const ctx = createExecutionContext();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    await tracked(testEnv, ctx, async (wrapped) => {
      wrapped.waitUntil(
        pending.then(() => {
          wrapped.waitUntil(
            db.prepare("INSERT INTO settings VALUES ('invented-background','done')").run(),
          );
        }),
      );
      return new Response('accepted');
    });
    await coordinator(testEnv, 'on');
    expect(await status()).toMatchObject({ on: true, active: 1, drained: false });
    const newWork = vi.fn();
    expect(((await tracked(testEnv, createExecutionContext(), newWork)) as Response).status).toBe(
      503,
    );
    expect(newWork).not.toHaveBeenCalled();
    expect((await off()).status).toBe(503);
    resolve();
    await waitOnExecutionContext(ctx);
    expect(await status()).toMatchObject({ active: 0, drained: true });
    expect(
      await db.prepare("SELECT value FROM settings WHERE key='invented-background'").first('value'),
    ).toBe('done');
  });
  it('never expires a crashed writer or accepts a proof/resume before drain', async () => {
    await coordinator(testEnv, 'admit', { token: 'invented-crashed-writer' });
    await coordinator(testEnv, 'on');
    expect(
      (
        await coordinator(testEnv, 'proof', {
          proof: 'a'.repeat(64),
          generation: (await status()).generation,
        })
      ).status,
    ).toBe(503);
    expect((await off()).status).toBe(503);
    expect((await status()).drained).toBe(false);
    // Internal test cleanup only; there is intentionally no public force-release route.
    await coordinator(testEnv, 'finish', { token: 'invented-crashed-writer' });
  });
  it('authenticates operator reads, requires drain for object access, and distinguishes MCP read tools', async () => {
    const c = client({}, operatorEnv);
    expect((await c.raw('/__recovery/status')).status).toBe(401);
    expect(
      (
        await c.raw('/__recovery/objects', {
          headers: { authorization: 'Bearer invented-operator-token' },
        })
      ).status,
    ).toBe(503);
    await coordinator(testEnv, 'on');
    await testEnv.FILES.put('invented-unreferenced', 'extra', {
      httpMetadata: { contentType: 'text/plain' },
    });
    const objects = await c.raw('/__recovery/objects', {
      method: 'POST',
      body: '{}',
      headers: { authorization: 'Bearer invented-operator-token' },
    });
    expect(
      ((await objects.json()) as { objects: { key: string }[] }).objects.some(
        (o) => o.key === 'invented-unreferenced',
      ),
    ).toBe(true);
    for (const name of ['list_accounts', 'search_transactions'])
      expect(
        await readRequest(
          new Request('https://mana.test/mcp', {
            method: 'POST',
            body: JSON.stringify({ method: 'tools/call', params: { name } }),
          }),
        ),
      ).toBe(true);
    expect(
      await readRequest(
        new Request('https://mana.test/mcp', {
          method: 'POST',
          body: JSON.stringify({ method: 'tools/call', params: { name: 'add_cash_transaction' } }),
        }),
      ),
    ).toBe(false);
  });
});
