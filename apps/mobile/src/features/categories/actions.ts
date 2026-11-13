import type { Category, CategoryPatchRequest, CreateCategoryRequest } from '@manaclaude/shared';
import { createScopedStore } from '../../data/backend/scopedStore';
import { canSaveToBackend } from '../../data/backend/sync';
import { updateFinance } from '../../data/store';
import { createCategory, listCategories, patchCategory } from './categoriesApi';
import { compareCategories, moveOrders } from './categories';

/** The Worker's categories, archived ones included, in memory only. */
export const categoriesStore = createScopedStore(listCategories);

function replace(list: Category[] | null, category: Category): Category[] {
  const rest = (list ?? []).filter((c) => c.id !== category.id);
  return [...rest, category].sort(compareCategories);
}

/**
 * Puts the Worker's copy of a category into the app's data too, so pickers
 * and budgets see a rename or an archive at once. Only when the data on
 * screen is this backend's: sample data is never changed.
 */
function intoDataset(category: Category): void {
  if (!canSaveToBackend()) return;
  updateFinance((d) => ({
    ...d,
    categories: d.categories.some((c) => c.id === category.id)
      ? d.categories.map((c) => (c.id === category.id ? category : c))
      : [...d.categories, category],
  }));
}

export async function addCategory(req: CreateCategoryRequest): Promise<Category> {
  const category = await categoriesStore.mutate(
    () => createCategory(req),
    (list, c) => replace(list, c),
  );
  intoDataset(category);
  return category;
}

export async function changeCategory(id: string, patch: CategoryPatchRequest): Promise<Category> {
  const category = await categoriesStore.mutate(
    () => patchCategory(id, patch),
    (list, c) => replace(list, c),
  );
  intoDataset(category);
  return category;
}

/**
 * Moves a category one place up or down in its group. The Worker has no
 * reorder call, so each category whose `order` changes gets its own PATCH,
 * one after the other. If one fails, the list is loaded again so the screen
 * shows what the Worker really has, and the error is passed on.
 */
export async function moveCategory(
  active: readonly Category[],
  id: string,
  direction: -1 | 1,
): Promise<void> {
  const changes = moveOrders(active, id, direction);
  try {
    for (const c of changes) await changeCategory(c.id, { order: c.order });
  } catch (e) {
    void categoriesStore.load();
    throw e;
  }
}
