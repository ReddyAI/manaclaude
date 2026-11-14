import {
  convertAmount,
  goalProgress,
  type Account,
  type FxRate,
  type Goal,
  type GoalProgress,
  type Id,
  type YearMonth,
} from '@manaclaude/shared';
import { isBalanceUnknown } from '../../data/manualBalance';

/**
 * Progress toward a goal, counting only linked accounts whose value is known.
 * An account whose balance nobody has entered, one with no exchange rate to
 * the goal's currency, or one no longer in the data is left out and listed,
 * never added as 0.
 */

export type LeftOutReason = 'unknown_balance' | 'no_rate' | 'missing';

export interface LeftOut {
  accountId: Id;
  name: string | null;
  reason: LeftOutReason;
}

export interface GoalStatus {
  /** Null when every linked account is left out: progress is not known. */
  progress: GoalProgress | null;
  leftOut: LeftOut[];
}

export function goalStatus(
  goal: Goal,
  accounts: readonly Account[],
  rates: readonly FxRate[],
  todayMonth: YearMonth,
): GoalStatus {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const leftOut: LeftOut[] = [];
  const values = new Map<Id, number>();
  for (const id of goal.accountIds) {
    const a = byId.get(id);
    if (!a) {
      leftOut.push({ accountId: id, name: null, reason: 'missing' });
      continue;
    }
    if (isBalanceUnknown(a)) {
      leftOut.push({ accountId: id, name: a.name, reason: 'unknown_balance' });
      continue;
    }
    const v = convertAmount(a.balance, a.currency, goal.currency, rates);
    if (v === null) {
      leftOut.push({ accountId: id, name: a.name, reason: 'no_rate' });
      continue;
    }
    values.set(id, v);
  }
  if (goal.accountIds.length > 0 && values.size === 0) return { progress: null, leftOut };
  const counted: Goal = { ...goal, accountIds: goal.accountIds.filter((id) => values.has(id)) };
  return {
    progress: goalProgress(counted, (id) => values.get(id) ?? 0, todayMonth),
    leftOut,
  };
}

/** One sentence naming what the goal leaves out and why. */
export function leftOutText(goal: Goal, leftOut: readonly LeftOut[]): string | null {
  if (leftOut.length === 0) return null;
  const parts = leftOut.map((l) => {
    const name = l.name === null ? 'an account no longer in your data' : `"${l.name}"`;
    if (l.reason === 'unknown_balance') return `${name} (balance unknown)`;
    if (l.reason === 'no_rate') return `${name} (no exchange rate to ${goal.currency})`;
    return name;
  });
  return `Leaves out ${parts.join(', ')}.`;
}
