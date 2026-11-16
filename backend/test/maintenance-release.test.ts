import { afterEach, describe, expect, it } from 'vitest';
import { createExecutionContext } from 'cloudflare:test';
import { coordinator, tracked } from '../src/maintenance';
import { testEnv } from './helpers';

const change = async (action: 'off' | 'activate', env = testEnv, release?: string) => {
  const current = (await (await coordinator(env, 'status')).json()) as { generation: number };
  return coordinator(env, action, {
    generation: current.generation,
    ...(release ? { release } : {}),
  });
};
const off = (env = testEnv) => change('off', env);
const activate = (release: string) => change('activate', testEnv, release);
afterEach(async () => {
  await coordinator(testEnv, 'on');
  await activate(testEnv.RELEASE_COMMIT!);
  await off();
});

describe('maintenance release fencing', () => {
  it('cannot attach a completed backup to a different maintenance generation', async () => {
    await coordinator(testEnv, 'on');
    const before = (await (await coordinator(testEnv, 'status')).json()) as { generation: number };
    await coordinator(testEnv, 'on');
    expect(
      (
        await coordinator(testEnv, 'proof', {
          proof: 'a'.repeat(64),
          generation: before.generation,
        })
      ).status,
    ).toBe(503);
    expect((await coordinator(testEnv, 'off', { generation: before.generation })).status).toBe(503);
    const after = (await (await coordinator(testEnv, 'status')).json()) as { generation: number };
    expect(
      (await coordinator(testEnv, 'proof', { proof: 'a'.repeat(64), generation: after.generation }))
        .ok,
    ).toBe(true);
  });
  it('refuses an old Worker after the new release resumes, including propagation lag', async () => {
    await coordinator(testEnv, 'on');
    const next = { ...testEnv, RELEASE_COMMIT: 'b'.repeat(40) };
    expect((await activate(next.RELEASE_COMMIT)).ok).toBe(true);
    expect((await off()).status).toBe(503);
    expect((await off(next)).ok).toBe(true);
    let writes = 0;
    const old = await tracked(testEnv, createExecutionContext(), async () => {
      writes++;
      return new Response('old');
    });
    expect((old as Response).status).toBe(503);
    const current = await tracked(next, createExecutionContext(), async () => {
      writes++;
      return new Response('current');
    });
    expect((current as Response).status).toBe(200);
    expect(writes).toBe(1);
  });
  it('cannot change the allowed version while any admitted writer is still live', async () => {
    await off();
    expect(
      (await coordinator(testEnv, 'admit', { token: 'invented-live-release-writer' })).ok,
    ).toBe(true);
    await coordinator(testEnv, 'on');
    try {
      expect((await activate('b'.repeat(40))).status).toBe(503);
    } finally {
      await coordinator(testEnv, 'finish', { token: 'invented-live-release-writer' });
    }
  });
});
