import { normalizeDescription, type Category, type Id } from '@manaclaude/shared';

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
