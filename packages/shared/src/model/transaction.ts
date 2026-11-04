import type { CurrencyCode, Id, IsoDateTime, LocalDate, MinorUnits, Timestamps } from './common';

/**
 * What a transaction is. Kept separate from whether it counts in budgets
 * (see policy/treatment.ts and Settings.moneyPolicies), as research/sure/rea.md
 * SURE-001 recommends.
 *
 * - regular: income, purchases and refunds
 * - transfer: money moved between two of your own accounts (includes ATM cash)
 * - card_payment: paying a credit card from another account
 * - loan_payment: the principal part of a loan payment (interest is a separate
 *   split line of kind "regular" in an interest category)
 * - investment_contribution: money moved into a brokerage or retirement account
 */
export type TransactionKind =
  | 'regular'
  | 'transfer'
  | 'card_payment'
  | 'loan_payment'
  | 'investment_contribution';

export type TransactionSource = 'manual' | 'connector' | 'import';

/** Who set the category. */
export type CategorySource = 'user' | 'rule' | 'ai' | 'provider' | 'import';

/** Fields a user can edit by hand. Once edited, sync and import never overwrite them. */
export type UserEditableField =
  | 'name'
  | 'date'
  | 'amount'
  | 'categoryId'
  | 'merchantId'
  | 'kind'
  | 'notes'
  | 'tagIds'
  | 'excluded';

export interface Transaction extends Timestamps {
  id: Id;
  accountId: Id;
  /** Posted date, or the authorized date while pending. */
  date: LocalDate;
  /**
   * Signed amount in the account's currency, from the account's point of view:
   * negative = money left the account (purchase, payment sent, transfer out),
   * positive = money came in (paycheck, refund, payment received, transfer in).
   * Credit cards follow the same rule: a purchase is negative, a payment to the
   * card is positive. Connectors must convert provider signs to this rule.
   */
  amount: MinorUnits;
  /** Always the account's currency. */
  currency: CurrencyCode;
  /**
   * The amount as charged by the merchant, same sign as `amount`. Equal to
   * amount/currency unless the purchase was made in another currency
   * (a EUR 42.50 dinner on a USD card).
   */
  originalAmount: MinorUnits;
  originalCurrency: CurrencyCode;
  /** Clean display name ("Whole Foods"). */
  name: string;
  /** Description exactly as the bank sent it. */
  rawName: string;
  merchantId: Id | null;
  categoryId: Id | null;
  categorySource: CategorySource | null;
  /** 0 to 1. How sure the AI was about categoryId; null when the AI didn't set it. */
  aiCategoryConfidence: number | null;
  kind: TransactionKind;
  pending: boolean;
  notes: string | null;
  tagIds: Id[];
  /** Hidden from every report and budget (still shown in the account's list). */
  excluded: boolean;
  /** Set when this transaction is one side of a TransferLink. */
  transferLinkId: Id | null;
  receiptId: Id | null;
  recurringId: Id | null;
  /** Split child: points at the parent it came from. */
  splitParentId: Id | null;
  /** Split parent: keeps its original amount but reports use its children instead. */
  isSplitParent: boolean;
  /** Has the user looked at this transaction in the review queue? */
  reviewed: boolean;
  reviewedAt: IsoDateTime | null;
  /** Fields the user changed by hand (research/sure/rea.md SURE-004). */
  userEditedFields: UserEditableField[];
  source: TransactionSource;
  connectionId: Id | null;
  /** Provider's transaction id. Unique per (accountId, source, externalId). */
  externalId: string | null;
  /** Provider id of the pending transaction this posted one replaces. */
  pendingExternalId: string | null;
  /** File import this row came from. */
  importId: Id | null;
  /**
   * Import identity for files without ids: hash of account, date, amount, raw
   * name and the occurrence number of that combination within the file. Two
   * identical coffees in one file get occurrence 1 and 2, so both are kept, and
   * importing the same file again matches both instead of adding two more.
   */
  importFingerprint: string | null;
}

/**
 * - auto: the matcher linked it (exactly one candidate)
 * - suggested: the matcher found several candidates; waiting for confirmation.
 *   Not counted as linked until confirmed.
 * - confirmed: the user linked it or confirmed a suggestion
 * - rejected: the user unlinked it; the matcher must not propose it again
 */
export type TransferLinkStatus = 'auto' | 'suggested' | 'confirmed' | 'rejected';

export type TransferLinkKind =
  | 'transfer'
  | 'card_payment'
  | 'loan_payment'
  | 'investment_contribution'
  | 'atm_withdrawal';

/** Statuses that make a pair count as one linked item (left out of spending and income). */
export const ACTIVE_TRANSFER_LINK_STATUSES: readonly TransferLinkStatus[] = ['auto', 'confirmed'];

/**
 * The two sides of a transfer between your own accounts, shown once and kept
 * out of spending and income. Cross-currency transfers keep both amounts so the
 * real rate is recorded.
 */
export interface TransferLink extends Timestamps {
  id: Id;
  /** The side where money left (negative amount). */
  outTransactionId: Id;
  /** The side where money arrived (positive amount). */
  inTransactionId: Id;
  /** Positive amount that left, in the source account's currency. */
  outAmount: MinorUnits;
  outCurrency: CurrencyCode;
  /** Positive amount that arrived, in the destination account's currency. */
  inAmount: MinorUnits;
  inCurrency: CurrencyCode;
  /**
   * Units of inCurrency received per 1 unit of outCurrency, in major units
   * (USD 1,000.00 out, INR 88,120.00 in: 88.12). 1 for same-currency pairs.
   */
  impliedRate: number;
  status: TransferLinkStatus;
  kind: TransferLinkKind;
  /** 0 to 1, how good the match was. null for manual links. */
  matchScore: number | null;
  matchedBy: 'matcher' | 'user' | 'connector';
}

/** One line of a split request. Amounts use the parent's sign and currency. */
export interface SplitLineInput {
  amount: MinorUnits;
  categoryId: Id | null;
  name?: string;
  notes?: string;
  tagIds?: Id[];
  kind?: TransactionKind;
}

/**
 * Split one transaction into lines. The lines must add up to the parent amount
 * exactly. `idempotencyKey` stops a double tap from creating two sets of children.
 */
export interface SplitRequest {
  parentTransactionId: Id;
  lines: SplitLineInput[];
  idempotencyKey: string;
}

export interface Merchant {
  id: Id;
  name: string;
  defaultCategoryId: Id | null;
  /** Raw descriptions seen for this merchant, used for cleanup and matching. */
  aliases: string[];
}
