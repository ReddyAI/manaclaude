import type { AiJobResponse } from '@manaclaude/shared';
import type { Env } from '../../env';
import type { AiDeps } from '../provider';
import { getSettings } from '../../services/settings';
import { runAlerts } from './alerts';
import { runCategorization } from './categorize';
import { runMerchantCleanup } from './merchants';
import { generateRecap, lastCompletePeriod } from './recap';
import { runRecurringDetection } from './recurring';

export const JOBS = [
  'categorize',
  'merchants',
  'recurring',
  'alerts',
  'recap_week',
  'recap_month',
] as const;
export type JobName = (typeof JOBS)[number];

export async function runJob(
  env: Env,
  job: JobName,
  deps: AiDeps = {},
  today = new Date().toISOString().slice(0, 10),
): Promise<AiJobResponse> {
  switch (job) {
    case 'categorize':
      return runCategorization(env, {}, deps);
    case 'merchants':
      return runMerchantCleanup(env, deps);
    case 'recurring':
      return runRecurringDetection(env);
    case 'alerts':
      return runAlerts(env, today);
    case 'recap_week':
    case 'recap_month': {
      const settings = await getSettings(env.DB);
      const period = job === 'recap_week' ? 'week' : 'month';
      const recap = await generateRecap(
        env,
        period,
        lastCompletePeriod(period, today, settings.weekStartsOn),
        deps,
      );
      return { job, changed: 1, usedAi: recap.provider !== 'template', note: null };
    }
  }
}

/** Daily cron: merchant cleanup, categorization, recurring, alerts, and recaps when a period just ended. */
export async function runDailyJobs(
  env: Env,
  today: string,
  deps: AiDeps = {},
): Promise<AiJobResponse[]> {
  const settings = await getSettings(env.DB);
  const out: AiJobResponse[] = [];
  for (const job of ['merchants', 'categorize', 'recurring', 'alerts'] as const) {
    try {
      out.push(await runJob(env, job, deps, today));
    } catch (e) {
      out.push({ job, changed: 0, usedAi: false, note: e instanceof Error ? e.message : 'failed' });
    }
  }
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  if (dow === settings.weekStartsOn) out.push(await runJob(env, 'recap_week', deps, today));
  if (today.endsWith('-01')) out.push(await runJob(env, 'recap_month', deps, today));
  return out;
}
