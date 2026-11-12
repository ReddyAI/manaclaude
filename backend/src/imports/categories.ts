import {
  normalizeDescription,
  type Category,
  type CategoryGroup,
  type Id,
  type ImportPreviewRow,
} from '@manaclaude/shared';
import { newId } from '../util/ids';

/**
 * Finds the category a file's label means: exact name first, then one name
 * starting with the other ("Gifts" -> "Gifts & family"), then a shared first
 * word. Transfer categories are only matched exactly.
 */
export function categoryMatcher(
  categories: readonly Category[],
): (label: string | null) => Id | null {
  const active = categories.filter((c) => !c.archived);
  const norm = active.map((c) => ({ c, n: normalizeDescription(c.name) }));
  const cache = new Map<string, Id | null>();
  return (label) => {
    if (!label) return null;
    const key = normalizeDescription(label);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key)!;
    const exact = norm.find((x) => x.n === key);
    const prefix = norm.filter(
      (x) => x.c.kind !== 'transfer' && (x.n.startsWith(`${key} `) || key.startsWith(`${x.n} `)),
    );
    const first = key.split(' ')[0]!;
    const word = norm.filter(
      (x) => x.c.kind !== 'transfer' && first.length > 3 && x.n.split(' ')[0] === first,
    );
    const found =
      exact?.c.id ??
      (prefix.length === 1 ? prefix[0]!.c.id : null) ??
      (word.length === 1 ? word[0]!.c.id : null);
    cache.set(key, found);
    return found;
  };
}

/** Monefy labels are user data: preserve them exactly instead of fuzzy matching. */
export function monefyCategories(
  rows: ImportPreviewRow[],
  existing: readonly Category[],
): { groups: CategoryGroup[]; categories: Category[] } {
  const groups: CategoryGroup[] = [];
  const categories: Category[] = [];
  const byName = new Map(existing.filter((c) => !c.archived).map((c) => [c.name, c]));
  for (const row of rows) {
    const name = row.categoryName;
    if (!name) continue;
    let category = byName.get(name);
    if (!category) {
      // A positive refund keeps the category's expense treatment when the file
      // also contains expenses under that label. No transfer inference by amount.
      const kind = rows.some((r) => r.categoryName === name && r.amount < 0) ? 'expense' : 'income';
      let group = groups.find((g) => g.kind === kind);
      if (!group) {
        group = { id: newId('grp'), name: `Monefy ${kind}`, kind, order: 1000 + groups.length };
        groups.push(group);
      }
      category = {
        id: newId('cat'),
        name,
        kind,
        groupId: group.id,
        icon: 'tag',
        color: 'c1',
        excludeFromBudget: false,
        archived: false,
        order: 1000 + categories.length,
      };
      categories.push(category);
      byName.set(name, category);
    }
    row.categoryId = category.id;
  }
  return { groups, categories };
}
