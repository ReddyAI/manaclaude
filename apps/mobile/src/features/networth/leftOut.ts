import type { Account, CurrencyCode } from '@manaclaude/shared';

/**
 * Plain words for accounts a total in one currency leaves out because no
 * exchange rate converts their balance. Rates come from the Worker; Settings,
 * Exchange rates fetches new ones.
 */

const REFRESH = 'Refresh rates in Settings, Exchange rates.';

/** For a net worth or savings total: "Leaves out ..." with what to do. */
export function noRateText(accounts: readonly Account[], to: CurrencyCode): string | null {
  const first = accounts[0];
  if (!first) return null;
  if (accounts.length === 1)
    return `Leaves out "${first.name}": there is no ${first.currency} to ${to} exchange rate yet, so it adds nothing. ${REFRESH}`;
  const names = accounts.map((a) => `"${a.name}" (${a.currency})`).join(', ');
  return `Leaves out ${accounts.length} accounts with no exchange rate to ${to}: ${names}. ${REFRESH}`;
}

/** For an Accounts group total. */
export function groupNoRateText(accounts: readonly Account[], to: CurrencyCode): string | null {
  const first = accounts[0];
  if (!first) return null;
  if (accounts.length === 1)
    return `The total leaves out "${first.name}": there is no ${first.currency} to ${to} exchange rate yet.`;
  return `The total leaves out ${accounts.length} accounts with no exchange rate to ${to}.`;
}

/** One short line under the net worth on Home, for anything the number leaves out. */
export function homeLeftOutText(
  unknown: readonly Account[],
  noRate: readonly Account[],
  to: CurrencyCode,
): string | null {
  const count = unknown.length + noRate.length;
  if (count === 0) return null;
  if (count === 1) {
    const u = unknown[0];
    if (u) return `Leaves out "${u.name}": its balance is unknown.`;
    const n = noRate[0]!;
    return `Leaves out "${n.name}": no ${n.currency} to ${to} rate yet.`;
  }
  return `Leaves out ${count} accounts with an unknown balance or no exchange rate. See Net worth.`;
}
