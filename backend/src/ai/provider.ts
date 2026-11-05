import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, Settings } from '@manaclaude/shared';
import type { Env } from '../env';
import { toBase64 } from './base64';

/**
 * One AI layer for every in-app AI feature. Workers AI is the default (free
 * allowance, inputs aren't used for training). Anthropic, OpenAI, an
 * OpenAI-compatible endpoint or paid Gemini are used only when chosen in
 * Settings and their key is set as a Worker secret. Free tiers whose terms
 * allow training on or human review of inputs are never used.
 *
 * settings.aiEnabled = false stops every call: getAi() throws AiDisabledError
 * before anything leaves the Worker.
 */

export class AiDisabledError extends Error {
  constructor() {
    super('AI is turned off in Settings.');
    this.name = 'AiDisabledError';
  }
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AiRequest {
  system: string;
  prompt: string;
  /** When set, the reply must be JSON matching this schema. */
  schema?: JsonSchema;
  maxTokens?: number;
  /** Optional attachment. */
  image?: { data: Uint8Array<ArrayBuffer>; mediaType: string };
  pdf?: { data: Uint8Array<ArrayBuffer>; fileName: string };
}

export interface AiClient {
  provider: AiProvider;
  /** Returns the reply text (JSON text when a schema was given). */
  complete(req: AiRequest): Promise<string>;
}

export const DEFAULT_MODELS = {
  workersText: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  workersVision: '@cf/meta/llama-4-scout-17b-16e-instruct',
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
} as const;

export type FetchFn = typeof fetch;

export interface AiDeps {
  fetch?: FetchFn;
  /** Use this client instead of building one (tests). The aiEnabled switch still applies. */
  client?: AiClient;
  /** Override the clock for usage counting in tests. */
  today?: string;
}

/** Parses the reply as JSON, tolerating a fenced block or text around one object. */
export function parseJsonReply<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return JSON.parse(fenced[1]!) as T;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as T;
    throw new Error('The AI reply was not JSON.');
  }
}

export async function completeJson<T>(ai: AiClient, req: AiRequest): Promise<T> {
  return parseJsonReply<T>(await ai.complete(req));
}

// ---------------------------------------------------------------------------
// Workers AI
// ---------------------------------------------------------------------------

async function countWorkersAiCall(env: Env, today: string): Promise<void> {
  const limit = Number(env.AI_DAILY_CALL_LIMIT ?? '300');
  const row = await env.DB.prepare(
    'INSERT INTO ai_usage (day, provider, calls) VALUES (?, ?, 1) ON CONFLICT (day, provider) DO UPDATE SET calls = calls + 1 RETURNING calls',
  )
    .bind(today, 'workers_ai')
    .first<{ calls: number }>();
  if ((row?.calls ?? 0) > limit) {
    throw new AiUnavailableError(`Today's Workers AI allowance (${limit} calls) is used up. Try again tomorrow.`);
  }
}

function workersAi(env: Env, deps: AiDeps): AiClient {
  const binding = env.AI;
  if (!binding) throw new AiUnavailableError('Workers AI is not bound to this Worker.');
  return {
    provider: 'workers_ai',
    async complete(req) {
      await countWorkersAiCall(env, deps.today ?? new Date().toISOString().slice(0, 10));
      let prompt = req.prompt;
      if (req.pdf) {
        if (!binding.toMarkdown) throw new AiUnavailableError('Workers AI cannot read PDFs here.');
        const [doc] = await binding.toMarkdown([
          { name: req.pdf.fileName, blob: new Blob([req.pdf.data], { type: 'application/pdf' }) },
        ]);
        if (!doc || doc.error || !doc.data) throw new AiUnavailableError('Could not read text from this PDF.');
        prompt = `${req.prompt}\n\nStatement text:\n${doc.data}`;
      }
      const userContent: unknown = req.image
        ? [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${req.image.mediaType};base64,${toBase64(req.image.data)}` },
            },
          ]
        : prompt;
      const inputs: Record<string, unknown> = {
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: userContent },
        ],
        max_tokens: req.maxTokens ?? 2048,
      };
      if (req.schema) inputs.response_format = { type: 'json_schema', json_schema: req.schema };
      const model = req.image
        ? (env.AI_VISION_MODEL ?? DEFAULT_MODELS.workersVision)
        : (env.AI_TEXT_MODEL ?? DEFAULT_MODELS.workersText);
      const out = (await binding.run(model, inputs)) as { response?: unknown };
      const response = out?.response;
      if (response === undefined || response === null) throw new AiUnavailableError('Workers AI returned nothing.');
      return typeof response === 'string' ? response : JSON.stringify(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic (official SDK)
// ---------------------------------------------------------------------------

function anthropic(env: Env, deps: AiDeps): AiClient {
  if (!env.ANTHROPIC_API_KEY) throw new AiUnavailableError('ANTHROPIC_API_KEY is not set.');
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    maxRetries: 2,
  });
  const model = env.ANTHROPIC_MODEL ?? DEFAULT_MODELS.anthropic;
  return {
    provider: 'anthropic',
    async complete(req) {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (req.pdf) {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: toBase64(req.pdf.data) },
        });
      }
      if (req.image) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: req.image.mediaType as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif',
            data: toBase64(req.image.data),
          },
        });
      }
      content.push({ type: 'text', text: req.prompt });
      const message = await client.beta.messages.create({
        model,
        max_tokens: req.maxTokens ?? 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: req.system,
        // These are short extraction and labelling tasks.
        output_config: {
          effort: 'low',
          ...(req.schema ? { format: { type: 'json_schema', schema: req.schema as unknown as Record<string, unknown> } } : {}),
        },
        messages: [{ role: 'user', content }],
      });
      if (message.stop_reason === 'refusal') throw new AiUnavailableError('The model declined this request.');
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!text) throw new AiUnavailableError('The model returned no text.');
      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI, OpenAI-compatible and paid Gemini (OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

function openAiLike(
  provider: AiProvider,
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  deps: AiDeps,
): AiClient {
  if (!apiKey) throw new AiUnavailableError(`No API key is set for ${provider}.`);
  const doFetch = deps.fetch ?? fetch;
  return {
    provider,
    async complete(req) {
      if (req.pdf) throw new AiUnavailableError(`${provider} PDF reading is not set up; use Workers AI or Anthropic.`);
      const user: unknown = req.image
        ? [
            { type: 'text', text: req.prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${req.image.mediaType};base64,${toBase64(req.image.data)}` },
            },
          ]
        : req.prompt;
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: user },
        ],
        max_completion_tokens: req.maxTokens ?? 4096,
      };
      if (req.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'result', schema: req.schema, strict: false },
        };
      }
      const res = await doFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new AiUnavailableError(`${provider} returned HTTP ${res.status}.`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = json.choices?.[0]?.message?.content;
      if (!text) throw new AiUnavailableError(`${provider} returned no text.`);
      return text;
    },
  };
}

/**
 * The AI client for the current settings. Throws AiDisabledError when AI is
 * off, so callers can't forget the switch.
 */
export function getAi(env: Env, settings: Settings, deps: AiDeps = {}): AiClient {
  if (!settings.aiEnabled) throw new AiDisabledError();
  if (deps.client) return deps.client;
  switch (settings.aiProvider) {
    case 'workers_ai':
      return workersAi(env, deps);
    case 'anthropic':
      return anthropic(env, deps);
    case 'openai':
      return openAiLike('openai', 'https://api.openai.com/v1', env.OPENAI_API_KEY, env.OPENAI_MODEL ?? DEFAULT_MODELS.openai, deps);
    case 'openai_compatible':
      if (!env.OPENAI_BASE_URL) throw new AiUnavailableError('OPENAI_BASE_URL is not set.');
      return openAiLike('openai_compatible', env.OPENAI_BASE_URL, env.OPENAI_API_KEY, env.OPENAI_MODEL ?? DEFAULT_MODELS.openai, deps);
    case 'gemini_paid':
      // Paid key only: Gemini's free tier lets reviewers read inputs, so it is never used.
      return openAiLike(
        'gemini_paid',
        'https://generativelanguage.googleapis.com/v1beta/openai',
        env.GEMINI_API_KEY,
        env.OPENAI_MODEL ?? DEFAULT_MODELS.gemini,
        deps,
      );
  }
}

/** The AI client, or null when AI is off or not set up. Jobs use this to fall back to rules. */
export function tryGetAi(env: Env, settings: Settings, deps: AiDeps = {}): AiClient | null {
  try {
    return getAi(env, settings, deps);
  } catch {
    return null;
  }
}

/** Which providers have what they need, for the Settings screen. */
export function providerStatus(env: Env): Record<AiProvider, boolean> {
  return {
    workers_ai: Boolean(env.AI),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
    openai_compatible: Boolean(env.OPENAI_API_KEY && env.OPENAI_BASE_URL),
    gemini_paid: Boolean(env.GEMINI_API_KEY),
  };
}
