import type { Env } from '../env';
import { getSettings } from '../services/settings';
import { tryGetAi, type AiDeps } from '../ai/provider';

/** One bounded model call per maintenance step. The ordinary job fallbacks
 * still apply when AI is disabled, unavailable, over allowance or times out.
 */
export async function scheduledAi(env: Env, deps: AiDeps): Promise<AiDeps> {
  const fetcher = deps.fetch ?? fetch;
  const boundedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetcher(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(30_000),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 131_072) throw new Error('Scheduled AI response too large');
        chunks.push(chunk.value as Uint8Array<ArrayBuffer>);
      }
    } finally {
      await reader.cancel();
    }
    return new Response(new Blob(chunks), { status: response.status, headers: response.headers });
  }) as typeof fetch;
  const ai = tryGetAi(env, await getSettings(env.DB), { ...deps, fetch: boundedFetch });
  if (!ai) return { ...deps, fetch: boundedFetch };
  let calls = 0;
  return {
    ...deps,
    client: {
      provider: ai.provider,
      async complete(request) {
        if (++calls > 1) throw new Error('Scheduled AI call budget exceeded');
        if (request.prompt.length + request.system.length > 32_768)
          throw new Error('Scheduled AI prompt too large');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const reply = await Promise.race([
            ai.complete(request),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Scheduled AI deadline exceeded')), 30_000);
            }),
          ]);
          if (reply.length > 65_536) throw new Error('Scheduled AI reply too large');
          return reply;
        } finally {
          clearTimeout(timer);
        }
      },
    },
  };
}
