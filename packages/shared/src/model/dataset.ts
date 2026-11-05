import type { Account, BalanceSnapshot } from './account';
import type { CategoryBudget, Goal } from './budget';
import type { Category, CategoryGroup, Tag } from './category';
import type { Connection } from './connector';
import type { FxRate } from './fx';
import type { Holding, InvestmentActivity, PricePoint, Security, TaxLot } from './investment';
import type { Receipt } from './receipt';
import type { RecurringItem } from './recurring';
import type { Rule } from './rule';
import type { Settings } from './settings';
import type { Merchant, Transaction, TransferLink } from './transaction';

/**
 * Everything the app knows about Sankar's money. The sample data and, later,
 * the backend's sync endpoint both produce this shape.
 */
export interface FinanceDataset {
  accounts: Account[];
  balanceHistory: BalanceSnapshot[];
  transactions: Transaction[];
  transferLinks: TransferLink[];
  categoryGroups: CategoryGroup[];
  categories: Category[];
  tags: Tag[];
  merchants: Merchant[];
  rules: Rule[];
  budgets: CategoryBudget[];
  goals: Goal[];
  recurring: RecurringItem[];
  securities: Security[];
  holdings: Holding[];
  taxLots: TaxLot[];
  activities: InvestmentActivity[];
  prices: PricePoint[];
  receipts: Receipt[];
  fxRates: FxRate[];
  connections: Connection[];
  /** Free slots used per connector id (lifetime caps keep counting after a delete). */
  connectorSlotsUsed: Record<string, number>;
  settings: Settings;
}
