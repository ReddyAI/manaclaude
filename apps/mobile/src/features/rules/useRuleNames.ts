import { useFinanceSelector } from '../../data/store';
import type { Names } from './rules';

/** Names for the ids a rule holds, from the data on this device, with a plain fallback. */
export function useRuleNames(): Names {
  return useFinanceSelector((d) => {
    const accounts = new Map(d.accounts.map((a) => [a.id, a.name]));
    const categories = new Map(d.categories.map((c) => [c.id, c.name]));
    const tags = new Map(d.tags.map((t) => [t.id, t.name]));
    return {
      account: (id) => accounts.get(id) ?? 'an account not on this device',
      category: (id) => categories.get(id) ?? 'a category not on this device',
      tag: (id) => tags.get(id) ?? 'a tag not on this device',
    };
  });
}
