import { appendFileSync } from 'node:fs';
import { summaryMarkdown } from './config.ts';

/** Prints the run summary: Worker, web app and MCP URLs (values come from earlier jobs through env). */
export function writeSummary(env: Record<string, string | undefined>): string {
  const clean = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const notes: string[] = [];
  const worker = clean(env.WORKER_URL);
  const web = clean(env.WEB_URL);
  if (worker) {
    notes.push(`Zerodha redirect URL to register: ${worker}/v1/link/zerodha_kite/callback`);
  }
  if (env.WEB_DEPLOYED !== 'true' && web) {
    notes.push('The web app address exists, but this run did not publish a new web build.');
  }
  return summaryMarkdown({ worker, web, mcp: clean(env.MCP_URL), notes });
}

if (import.meta.main) {
  const text = writeSummary(process.env);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
