import type { Category } from '../model/category';
import type { Id, MinorUnits } from '../model/common';
import type { MoneyPolicies } from '../model/settings';
import type { Transaction, TransferLink, TransferLinkKind } from '../model/transaction';
import { ACTIVE_TRANSFER_LINK_STATUSES } from '../model/transaction';

/**
 * How one transaction counts in spending and income reports. This is the one
 * place that decides it, so the dashboard, budgets, recaps and the MCP server
 * all agree (research/sure/rea.md checks 1 and 5).
 */
export type ReportTreatment =
  | { kind: 'spending'; reason: TreatmentReason }
  | { kind: 'income'; reason: TreatmentReason }
  | { kind: 'excluded'; reason: TreatmentReason };

export type TreatmentReason =
  | 'excluded_by_user'
  | 'split_parent'
  | 'pending_excluded'
  | 'linked_transfer'
  | 'transfer'
  | 'card_payment'
  | 'loan_principal'
  | 'investment_contribution'
  | 'transfer_category'
  | 'purchase'
  | 'refund'
  | 'refund_as_income'
  | 'income'
  | 'zero';

export interface TreatmentContext {
  policies: MoneyPolicies;
  categoriesById: ReadonlyMap<Id, Category>;
  transferLinksById: ReadonlyMap<Id, TransferLink>;
}

export function buildTreatmentContext(
  policies: MoneyPolicies,
  categories: readonly Category[],
  transferLinks: readonly TransferLink[],
): TreatmentContext {
  return {
    policies,
    categoriesById: new Map(categories.map((c) => [c.id, c])),
    transferLinksById: new Map(transferLinks.map((l) => [l.id, l])),
  };
}

/** Which money policy governs a linked pair of this kind. */
export function linkPolicy(kind: TransferLinkKind, policies: MoneyPolicies): 'exclude' | 'count' {
  switch (kind) {
    case 'card_payment':
      return policies.cardPayments;
    case 'investment_contribution':
      return policies.investmentContributions;
    case 'loan_payment':
      return policies.loanPrincipal;
    case 'transfer':
    case 'atm_withdrawal':
      return policies.transfers;
  }
}

const LINK_REASON: Record<TransferLinkKind, TreatmentReason> = {
  transfer: 'transfer',
  atm_withdrawal: 'transfer',
  card_payment: 'card_payment',
  investment_contribution: 'investment_contribution',
  loan_payment: 'loan_principal',
};

function countedKind(txn: Transaction, reason: TreatmentReason): ReportTreatment {
  return txn.amount < 0 ? { kind: 'spending', reason } : { kind: 'income', reason };
}

export function reportTreatment(txn: Transaction, ctx: TreatmentContext): ReportTreatment {
  const { policies } = ctx;
  if (txn.excluded) return { kind: 'excluded', reason: 'excluded_by_user' };
  if (txn.isSplitParent) return { kind: 'excluded', reason: 'split_parent' };
  if (txn.pending && policies.pendingTransactions === 'exclude') {
    return { kind: 'excluded', reason: 'pending_excluded' };
  }
  if (txn.amount === 0) return { kind: 'excluded', reason: 'zero' };

  // Linked pairs are excluded from spending and income everywhere, unless the
  // policy for that kind of link says "count": then the side where money left
  // counts as spending and the receiving side stays out (it isn't income).
  if (txn.transferLinkId) {
    const link = ctx.transferLinksById.get(txn.transferLinkId);
    if (link && ACTIVE_TRANSFER_LINK_STATUSES.includes(link.status)) {
      const policy = linkPolicy(link.kind, policies);
      if (policy === 'count' && link.outTransactionId === txn.id) {
        return { kind: 'spending', reason: LINK_REASON[link.kind] };
      }
      return { kind: 'excluded', reason: 'linked_transfer' };
    }
  }

  switch (txn.kind) {
    case 'transfer':
      return policies.transfers === 'exclude'
        ? { kind: 'excluded', reason: 'transfer' }
        : countedKind(txn, 'transfer');
    case 'card_payment':
      return policies.cardPayments === 'exclude'
        ? { kind: 'excluded', reason: 'card_payment' }
        : countedKind(txn, 'card_payment');
    case 'loan_payment':
      return policies.loanPrincipal === 'exclude'
        ? { kind: 'excluded', reason: 'loan_principal' }
        : countedKind(txn, 'loan_principal');
    case 'investment_contribution':
      return policies.investmentContributions === 'exclude'
        ? { kind: 'excluded', reason: 'investment_contribution' }
        : countedKind(txn, 'investment_contribution');
    case 'regular':
      break;
  }

  const category = txn.categoryId ? ctx.categoriesById.get(txn.categoryId) : undefined;
  if (category?.kind === 'transfer') return { kind: 'excluded', reason: 'transfer_category' };

  if (txn.amount < 0) return { kind: 'spending', reason: 'purchase' };

  // Money in. A positive amount in an expense category is a refund.
  if (category?.kind === 'expense') {
    return policies.refunds === 'reduce_category'
      ? { kind: 'spending', reason: 'refund' }
      : { kind: 'income', reason: 'refund_as_income' };
  }
  return { kind: 'income', reason: 'income' };
}

/**
 * Spending contribution of a transaction: positive for a purchase, negative
 * for a refund, 0 when it doesn't count as spending.
 */
export function spendingAmount(txn: Transaction, ctx: TreatmentContext): MinorUnits {
  const t = reportTreatment(txn, ctx);
  return t.kind === 'spending' ? -txn.amount : 0;
}

/** Income contribution: positive for income, 0 otherwise. */
export function incomeAmount(txn: Transaction, ctx: TreatmentContext): MinorUnits {
  const t = reportTreatment(txn, ctx);
  return t.kind === 'income' ? txn.amount : 0;
}
