import type { AiProvider, AiStatusResponse } from '@manaclaude/shared';
import { BackendError, errorText } from '../../data/backend/client';

/** The Worker takes questions of 3 to 500 characters. */
export const QUESTION_MIN = 3;
export const QUESTION_MAX = 500;

export const PROVIDER_LABEL: Record<AiProvider, string> = {
  workers_ai: 'Workers AI',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openai_compatible: 'an OpenAI-compatible service',
  gemini_paid: 'Gemini (paid tier)',
};

const MISSING: Record<AiProvider, string> = {
  workers_ai: 'Workers AI is not connected to this Worker.',
  anthropic: 'No Anthropic key is set on the Worker.',
  openai: 'No OpenAI key is set on the Worker.',
  openai_compatible: 'The OpenAI-compatible address or key is not set on the Worker.',
  gemini_paid: 'No Gemini key is set on the Worker.',
};

/** Why a question cannot be sent yet, or null. */
export function questionProblem(text: string): string | null {
  const q = text.trim();
  if (q.length < QUESTION_MIN) return `Type a question of at least ${QUESTION_MIN} characters.`;
  if (q.length > QUESTION_MAX) return `Use at most ${QUESTION_MAX} characters (${q.length} now).`;
  return null;
}

/** Plain lines about the Worker's AI settings and today's use. */
export function statusLines(s: AiStatusResponse): { headline: string; lines: string[] } {
  if (!s.enabled)
    return {
      headline: 'AI is off',
      lines: ['Nothing is sent to any AI. Turn on AI features in Settings, AI, to ask questions.'],
    };
  const lines: string[] = [];
  if (!s.configured[s.provider]) lines.push(MISSING[s.provider]);
  const used = `Today: ${s.workersAiCallsToday} of ${s.workersAiDailyLimit} Workers AI calls used.`;
  lines.push(
    s.provider === 'workers_ai'
      ? `${used} Every AI job on the Worker counts, not only questions, and the count starts again at midnight UTC.`
      : `${used} Your questions go to ${PROVIDER_LABEL[s.provider]}, which this count does not cover.`,
  );
  if (s.provider === 'workers_ai' && s.workersAiCallsToday >= s.workersAiDailyLimit)
    lines.push("Today's allowance is used up, so questions will be refused until tomorrow.");
  return { headline: `AI is on, using ${PROVIDER_LABEL[s.provider]}`, lines };
}

export type AskFailure = { kind: 'disabled' | 'unavailable' | 'other'; text: string };

/** The answer that did not come, in plain words. */
export function askFailure(e: unknown): AskFailure {
  if (e instanceof BackendError) {
    if (e.status === 409 && e.code === 'ai_disabled')
      return {
        kind: 'disabled',
        text: 'AI is switched off on your Worker, so nothing was sent to any AI. To ask questions, turn on AI features in Settings, AI.',
      };
    if (e.status === 503 && e.code === 'ai_unavailable')
      return {
        kind: 'unavailable',
        text: `The AI could not be reached, so there is no answer. The Worker said: ${e.message}`,
      };
  }
  return { kind: 'other', text: `No answer. ${errorText(e)}` };
}
