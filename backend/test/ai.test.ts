import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import categorizeReply from './fixtures/ai/workers-ai-categorize.json';
import toMarkdownReply from './fixtures/ai/workers-ai-tomarkdown.json';
import statementJson from './fixtures/ai/statement-nre.json';
import anthropicMessage from './fixtures/ai/anthropic-message.json';
import openaiChat from './fixtures/ai/openai-chat.json';
import type { AiBinding, Env } from '../src/env';
import { AiDisabledError, AiUnavailableError, getAi } from '../src/ai/provider';
import { runCategorization } from '../src/ai/jobs/categorize';
import { runDailyJobs } from '../src/ai/jobs';
import { uploadReceipt } from '../src/receipts/service';
import { previewImport } from '../src/imports/service';
import { getSettings, updateSettings } from '../src/services/settings';
import { getTransaction } from '../src/services/transactions';
import { addAccount, addTxn, db, file, freshDb, testEnv } from './helpers';
import { client } from './worker';

beforeEach(freshDb);

/** Fake Workers AI binding: answers run() and toMarkdown() from saved responses, records calls. */
function fakeBinding(reply: (model: string, inputs: Record<string, unknown>) => unknown) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  const binding: AiBinding = {
    async run(model, inputs) {
      calls.push({ model, inputs });
      return reply(model, inputs);
    },
    async toMarkdown() {
      calls.push({ model: 'toMarkdown', inputs: {} });
      return toMarkdownReply;
    },
  };
  return { binding, calls };
}

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0,
]) as Uint8Array<ArrayBuffer>;

describe('the AI switch', () => {
  it('aiEnabled=false stops every AI call: jobs, receipts, PDF imports and questions', async () => {
    const { binding, calls } = fakeBinding(() => ({ response: '{}' }));
    const env: Env = { ...testEnv, AI: binding, ANTHROPIC_API_KEY: 'sk-test' };
    await updateSettings(db, { aiEnabled: false });
    expect(() => getAi(env, { ...DEFAULT_SETTINGS, aiEnabled: false })).toThrow(AiDisabledError);
    const checking = await addAccount({ type: 'checking' });
    await addTxn(checking, { date: '2026-11-01', amount: -575, rawName: 'STARBUCKS STORE 04412' });
    const results = await runDailyJobs(env, '2026-11-01');
    expect(results.every((r) => !r.usedAi)).toBe(true);
    const receipt = await uploadReceipt(env, { bytes: PNG, contentType: 'image/png' });
    expect(receipt.receipt.status).toBe('uploaded');
    await expect(
      previewImport(env, {
        ...file('%PDF-1.4', 'statement.pdf'),
        format: 'pdf',
        accountId: checking.id,
      }),
    ).rejects.toMatchObject({ code: 'ai_disabled' });
    const ask = await client({}, env).api('POST', '/v1/ai/ask', {
      question: 'How much on coffee?',
    });
    expect(ask.status).toBe(409);
    for (const provider of ['anthropic', 'openai', 'workers_ai'] as const) {
      await updateSettings(db, { aiProvider: provider });
      expect(() =>
        getAi(env, { ...DEFAULT_SETTINGS, aiEnabled: false, aiProvider: provider }),
      ).toThrow(AiDisabledError);
    }
    expect(calls).toEqual([]);
  });
});

describe('Workers AI (default provider)', () => {
  it('categorizes with the text model and JSON schema, and counts the call', async () => {
    const checking = await addAccount({ type: 'checking' });
    const t = await addTxn(checking, {
      date: '2026-11-01',
      amount: -575,
      rawName: 'BLUE BOTTLE 0042',
    });
    const { binding, calls } = fakeBinding(() =>
      JSON.parse(JSON.stringify(categorizeReply).replace('__ID__', t.id)),
    );
    const res = await runCategorization({ ...testEnv, AI: binding });
    expect(res).toMatchObject({ changed: 1, usedAi: true });
    expect(calls[0]!.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    expect(calls[0]!.inputs.response_format).toMatchObject({ type: 'json_schema' });
    expect(await getTransaction(db, t.id)).toMatchObject({
      categoryId: 'cat_coffee',
      categorySource: 'ai',
      aiCategoryConfidence: 0.88,
    });
    const usage = await db
      .prepare("SELECT calls FROM ai_usage WHERE provider = 'workers_ai'")
      .first<{ calls: number }>();
    expect(usage?.calls).toBe(1);
  });

  it('stops at the daily call limit', async () => {
    const { binding } = fakeBinding(() => ({ response: 'hi' }));
    const env = { ...testEnv, AI: binding, AI_DAILY_CALL_LIMIT: '1' };
    const ai = getAi(env, await getSettings(db), { today: '2026-11-05' });
    await ai.complete({ system: 's', prompt: 'p' });
    await expect(ai.complete({ system: 's', prompt: 'p' })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });

  it('reads a receipt photo with the vision model and matches it to the card charge', async () => {
    const card = await addAccount({ type: 'credit_card' });
    const t = await addTxn(card, {
      date: '2026-11-03',
      amount: -4_137,
      rawName: 'GREENLEAF BISTRO NYC',
      categoryId: 'cat_dining',
    });
    await addTxn(card, { date: '2026-11-03', amount: -4_200, rawName: 'GAS STATION' });
    const receiptJson = (await import('./fixtures/ai/receipt-greenleaf.json')).default;
    const { binding, calls } = fakeBinding(() => ({ response: receiptJson }));
    const res = await uploadReceipt(
      { ...testEnv, AI: binding },
      { bytes: PNG, contentType: 'image/png' },
    );
    expect(calls[0]!.model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
    const content = (calls[0]!.inputs.messages as { content: unknown }[])[1]!.content as {
      type: string;
    }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
    expect(res.receipt).toMatchObject({
      merchant: 'Greenleaf Bistro',
      total: 4_137,
      currency: 'USD',
      status: 'matched',
      matchedTransactionId: t.id,
    });
    expect(res.receipt.lineItems.map((l) => [l.amount, l.categoryId])).toEqual([
      [2_200, 'cat_dining'],
      [800, 'cat_dining'],
      [800, 'cat_gifts'],
    ]);
    expect((await getTransaction(db, t.id))?.receiptId).toBe(res.receipt.id);
    const stored = await testEnv.FILES.get(res.receipt.r2Key);
    expect(stored).not.toBeNull();
  });

  it('reads a PDF statement through toMarkdown and the text model', async () => {
    const nre = await addAccount({
      type: 'savings',
      subtype: 'nre',
      currency: 'INR',
      mask: '7731',
    });
    const { binding, calls } = fakeBinding(() => ({ response: statementJson }));
    const preview = await previewImport(
      { ...testEnv, AI: binding },
      { ...file('%PDF-1.4 sample', 'nre-october.pdf'), accountId: nre.id },
    );
    expect(calls.map((c) => c.model)).toEqual([
      'toMarkdown',
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    ]);
    const prompt = (calls[1]!.inputs.messages as { content: string }[])[1]!.content;
    expect(prompt).toContain('INWARD REMITTANCE WISE REF 88123');
    expect(preview.format).toBe('pdf');
    expect(preview.counts.new).toBe(3);
  });
});

describe('Anthropic (own API key)', () => {
  it('uses the official SDK with the default model, fallbacks, JSON schema and an image block', async () => {
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(anthropicMessage);
    }) as typeof fetch;
    await updateSettings(db, { aiProvider: 'anthropic' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, { date: '2026-11-02', amount: -4_137, rawName: 'GREENLEAF BISTRO' });
    const res = await uploadReceipt(
      { ...testEnv, ANTHROPIC_API_KEY: 'sk-ant-test', AI: undefined },
      { bytes: PNG, contentType: 'image/png' },
      { fetch: fetchFake },
    );
    expect(res.receipt).toMatchObject({
      merchant: 'Greenleaf Bistro',
      total: 4_137,
      status: 'matched',
    });
    const req = requests[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    const blocks = (req.body.messages as { content: { type: string }[] }[])[0]!.content.map(
      (b) => b.type,
    );
    expect(blocks).toEqual(['image', 'text']);
  });

  it('is unavailable without its key and the error says so', async () => {
    const settings = { ...(await getSettings(db)), aiProvider: 'anthropic' as const };
    expect(() => getAi({ ...testEnv, ANTHROPIC_API_KEY: undefined }, settings)).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe('OpenAI (own API key)', () => {
  it('answers a plain-English question from computed monthly totals', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(openaiChat);
    }) as typeof fetch;
    await updateSettings(db, { aiProvider: 'openai' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(card, {
      date: '2026-10-12',
      amount: -41_280,
      rawName: 'BISTRO',
      categoryId: 'cat_dining',
    });
    const res = await client({ fetch: fetchFake }, { ...testEnv, OPENAI_API_KEY: 'sk-test' }).api<{
      answer: string;
    }>('POST', '/v1/ai/ask', {
      question: 'How much did I spend on restaurants in October?',
    });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('You spent $412.80 on restaurants in October.');
    const prompt = (bodies[0]!.messages as { content: string }[])[1]!.content;
    expect(prompt).toContain('Restaurants $412.80');
  });
});
