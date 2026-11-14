import type { SophtronLinkStatus } from '@manaclaude/shared';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { linkApi } from './linkApi';
import { sentence } from './types';

/**
 * Waiting for a Sophtron sign-in, one request at a time.
 *
 * The app asks the Worker for the status, waits for that answer, pauses, and
 * only then asks again. Two status requests are never on their way together.
 * The Worker keeps the result of a finished sign-in for the session's 30
 * minutes, so after a lost answer the same request on the same linkId is safe
 * to send again: it answers "done" with the same connection, never a second.
 *
 * Replaced in tests (shorter waits).
 */
export const sophtronTiming = {
  /** Pause between one answer and the next question. */
  pollMs: 3000,
  /** Pause after the Worker says too many requests (429) before asking again. */
  rateLimitWaitMs: 15_000,
  /** Status requests before the app stops and offers Check again. */
  maxPolls: 60,
  /** Longest total wait before the app stops and offers Check again. */
  maxWaitMs: 5 * 60_000,
  /** Requests in a row that may fail (no network, Worker error) before stopping. */
  maxFailures: 3,
};

export type PollEnd =
  /** The Worker answered with something other than "still signing in". */
  | { kind: 'status'; status: SophtronLinkStatus }
  /** Stopped without an answer; the same sign-in can be checked again. */
  | { kind: 'stalled'; message: string }
  /** The sign-in is gone on the Worker (expired, wrong token); start over. */
  | { kind: 'ended'; message: string }
  /** The Worker cannot say how this sign-in ended (409 link_result_unavailable). */
  | { kind: 'unavailable' }
  /** The screen went away. */
  | { kind: 'cancelled' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A request whose outcome is not known: it got no answer (offline, timeout)
 * or the Worker failed (5xx). The Worker may have acted on it.
 */
export function outcomeUnknown(e: unknown): boolean {
  return e instanceof BackendError && !e.superseded && (e.status === 0 || e.status >= 500);
}

export const isRateLimited = (e: unknown): boolean => e instanceof BackendError && e.status === 429;

export const isResultUnavailable = (e: unknown): boolean =>
  e instanceof BackendError && e.status === 409 && e.code === 'link_result_unavailable';

/**
 * Asks for the status of one sign-in until it is no longer pending. Only ever
 * asks about this linkId; it never starts a sign-in. `firstWaitMs` replaces
 * the first pause (after a 429 on an answer).
 */
export async function pollSophtron(
  linkId: string,
  live: () => boolean,
  opts: { firstWaitMs?: number } = {},
): Promise<PollEnd> {
  const t = sophtronTiming;
  const startedAt = Date.now();
  let failures = 0;
  let wait = opts.firstWaitMs ?? t.pollMs;
  for (let polls = 1; polls <= t.maxPolls; polls += 1) {
    await sleep(wait);
    wait = t.pollMs;
    if (!live()) return { kind: 'cancelled' };
    if (Date.now() - startedAt > t.maxWaitMs) break;
    let status: SophtronLinkStatus;
    try {
      // Awaited before the loop goes round: never a second request beside this one.
      status = await linkApi.sophtronStatus(linkId);
    } catch (e) {
      if (!live()) return { kind: 'cancelled' };
      if (isSuperseded(e)) return { kind: 'ended', message: errorText(e) };
      if (isResultUnavailable(e)) return { kind: 'unavailable' };
      if (isRateLimited(e)) {
        // Too many requests: wait longer before the same question.
        wait = t.rateLimitWaitMs;
        continue;
      }
      if (!outcomeUnknown(e)) return { kind: 'ended', message: errorText(e) };
      failures += 1;
      if (failures >= t.maxFailures) {
        return {
          kind: 'stalled',
          message: `${sentence(errorText(e))} The sign-in may still be going on at the bank. Check again before you start a new one.`,
        };
      }
      continue;
    }
    if (!live()) return { kind: 'cancelled' };
    failures = 0;
    if (status.status !== 'pending') return { kind: 'status', status };
  }
  return {
    kind: 'stalled',
    message:
      'The bank is taking longer than usual. Check again in a minute before you start a new sign-in.',
  };
}

/**
 * A "done" answer the app can act on: it names exactly the connection, and
 * says whether it was repaired. A repair must name the connection being
 * repaired and say repaired; a new login must not. Anything else is treated
 * as unconfirmed, never guessed.
 */
export function doneConnection(
  s: SophtronLinkStatus,
  repairing: string | undefined,
): { connectionIds: string[]; repaired: boolean } | null {
  const ids = s.connectionIds ?? [];
  if (ids.length === 0 || typeof s.repaired !== 'boolean') return null;
  if (s.repaired !== Boolean(repairing)) return null;
  if (repairing && (ids.length !== 1 || ids[0] !== repairing)) return null;
  return { connectionIds: ids, repaired: s.repaired };
}
