import {
  COLOR_SLOTS,
  type Category,
  type CategoryGroup,
  type CategoryIcon,
  type CategoryKind,
  type ColorSlot,
} from '@manaclaude/shared';

/** The Worker takes names of 1 to 60 characters. */
export const CATEGORY_NAME_MAX = 60;

/** Icons offered for a new category: every key the app can draw. */
export const CATEGORY_ICONS = [
  'tag',
  'home',
  'utensils',
  'shopping-cart',
  'coffee',
  'car',
  'fuel',
  'bus',
  'plane',
  'heart-pulse',
  'pill',
  'film',
  'music',
  'gamepad',
  'zap',
  'wifi',
  'phone',
  'gift',
  'book',
  'graduation-cap',
  'briefcase',
  'banknote',
  'trending-up',
  'percent',
  'landmark',
  'piggy-bank',
  'repeat',
  'credit-card',
  'shield',
  'shopping-bag',
  'shirt',
  'scissors',
  'dumbbell',
  'paw-print',
  'baby',
  'wrench',
  'receipt',
  'globe',
  'sparkles',
  'circle',
] as const satisfies readonly CategoryIcon[];

export const KIND_LABEL: Record<CategoryKind, string> = {
  expense: 'Spending',
  income: 'Income',
  transfer: 'Transfers (never spending or income)',
};

/** The order the Worker keeps, with the name and id to settle ties the same way every time. */
export function compareCategories(a: Category, b: Category): number {
  return a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

export interface CategorySection {
  groupId: string;
  title: string;
  kind: CategoryKind | null;
  /** False when the group is not in the data on this device: nothing can be added to it. */
  known: boolean;
  /** Categories in use, in their order. */
  active: Category[];
}

/**
 * Categories in use by group, in the groups' order, then the archived ones.
 * Every known group is listed, empty ones too, so a category can be added to
 * it. A category whose group is not in the data on this device is listed
 * under its own section with a plain title.
 */
export function sectionCategories(
  categories: readonly Category[],
  groups: readonly CategoryGroup[],
): { sections: CategorySection[]; archived: Category[] } {
  const sorted = [...categories].sort(compareCategories);
  const sections: CategorySection[] = [...groups]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((g) => ({ groupId: g.id, title: g.name, kind: g.kind, known: true, active: [] }));
  const byGroup = new Map(sections.map((s) => [s.groupId, s]));
  for (const c of sorted) {
    if (c.archived) continue;
    let section = byGroup.get(c.groupId);
    if (!section) {
      section = { groupId: c.groupId, title: 'Other group', kind: null, known: false, active: [] };
      byGroup.set(c.groupId, section);
      sections.push(section);
    }
    section.active.push(c);
  }
  return { sections, archived: sorted.filter((c) => c.archived) };
}

/**
 * The `order` values to send so that `id` moves one place up (-1) or down (1)
 * inside its group. Only categories whose value changes are listed. The
 * group keeps the values it already used, made strictly increasing, so
 * categories that shared one value (a new category gets 999) still move.
 */
export function moveOrders(
  active: readonly Category[],
  id: string,
  direction: -1 | 1,
): { id: string; order: number }[] {
  const list = [...active].sort(compareCategories);
  const from = list.findIndex((c) => c.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return [];
  const moved = [...list];
  [moved[from], moved[to]] = [moved[to]!, moved[from]!];
  const values = list.map((c) => c.order);
  const out: { id: string; order: number }[] = [];
  let previous = -Infinity;
  moved.forEach((c, i) => {
    const order = Math.max(values[i]!, previous + 1);
    previous = order;
    if (order !== c.order) out.push({ id: c.id, order });
  });
  return out;
}

/** The `order` for a new category: after every other one in its group. */
export function orderAtEnd(active: readonly Category[]): number | undefined {
  if (active.length === 0) return undefined;
  return Math.max(...active.map((c) => c.order)) + 1;
}

/** A colour no category in the group uses yet, else the first. */
export function freeColor(active: readonly Category[]): ColorSlot {
  const used = new Set(active.map((c) => c.color));
  return COLOR_SLOTS.find((s) => !used.has(s)) ?? 'c1';
}

/**
 * Why a name cannot be used, or null. Names are trimmed. A name already
 * used in the same group (archived categories included) is refused, so two
 * categories never look the same in a list.
 */
export function nameProblem(
  name: string,
  categories: readonly Category[],
  groupId: string,
  exceptId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Type a name.';
  if (trimmed.length > CATEGORY_NAME_MAX)
    return `Use at most ${CATEGORY_NAME_MAX} characters (${trimmed.length} now).`;
  const same = categories.find(
    (c) =>
      c.id !== exceptId &&
      c.groupId === groupId &&
      c.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  if (same)
    return same.archived
      ? `"${same.name}" is archived in this group. Bring it back from Archived instead.`
      : `This group already has "${same.name}".`;
  return null;
}
