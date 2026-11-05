import type {
  Account,
  BalanceSnapshot,
  Category,
  CategoryBudget,
  CategoryGroup,
  Connection,
  FxRate,
  Goal,
  Holding,
  InvestmentActivity,
  Merchant,
  PricePoint,
  Receipt,
  RecurringItem,
  Rule,
  Security,
  Tag,
  TaxLot,
  Transaction,
  TransferLink,
} from '@manaclaude/shared';
import { defineTable } from './table';

export const accountsTable = defineTable<Account>({
  name: 'accounts',
  key: ['id'],
  columns: {
    id: 'text',
    name: 'text',
    institutionName: 'text',
    type: 'text',
    subtype: 'text',
    currency: 'text',
    balance: 'int',
    balanceAsOf: 'text',
    availableBalance: 'int',
    creditLimit: 'int',
    mask: 'text',
    connectionId: 'text',
    externalId: 'text',
    includeInNetWorth: 'bool',
    hidden: 'bool',
    isDefaultCash: 'bool',
    interestRate: 'text',
    openedOn: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const balanceSnapshotsTable = defineTable<BalanceSnapshot>({
  name: 'balance_snapshots',
  key: ['accountId', 'date'],
  columns: { accountId: 'text', date: 'text', balance: 'int', currency: 'text' },
});

export const transactionsTable = defineTable<Transaction>({
  name: 'transactions',
  key: ['id'],
  columns: {
    id: 'text',
    accountId: 'text',
    date: 'text',
    amount: 'int',
    currency: 'text',
    originalAmount: 'int',
    originalCurrency: 'text',
    name: 'text',
    rawName: 'text',
    merchantId: 'text',
    categoryId: 'text',
    categorySource: 'text',
    aiCategoryConfidence: 'real',
    kind: 'text',
    pending: 'bool',
    notes: 'text',
    tagIds: 'json',
    excluded: 'bool',
    transferLinkId: 'text',
    receiptId: 'text',
    recurringId: 'text',
    splitParentId: 'text',
    isSplitParent: 'bool',
    reviewed: 'bool',
    reviewedAt: 'text',
    userEditedFields: 'json',
    source: 'text',
    connectionId: 'text',
    externalId: 'text',
    pendingExternalId: 'text',
    importId: 'text',
    importFingerprint: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const transferLinksTable = defineTable<TransferLink>({
  name: 'transfer_links',
  key: ['id'],
  columns: {
    id: 'text',
    outTransactionId: 'text',
    inTransactionId: 'text',
    outAmount: 'int',
    outCurrency: 'text',
    inAmount: 'int',
    inCurrency: 'text',
    impliedRate: 'real',
    status: 'text',
    kind: 'text',
    matchScore: 'real',
    matchedBy: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const categoryGroupsTable = defineTable<CategoryGroup>({
  name: 'category_groups',
  key: ['id'],
  columns: { id: 'text', name: 'text', kind: 'text', order: 'int' },
});

export const categoriesTable = defineTable<Category>({
  name: 'categories',
  key: ['id'],
  columns: {
    id: 'text',
    name: 'text',
    groupId: 'text',
    kind: 'text',
    icon: 'text',
    color: 'text',
    excludeFromBudget: 'bool',
    archived: 'bool',
    order: 'int',
  },
});

export const tagsTable = defineTable<Tag>({
  name: 'tags',
  key: ['id'],
  columns: { id: 'text', name: 'text', color: 'text' },
});

export const merchantsTable = defineTable<Merchant>({
  name: 'merchants',
  key: ['id'],
  columns: { id: 'text', name: 'text', defaultCategoryId: 'text', aliases: 'json' },
});

export const rulesTable = defineTable<Rule>({
  name: 'rules',
  key: ['id'],
  columns: {
    id: 'text',
    name: 'text',
    enabled: 'bool',
    priority: 'int',
    match: 'text',
    conditions: 'json',
    actions: 'json',
    source: 'text',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const budgetsTable = defineTable<CategoryBudget>({
  name: 'budgets',
  key: ['id'],
  columns: {
    id: 'text',
    categoryId: 'text',
    month: 'text',
    amount: 'int',
    currency: 'text',
    rollover: 'bool',
    flexType: 'text',
  },
});

export const goalsTable = defineTable<Goal>({
  name: 'goals',
  key: ['id'],
  columns: {
    id: 'text',
    name: 'text',
    kind: 'text',
    targetAmount: 'int',
    currency: 'text',
    targetDate: 'text',
    accountIds: 'json',
    manualProgress: 'int',
    color: 'text',
  },
});

export const recurringTable = defineTable<RecurringItem>({
  name: 'recurring_items',
  key: ['id'],
  columns: {
    id: 'text',
    name: 'text',
    merchantId: 'text',
    categoryId: 'text',
    accountId: 'text',
    kind: 'text',
    frequency: 'text',
    expectedAmount: 'int',
    currency: 'text',
    isVariable: 'bool',
    lastDate: 'text',
    nextDueDate: 'text',
    status: 'text',
    decision: 'text',
    priceHistory: 'json',
    detectedBy: 'text',
    aiConfidence: 'real',
  },
});

export const securitiesTable = defineTable<Security>({
  name: 'securities',
  key: ['id'],
  columns: {
    id: 'text',
    symbol: 'text',
    name: 'text',
    type: 'text',
    exchange: 'text',
    currency: 'text',
    isin: 'text',
    assetClass: 'text',
    isBenchmark: 'bool',
  },
});

export const holdingsTable = defineTable<Holding>({
  name: 'holdings',
  key: ['id'],
  columns: {
    id: 'text',
    accountId: 'text',
    securityId: 'text',
    quantity: 'text',
    price: 'text',
    priceAsOf: 'text',
    marketValue: 'int',
    costBasis: 'int',
    currency: 'text',
    source: 'text',
  },
});

export const taxLotsTable = defineTable<TaxLot>({
  name: 'tax_lots',
  key: ['id'],
  columns: {
    id: 'text',
    holdingId: 'text',
    acquiredOn: 'text',
    quantity: 'text',
    costBasis: 'int',
    currency: 'text',
    source: 'text',
    externalId: 'text',
  },
});

export const activitiesTable = defineTable<InvestmentActivity>({
  name: 'investment_activities',
  key: ['id'],
  columns: {
    id: 'text',
    accountId: 'text',
    securityId: 'text',
    type: 'text',
    date: 'text',
    quantity: 'text',
    price: 'text',
    amount: 'int',
    fees: 'int',
    currency: 'text',
    splitRatio: 'text',
    externalId: 'text',
    source: 'text',
  },
});

export const pricesTable = defineTable<PricePoint>({
  name: 'prices',
  key: ['securityId', 'date'],
  columns: { securityId: 'text', date: 'text', close: 'text', currency: 'text' },
});

// localUri is a path on the phone and is never stored in D1.
export const receiptsTable = defineTable<Omit<Receipt, 'localUri'>>({
  name: 'receipts',
  key: ['id'],
  columns: {
    id: 'text',
    r2Key: 'text',
    merchant: 'text',
    date: 'text',
    total: 'int',
    subtotal: 'int',
    tax: 'int',
    tip: 'int',
    currency: 'text',
    lineItems: 'json',
    matchedTransactionId: 'text',
    status: 'text',
    aiConfidence: 'real',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const fxRatesTable = defineTable<FxRate>({
  name: 'fx_rates',
  key: ['base', 'quote', 'date', 'source'],
  columns: {
    base: 'text',
    quote: 'text',
    rate: 'real',
    asOf: 'text',
    date: 'text',
    source: 'text',
  },
});

export const connectionsTable = defineTable<Connection>({
  name: 'connections',
  key: ['id'],
  columns: {
    id: 'text',
    connectorId: 'text',
    institutionName: 'text',
    status: 'text',
    lastSyncAt: 'text',
    lastSuccessfulSyncAt: 'text',
    lastError: 'text',
    syncCursor: 'text',
    accountIds: 'json',
    createdAt: 'text',
    updatedAt: 'text',
  },
});

export const ALL_MODEL_TABLES = [
  accountsTable,
  balanceSnapshotsTable,
  transactionsTable,
  transferLinksTable,
  categoryGroupsTable,
  categoriesTable,
  tagsTable,
  merchantsTable,
  rulesTable,
  budgetsTable,
  goalsTable,
  recurringTable,
  securitiesTable,
  holdingsTable,
  taxLotsTable,
  activitiesTable,
  pricesTable,
  receiptsTable,
  fxRatesTable,
  connectionsTable,
] as const;
