import {
  buildTreatmentContext,
  todayLocal,
  type Account,
  type Category,
  type FinanceDataset,
  type Merchant,
  type TransferLink,
  type TreatmentContext,
} from '@manaclaude/shared';
import { useSettings } from './settingsStore';
import { useFinanceSelector } from './store';

export interface Lookups {
  accountsById: ReadonlyMap<string, Account>;
  categoriesById: ReadonlyMap<string, Category>;
  merchantsById: ReadonlyMap<string, Merchant>;
  linksById: ReadonlyMap<string, TransferLink>;
  treatment: TreatmentContext;
}

export function buildLookups(data: FinanceDataset, policies = data.settings.moneyPolicies): Lookups {
  return {
    accountsById: new Map(data.accounts.map((a) => [a.id, a])),
    categoriesById: new Map(data.categories.map((c) => [c.id, c])),
    merchantsById: new Map(data.merchants.map((m) => [m.id, m])),
    linksById: new Map(data.transferLinks.map((l) => [l.id, l])),
    treatment: buildTreatmentContext(policies, data.categories, data.transferLinks),
  };
}

/** Id maps and the report-treatment context, using the user's money policies. */
export function useLookups(): Lookups {
  const { moneyPolicies } = useSettings();
  return useFinanceSelector((d) => buildLookups(d, moneyPolicies), [moneyPolicies]);
}

/** Today's date on this device ("2026-11-04"). */
export function useToday(): string {
  return todayLocal();
}
