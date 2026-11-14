import {
  minorDigits,
  parseMoneyInput,
  type Account,
  type CreateCashAccountRequest,
} from '@manaclaude/shared';

/**
 * The form for a new cash account and how it becomes the body of POST
 * /v1/accounts/cash (name 1 to 100 characters, a 3-letter currency, the
 * balance in minor units, and whether quick cash entries in that currency go
 * to it).
 */

export const CASH_NAME_MAX = 100;

export interface CashAccountDraft {
  name: string;
  currency: string;
  /** Cash on hand now, as typed. */
  balance: string;
  isDefault: boolean;
}

/** USD and INR, then any other currency an account uses. */
export function currencyChoices(accounts: readonly Account[]): string[] {
  const others = [...new Set(accounts.map((a) => a.currency))]
    .filter((c) => c !== 'USD' && c !== 'INR')
    .sort();
  return ['USD', 'INR', ...others];
}

/**
 * The cash account quick entries in this currency already go to, if any. The
 * Worker does not take the mark off another account when a new one is made
 * the default, so the form only offers it when there is none.
 */
export function defaultCashFor(accounts: readonly Account[], currency: string): Account | null {
  return (
    accounts.find((a) => a.type === 'cash' && a.currency === currency && a.isDefaultCash) ?? null
  );
}

export interface CashAccountCheck {
  body: CreateCashAccountRequest | null;
  problems: Partial<Record<'name' | 'balance', string>>;
}

export function checkCashAccount(
  draft: CashAccountDraft,
  accounts: readonly Account[],
): CashAccountCheck {
  const problems: CashAccountCheck['problems'] = {};
  const name = draft.name.trim();
  if (!name) problems.name = 'Type a name.';
  else if (name.length > CASH_NAME_MAX)
    problems.name = `Use at most ${CASH_NAME_MAX} characters (${name.length} now).`;
  else if (accounts.some((a) => !a.hidden && a.name.trim().toLowerCase() === name.toLowerCase()))
    problems.name = `You already have an account called "${name}".`;
  const balance = draft.balance.trim() ? parseMoneyInput(draft.balance, draft.currency) : null;
  if (balance === null)
    problems.balance = `Type the cash you hold now, with at most ${minorDigits(draft.currency)} decimals (0 is fine).`;
  else if (balance < 0) problems.balance = 'Cash on hand cannot be below zero.';
  if (Object.keys(problems).length > 0) return { body: null, problems };
  const isDefault = draft.isDefault && defaultCashFor(accounts, draft.currency) === null;
  return {
    body: { name, currency: draft.currency, balance: balance!, isDefault },
    problems,
  };
}
