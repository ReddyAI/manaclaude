import type {
  CategoriesResponse,
  Category,
  CategoryPatchRequest,
  CategoryResponse,
  CreateCategoryRequest,
} from '@manaclaude/shared';
import { api } from '../../data/backend/client';

/** GET /v1/categories: every category, archived ones included. */
export async function listCategories(): Promise<Category[]> {
  return (await api<CategoriesResponse>('GET', '/v1/categories')).categories;
}

/** POST /v1/categories: a new category in an existing group. */
export async function createCategory(req: CreateCategoryRequest): Promise<Category> {
  return (await api<CategoryResponse>('POST', '/v1/categories', req)).category;
}

/**
 * PATCH /v1/categories/:id. The Worker takes only name, archived,
 * excludeFromBudget and order, and refuses any other key.
 */
export async function patchCategory(id: string, patch: CategoryPatchRequest): Promise<Category> {
  return (await api<CategoryResponse>('PATCH', `/v1/categories/${encodeURIComponent(id)}`, patch))
    .category;
}
