import type { AiJobResponse } from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** The jobs POST /v1/ai/jobs/:job runs, in the order the nightly run does them. */
export const AI_JOBS = [
  { job: 'merchants', label: 'Clean up merchant names' },
  { job: 'categorize', label: 'Categorize transactions' },
  { job: 'recurring', label: 'Find bills and subscriptions' },
  { job: 'alerts', label: 'Check for duplicate, unusual and higher charges' },
  { job: 'recap_week', label: "Write last week's recap" },
  { job: 'recap_month', label: "Write last month's recap" },
] as const;

export type AiJobName = (typeof AI_JOBS)[number]['job'];

export function runAiJob(job: AiJobName): Promise<AiJobResponse> {
  return api<AiJobResponse>('POST', `/v1/ai/jobs/${job}`);
}

/** What one run did, in plain words. */
export function aiJobText(r: AiJobResponse): string {
  const what =
    r.changed === 0
      ? 'Done. Nothing needed changing.'
      : `Done. ${r.changed} ${r.changed === 1 ? 'item' : 'items'} changed or added.`;
  const how = r.usedAi ? 'It used AI.' : 'It used rules and plain numbers only, no AI.';
  return [what, how, r.note?.trim() || null].filter(Boolean).join(' ');
}
