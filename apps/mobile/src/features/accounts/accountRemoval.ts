import type {
  Account,
  AccountDeletionBlocker,
  AccountDeletionPreview,
  DefaultCashAfterDeletion,
} from '@manaclaude/shared';

/**
 * GET /v1/accounts/:id/deletion-preview in plain words. Removal only works
 * for an account with nothing in it: the Worker never deletes history along
 * with an account. Every blocker and count is said, with what to do first.
 */

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "a, b and c" */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What still points at the account (the account_in_use blocker). */
export function usedBy(counts: AccountDeletionPreview['counts']): string[] {
  const out: string[] = [];
  if (counts.holdings) out.push(plural(counts.holdings, 'holding'));
  if (counts.investmentActivities)
    out.push(plural(counts.investmentActivities, 'investment activity', 'investment activities'));
  if (counts.recurringItems) out.push(plural(counts.recurringItems, 'recurring item'));
  if (counts.goals) out.push(plural(counts.goals, 'goal'));
  if (counts.rules) out.push(plural(counts.rules, 'rule'));
  return out;
}

export interface BlockerText {
  blocker: AccountDeletionBlocker;
  /** What stops the removal. */
  what: string;
  /** What to do first. */
  todo: string;
}

export function blockerText(
  blocker: AccountDeletionBlocker,
  preview: Pick<AccountDeletionPreview, 'counts'>,
): BlockerText {
  const { counts } = preview;
  switch (blocker) {
    case 'account_connected':
      return {
        blocker,
        what: 'It comes from a bank or broker connection.',
        todo: 'Accounts from a connection cannot be removed here.',
      };
    case 'account_not_empty':
      return {
        blocker,
        what: `It still has ${plural(counts.transactions, 'transaction')} (split parts and hidden ones count too).`,
        todo: 'Undo the import that brought them in (Import, then its history), or delete hand-entered cash entries one at a time from their detail. Then check again.',
      };
    case 'account_in_use': {
      const list = usedBy(counts);
      return {
        blocker,
        what: list.length
          ? `Other records still point at it: ${joinAnd(list)}.`
          : 'Other records still point at it.',
        todo: 'Remove them or point them at another account first. Switched-off rules and cancelled recurring items count too.',
      };
    }
    case 'import_in_progress':
      return {
        blocker,
        what: `An import is being saved right now (${plural(counts.savingImports, 'import')} in progress).`,
        todo: 'Wait for it to finish, then check again.',
      };
    case 'account_delete_too_large':
      return {
        blocker,
        what: `It has too much attached to remove in one go: ${(
          counts.balanceSnapshots +
          counts.imports +
          counts.savedLayouts
        ).toLocaleString(
          'en-US',
        )} balance readings, import links and saved layouts together, and the limit is 2,000.`,
        todo: 'The app has no way to remove an account this size yet.',
      };
  }
}

/** What an allowed removal does, one sentence per effect. */
export function removalEffects(preview: AccountDeletionPreview): string[] {
  const out: string[] = ['The account itself is removed. There is no undo.'];
  if (preview.removes.balanceSnapshots)
    out.push(
      `${plural(preview.removes.balanceSnapshots, 'saved balance reading')} for it ${preview.removes.balanceSnapshots === 1 ? 'is' : 'are'} removed, so net worth history no longer includes it.`,
    );
  if (preview.removes.manualBalance) out.push('The balance you entered by hand is removed.');
  if (preview.detaches.imports)
    out.push(
      `${plural(preview.detaches.imports, 'import')} that used it ${preview.detaches.imports === 1 ? 'keeps' : 'keep'} the file and its history, but no longer ${preview.detaches.imports === 1 ? 'points' : 'point'} at an account.`,
    );
  if (preview.detaches.savedLayouts)
    out.push(
      `${plural(preview.detaches.savedLayouts, 'saved file layout')} no longer ${preview.detaches.savedLayouts === 1 ? 'picks' : 'pick'} it as the destination.`,
    );
  out.push('Categories, rules, statements and import history stay.');
  return out;
}

/**
 * Where quick cash entries (and ATM cash) go once this cash account is gone:
 * `before` for the preview, `after` once the Worker removed it. Null for an
 * account that is not cash.
 */
export function quickCashText(
  defaultCash: DefaultCashAfterDeletion | null,
  removed: Pick<Account, 'currency'>,
  accounts: readonly Pick<Account, 'id' | 'name'>[],
  when: 'before' | 'after' = 'before',
): string | null {
  if (!defaultCash) return null;
  const { currency } = removed;
  if (defaultCash.nextAccountId) {
    const next = accounts.find((a) => a.id === defaultCash.nextAccountId);
    const name = next ? `"${next.name}"` : 'another cash account';
    if (when === 'after') return `Quick cash entries in ${currency} now go to ${name}.`;
    return defaultCash.wasDefault
      ? `Quick cash entries in ${currency} go to this account now. After removal they go to ${name}.`
      : `Quick cash entries in ${currency} keep going to ${name}.`;
  }
  if (defaultCash.createsOnNextUse)
    return `No other cash account in ${currency} ${when === 'after' ? 'is' : 'will be'} left. The next quick cash entry in ${currency} makes a new one called "Cash (${currency})".`;
  return null;
}
