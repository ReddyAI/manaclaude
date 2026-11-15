import type { Account, ImportPreviewRow } from '@manaclaude/shared';
import { bankOwns, effectivePolicy, sourcePeriods, type PolicyState } from './model';

export interface ImportHistoryReview {
  version: number;
  excludedCount: number;
  excludedRows: (ImportPreviewRow & { exclusionReason: 'bank_cutoff' | 'replacement_month' })[];
  excludedTotals: {
    accountId: string;
    currency: string;
    count: number;
    inflow: number;
    outflow: number;
  }[];
  accounts: { accountId: string; periods: ReturnType<typeof sourcePeriods> }[];
}
export function filterMonefyRows(
  rows: ImportPreviewRow[],
  accounts: Account[],
  state: PolicyState,
) {
  const included: ImportPreviewRow[] = [];
  const excluded: ImportHistoryReview['excludedRows'] = [];
  for (const row of rows) {
    const account = accounts.find((a) => a.id === row.accountId);
    if (account && bankOwns(state.policy, account, row.date) === true) {
      const rule = effectivePolicy(state.policy, account)!;
      excluded.push({
        ...row,
        exclusionReason:
          rule.cutoff && row.date >= rule.cutoff ? 'bank_cutoff' : 'replacement_month',
      });
    } else included.push(row);
  }
  const totals = new Map<string, ImportHistoryReview['excludedTotals'][number]>();
  for (const row of excluded) {
    const key = `${row.accountId}:${row.currency}`;
    const t = totals.get(key) ?? {
      accountId: row.accountId!,
      currency: row.currency!,
      count: 0,
      inflow: 0,
      outflow: 0,
    };
    t.count++;
    if (row.amount > 0) t.inflow += row.amount;
    else t.outflow -= row.amount;
    totals.set(key, t);
  }
  const review: ImportHistoryReview = {
    version: state.version,
    excludedCount: excluded.length,
    excludedRows: excluded,
    excludedTotals: [...totals.values()],
    accounts: accounts
      .filter((a) => rows.some((r) => r.accountId === a.id))
      .map((a) => ({ accountId: a.id, periods: sourcePeriods(state.policy, a) })),
  };
  return { rows: included, review };
}
