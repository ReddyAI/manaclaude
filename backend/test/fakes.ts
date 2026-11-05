import type { AiStatementJson } from '@manaclaude/shared';
import type { AiClient, AiDeps, AiRequest } from '../src/ai/provider';

export interface FakeAiReplies {
  categorize?: Record<string, { category: string; confidence: number }>;
  merchants?: Record<string, string>;
  receipt?: unknown;
  statement?: AiStatementJson;
  text?: string;
}

/**
 * A stand-in AI client for tests. It answers by looking at the JSON schema of
 * the request, the same way each job asks, and records every call.
 */
export function fakeAi(replies: FakeAiReplies = {}): {
  client: AiClient;
  deps: AiDeps;
  calls: AiRequest[];
} {
  const calls: AiRequest[] = [];
  const client: AiClient = {
    provider: 'workers_ai',
    async complete(req) {
      calls.push(req);
      const props = req.schema?.properties ?? {};
      if ('lineItems' in props) return JSON.stringify(replies.receipt ?? {});
      if ('transactions' in props) return JSON.stringify(replies.statement ?? { transactions: [] });
      if ('results' in props) {
        const item = (props.results as { items: { properties: Record<string, unknown> } }).items
          .properties;
        if ('category' in item) {
          const results = Object.entries(replies.categorize ?? {})
            .filter(([id]) => req.prompt.includes(id))
            .map(([id, r]) => ({ id, ...r }));
          return JSON.stringify({ results });
        }
        if ('raw' in item) {
          return JSON.stringify({
            results: Object.entries(replies.merchants ?? {}).map(([raw, name]) => ({ raw, name })),
          });
        }
      }
      return replies.text ?? 'ok';
    },
  };
  return { client, deps: { client }, calls };
}
