import type { AiStatusResponse, AskRequest, AskResponse } from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** A model on Workers AI can take a while to write an answer. */
const ASK_TIMEOUT_MS = 90_000;

/** GET /v1/ai/status: what the Worker's AI is set to and today's Workers AI calls. */
export function getAiStatus(): Promise<AiStatusResponse> {
  return api<AiStatusResponse>('GET', '/v1/ai/status');
}

/**
 * POST /v1/ai/ask. 409 `ai_disabled` when AI is switched off (nothing is
 * sent to any AI), 503 `ai_unavailable` when the AI could not answer.
 */
export async function askQuestion(question: string): Promise<string> {
  const body: AskRequest = { question };
  return (await api<AskResponse>('POST', '/v1/ai/ask', body, { timeoutMs: ASK_TIMEOUT_MS })).answer;
}
