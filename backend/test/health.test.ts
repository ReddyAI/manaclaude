import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/index';

describe('worker', () => {
  it('answers /health', async () => {
    const res = await handleRequest(new Request('https://api.example/health'), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; policies: { cardPayments: string } };
    expect(body.ok).toBe(true);
    expect(body.policies.cardPayments).toBe('exclude');
  });

  it('returns 404 for unknown paths', async () => {
    const res = await handleRequest(new Request('https://api.example/nope'), {});
    expect(res.status).toBe(404);
  });
});
