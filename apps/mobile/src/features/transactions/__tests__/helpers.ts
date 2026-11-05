import type { FinanceDataset, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setFinance } from '../../../data/store';

/** Fresh sample data in the store for every test. */
export function resetFinance(): FinanceDataset {
  const data = createSampleData();
  setFinance(data);
  return data;
}

export function txnById(data: FinanceDataset, id: string): Transaction {
  const t = data.transactions.find((x) => x.id === id);
  if (!t) throw new Error(`no transaction ${id}`);
  return t;
}
