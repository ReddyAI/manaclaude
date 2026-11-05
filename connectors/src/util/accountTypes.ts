import type { AccountSubtype, AccountType } from '@manaclaude/shared';

/**
 * Guess an account type from its name, for aggregators that do not say
 * (SimpleFIN, Lunch Flow, Sophtron). A port of Sure's
 * app/models/simplefin/account_type_mapper.rb with the same keyword lists and
 * the same order of checks.
 */

export interface InferredType {
  type: AccountType;
  subtype: AccountSubtype | null;
  confidence: 'high' | 'low';
}

const RETIREMENT = /\b(401k|401\(k\)|403b|403\(b\)|tsp|ira|roth|retirement)\b/i;
const BROKERAGE = /\bbrokerage\b/i;
const CREDIT_NAME = /\b(credit|card)\b/i;
const CREDIT_BRAND =
  /\b(visa|mastercard|amex|american express|discover|apple card|freedom unlimited|quicksilver)\b/i;
const LOAN = /\b(loan|mortgage|heloc|line of credit|loc)\b/i;
const CHECKING = /\b(checking|chequing|dda|demand deposit)\b/i;
const SAVINGS = /\b(savings|sav|money market|mma|high.yield)\b/i;
const CRYPTO = /\b(bitcoin|btc|ethereum|eth|crypto|cryptocurrency|litecoin|dogecoin|solana)\b/i;
const EXPLICIT: [RegExp, AccountSubtype][] = [
  [/\btraditional\s+ira\b/i, 'ira'],
  [/\broth\s+ira\b/i, 'roth_ira'],
  [/\broth\s+401\(k\)|\broth\s*401k\b/i, 'roth_401k'],
  [/\b401\(k\)|\b401k\b/i, '401k'],
  [/\b529\b/i, '529'],
  [/\bhsa\b|\bhealth\s+savings\s+account\b/i, 'hsa'],
];

export function inferAccountType(input: {
  name: string;
  institution?: string | null;
  balance?: number | null;
  availableBalance?: number | null;
  hasHoldings?: boolean;
}): InferredType {
  const name = input.name;
  for (const [rx, subtype] of EXPLICIT) {
    if (rx.test(name)) {
      return {
        type: subtype === 'hsa' || subtype === '529' ? 'brokerage' : 'retirement',
        subtype,
        confidence: 'high',
      };
    }
  }
  if (CRYPTO.test(name)) return { type: 'crypto', subtype: null, confidence: 'high' };
  if (input.hasHoldings) return { type: 'brokerage', subtype: null, confidence: 'high' };
  if (LOAN.test(name))
    return {
      type: /mortgage/i.test(name) ? 'mortgage' : 'loan',
      subtype: null,
      confidence: 'high',
    };
  if (
    CREDIT_NAME.test(name) ||
    CREDIT_BRAND.test(name) ||
    CREDIT_BRAND.test(input.institution ?? '')
  ) {
    return { type: 'credit_card', subtype: null, confidence: 'high' };
  }
  const bal = input.balance ?? null;
  const avail = input.availableBalance ?? null;
  if (bal !== null && avail !== null && bal < 0 && avail > 0) {
    return { type: 'credit_card', subtype: null, confidence: 'high' };
  }
  if (RETIREMENT.test(name)) {
    return {
      type: BROKERAGE.test(name) ? 'brokerage' : 'retirement',
      subtype: null,
      confidence: 'high',
    };
  }
  if (CHECKING.test(name)) return { type: 'checking', subtype: null, confidence: 'high' };
  if (SAVINGS.test(name)) {
    return {
      type: 'savings',
      subtype: /money market|mma/i.test(name) ? 'money_market' : null,
      confidence: 'high',
    };
  }
  if (/^\s*cash\s*$/i.test(name)) return { type: 'checking', subtype: null, confidence: 'high' };
  return { type: 'checking', subtype: null, confidence: 'low' };
}

/**
 * Liability balance in the model's "owed is positive" form. Port of Sure's
 * normalize_liability_balance: when balance and available balance have the same
 * sign the bank is reporting owed money its own way, otherwise a card balance
 * reported as negative is a debt.
 */
export function normalizeLiabilityBalance(
  observed: number,
  balance: number,
  available: number,
): number {
  if (balance !== 0 && available !== 0 && Math.sign(balance) === Math.sign(available)) {
    return balance > 0 ? -Math.abs(observed) : Math.abs(observed);
  }
  return -observed;
}
