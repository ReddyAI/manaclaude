import type { Category, Transaction, TransferLink } from '../src';

let seq = 0;

/** Minimal transaction for tests; override what the test is about. */
export function txn(overrides: Partial<Transaction> & Pick<Transaction, 'amount'>): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    accountId: 'acc_checking',
    date: '2026-10-15',
    currency: 'USD',
    originalAmount: overrides.amount,
    originalCurrency: overrides.currency ?? 'USD',
    name: 'Test',
    rawName: 'TEST',
    merchantId: null,
    categoryId: null,
    categorySource: null,
    aiCategoryConfidence: null,
    kind: 'regular',
    pending: false,
    notes: null,
    tagIds: [],
    excluded: false,
    transferLinkId: null,
    receiptId: null,
    recurringId: null,
    splitParentId: null,
    isSplitParent: false,
    reviewed: false,
    reviewedAt: null,
    userEditedFields: [],
    source: 'manual',
    connectionId: null,
    externalId: null,
    pendingExternalId: null,
    importId: null,
    importFingerprint: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

export function linkOf(
  out: Transaction,
  into: Transaction,
  kind: TransferLink['kind'],
  status: TransferLink['status'] = 'auto',
): TransferLink {
  const id = `tl_${out.id}_${into.id}`;
  out.transferLinkId = id;
  into.transferLinkId = id;
  return {
    id,
    outTransactionId: out.id,
    inTransactionId: into.id,
    outAmount: Math.abs(out.amount),
    outCurrency: out.currency,
    inAmount: Math.abs(into.amount),
    inCurrency: into.currency,
    impliedRate: 1,
    status,
    kind,
    matchScore: 1,
    matchedBy: 'matcher',
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
  };
}

export const CATEGORIES: Category[] = [
  {
    id: 'cat_shopping',
    name: 'Shopping',
    groupId: 'g',
    kind: 'expense',
    icon: 'shopping-bag',
    color: 'c1',
    excludeFromBudget: false,
    archived: false,
    order: 0,
  },
  {
    id: 'cat_dining',
    name: 'Restaurants',
    groupId: 'g',
    kind: 'expense',
    icon: 'utensils',
    color: 'c2',
    excludeFromBudget: false,
    archived: false,
    order: 1,
  },
  {
    id: 'cat_paycheck',
    name: 'Paycheck',
    groupId: 'i',
    kind: 'income',
    icon: 'briefcase',
    color: 'c3',
    excludeFromBudget: false,
    archived: false,
    order: 2,
  },
  {
    id: 'cat_loan_interest',
    name: 'Loan interest',
    groupId: 'g',
    kind: 'expense',
    icon: 'percent',
    color: 'c4',
    excludeFromBudget: false,
    archived: false,
    order: 3,
  },
  {
    id: 'cat_transfer',
    name: 'Transfer',
    groupId: 't',
    kind: 'transfer',
    icon: 'repeat',
    color: 'c5',
    excludeFromBudget: true,
    archived: false,
    order: 4,
  },
];
