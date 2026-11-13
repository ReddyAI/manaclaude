import type { Connection, SophtronLinkStatus } from '@manaclaude/shared';
import { BackendError, errorText, isSuperseded } from '../../data/backend/client';
import { canSaveToBackend, refreshDataset } from '../../data/backend/sync';
import { getFinance } from '../../data/store';
import { linkApi } from './linkApi';
import { sentence } from './types';

/**
 * Waiting for a Sophtron sign-in, one request at a time.
 *
 * The app asks the Worker for the status, waits for that answer, pauses, and
 * only then asks again. Two status requests are never on their way together:
 * the Worker finishes a sign-in on the first request that sees it succeed, and
 * a second request arriving in the same moment gets "done" with no connection.
 *
 * Replaced in tests (shorter waits).
 */
export const sophtronTiming = {
  /** Pause between one answer and the next question. */
  pollMs: 3000,
  /** Status requests before the app stops and offers Check again. */
  maxPolls: 60,
  /** Longest total wait before the app stops and offers Check again. */
  maxWaitMs: 5 * 60_000,
  /** Requests in a row that may fail (no network, Worker error) before stopping. */
  maxFailures: 3,
  /** Dataset reloads when looking for a connection the Worker did not name. */
  confirmTries: 3,
  /** Pause between those reloads. */
  confirmWaitMs: 2000,
};

export type PollEnd =
  /** The Worker answered with something other than "still signing in". */
  | { kind: 'status'; status: SophtronLinkStatus }
  /** Stopped without an answer; the same sign-in can be checked again. */
  | { kind: 'stalled'; message: string }
  /** The sign-in is gone on the Worker (expired, wrong token); start over. */
  | { kind: 'ended'; message: string }
  /** The screen went away. */
  | { kind: 'cancelled' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failed status request worth another try: no answer at all, or a Worker error. */
function worthRetrying(e: unknown): boolean {
  return e instanceof BackendError && !e.superseded && (e.status === 0 || e.status >= 500);
}

export async function pollSophtron(linkId: string, live: () => boolean): Promise<PollEnd> {
  const t = sophtronTiming;
  const startedAt = Date.now();
  let failures = 0;
  for (let polls = 1; polls <= t.maxPolls; polls += 1) {
    await sleep(t.pollMs);
    if (!live()) return { kind: 'cancelled' };
    if (Date.now() - startedAt > t.maxWaitMs) break;
    let status: SophtronLinkStatus;
    try {
      // Awaited before the loop goes round: never a second request beside this one.
      status = await linkApi.sophtronStatus(linkId);
    } catch (e) {
      if (!live()) return { kind: 'cancelled' };
      if (isSuperseded(e)) return { kind: 'ended', message: errorText(e) };
      if (!worthRetrying(e)) return { kind: 'ended', message: errorText(e) };
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

const WORKING: Connection['status'][] = ['healthy', 'syncing'];

/**
 * The Sophtron connections on screen before a sign-in starts, to tell a new
 * one apart afterwards. Null when the data on screen is not this backend's
 * (sample data, or the first load has not arrived), because then every
 * connection would look new.
 */
export function sophtronConnectionsNow(): ReadonlySet<string> | null {
  if (!canSaveToBackend()) return null;
  return new Set(
    getFinance()
      .connections.filter((c) => c.connectorId === 'sophtron')
      .map((c) => c.id),
  );
}

export interface Found {
  connectionIds: string[];
  repaired: boolean;
}
/** Why it is not confirmed: the data could not be reloaded, or the connection is not in it. */
export type Missing = 'unreachable' | 'absent';

/**
 * The Worker said "done" but did not name the connection (its answer to the
 * request that finished the sign-in was lost). Reload the data and look:
 *
 * - Repair: the connection being repaired must no longer show a problem.
 * - New login: exactly one Sophtron connection that was not there before the
 *   sign-in (the one with the picked bank's name, if several are new).
 *
 * Nothing is changed either way; this only reads.
 */
export async function findFinishedConnection(
  target: {
    connectionId?: string;
    before: ReadonlySet<string> | null;
    institutionName: string | null;
  },
  live: () => boolean,
): Promise<Found | { missing: Missing }> {
  const t = sophtronTiming;
  let everLoaded = false;
  for (let attempt = 1; attempt <= t.confirmTries; attempt += 1) {
    const loaded = await refreshDataset();
    if (!live()) break;
    if (loaded) {
      everLoaded = true;
      const sophtron = getFinance().connections.filter((c) => c.connectorId === 'sophtron');
      if (target.connectionId) {
        const repaired = sophtron.find((c) => c.id === target.connectionId);
        if (repaired && WORKING.includes(repaired.status))
          return { connectionIds: [repaired.id], repaired: true };
      } else if (target.before) {
        const before = target.before;
        const added = sophtron.filter((c) => !before.has(c.id));
        // The Worker saves the bank's name as it was picked; prefer that match.
        const named = added.filter((c) => c.institutionName === target.institutionName);
        const found = named.length > 0 ? named : added;
        const only = found.length === 1 ? found[0] : undefined;
        if (only) return { connectionIds: [only.id], repaired: false };
      }
    }
    if (attempt < t.confirmTries) {
      await sleep(t.confirmWaitMs);
      if (!live()) break;
    }
  }
  return { missing: everLoaded ? 'absent' : 'unreachable' };
}
