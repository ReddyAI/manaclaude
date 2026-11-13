import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Category } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { canSaveToBackend } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { categoriesStore } from '../actions';
import { CategoriesScreen } from '../CategoriesScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../data/backend/sync', () => ({
  canSaveToBackend: jest.fn(() => true),
  scheduleRefresh: jest.fn(),
}));
const live = canSaveToBackend as jest.Mock;

/** Invented categories in the shape GET /v1/categories sends; the groups are the sample data's. */
const cat = (id: string, name: string, patch: Partial<Category> = {}): Category => ({
  id,
  name,
  groupId: 'grp_food',
  kind: 'expense',
  icon: 'utensils',
  color: 'c2',
  excludeFromBudget: false,
  archived: false,
  order: 10,
  ...patch,
});
const LIST: Category[] = [
  cat('cat_groceries', 'Groceries', { order: 10 }),
  cat('cat_dining', 'Dining out', { order: 20 }),
  cat('cat_coffee', 'Coffee', { order: 30 }),
  cat('cat_old', 'Snacks', { archived: true, order: 40 }),
  cat('cat_pay', 'Paycheck', { groupId: 'grp_income', kind: 'income', order: 0 }),
];

const GET = 'GET /v1/categories';
const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: ReturnType<typeof fakeBackend>;

/** A Worker that lists LIST and answers PATCH and POST the way the route does. */
function worker(extra: Parameters<typeof fakeBackend>[0] = {}) {
  const store = new Map(LIST.map((c) => [c.id, { ...c }]));
  const patch = (id: string) => (call: { body: unknown }) => {
    const next = { ...store.get(id)!, ...(call.body as Partial<Category>) };
    store.set(id, next);
    return json(200, { category: next });
  };
  backend = fakeBackend({
    [GET]: () => json(200, { categories: [...store.values()] }),
    'POST /v1/categories': (call) =>
      json(201, {
        category: { id: 'cat_new', archived: false, order: 999, ...(call.body as object) },
      }),
    ...Object.fromEntries(LIST.map((c) => [`PATCH /v1/categories/${c.id}`, patch(c.id)])),
    ...extra,
  });
  return backend;
}

async function open() {
  await render(<CategoriesScreen />);
  await waitFor(() => expect(screen.getByTestId('category-row-cat_groceries')).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  live.mockReturnValue(true);
  categoriesStore.reset();
  const data = createSampleData();
  setFinance({ ...data, categories: LIST });
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('categories screen', () => {
  it('asks for the backend first and sends nothing without one', async () => {
    worker();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<CategoriesScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
    expect(backend.calls).toHaveLength(0);
  });

  it("lists the Worker's categories by group, in order, with the archived ones apart", async () => {
    worker();
    await open();
    expect(backend.sent(GET)).toHaveLength(1);
    const food = screen.getByTestId('category-group-grp_food');
    expect(food).toBeTruthy();
    expect(screen.getByTestId('category-group-grp_income')).toBeTruthy();
    expect(screen.getByTestId('category-archived')).toBeTruthy();
    expect(screen.getByTestId('category-restore-cat_old')).toBeTruthy();
    expect(screen.queryByTestId('category-up-cat_old')).toBeNull();
    // First and last of a group cannot move further.
    expect(screen.getByTestId('category-up-cat_groceries').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(screen.getByTestId('category-down-cat_coffee').props.accessibilityState.disabled).toBe(
      true,
    );
  });

  it('renames with a PATCH holding only the trimmed name, and pickers see it', async () => {
    worker();
    await open();
    await press('category-row-cat_dining');
    await fireEvent.changeText(screen.getByTestId('category-name'), '  Restaurants ');
    await press('category-save-name');
    await waitFor(() => expect(screen.getByTestId('category-notice')).toBeTruthy());
    const sent = backend.sent('PATCH /v1/categories/cat_dining');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ name: 'Restaurants' });
    expect(categoriesStore.get().value!.find((c) => c.id === 'cat_dining')!.name).toBe(
      'Restaurants',
    );
    expect(getFinance().categories.find((c) => c.id === 'cat_dining')!.name).toBe('Restaurants');
  });

  it('does not send a name the group already has', async () => {
    worker();
    await open();
    await press('category-row-cat_dining');
    await fireEvent.changeText(screen.getByTestId('category-name'), 'coffee');
    expect(screen.getByText('This group already has "Coffee".')).toBeTruthy();
    await press('category-save-name');
    expect(backend.sent('PATCH /v1/categories/cat_dining')).toHaveLength(0);
  });

  it('leaves a category out of budgets, archives it and brings it back', async () => {
    worker();
    await open();
    await press('category-row-cat_coffee');
    await press('category-budget');
    await waitFor(() =>
      expect(backend.sent('PATCH /v1/categories/cat_coffee')[0]?.body).toEqual({
        excludeFromBudget: true,
      }),
    );
    await press('category-archive');
    await waitFor(() => expect(screen.getByTestId('category-restore-cat_coffee')).toBeTruthy());
    expect(backend.sent('PATCH /v1/categories/cat_coffee')[1]!.body).toEqual({ archived: true });
    expect(getFinance().categories.find((c) => c.id === 'cat_coffee')!.archived).toBe(true);
    await press('category-restore-cat_coffee');
    await waitFor(() => expect(screen.getByTestId('category-up-cat_coffee')).toBeTruthy());
    expect(backend.sent('PATCH /v1/categories/cat_coffee')[2]!.body).toEqual({ archived: false });
  });

  it('moves a category with one PATCH of its order per category that changes', async () => {
    worker();
    await open();
    await press('category-down-cat_groceries');
    await waitFor(() => expect(backend.sent('PATCH /v1/categories/cat_dining')).toHaveLength(1));
    expect(backend.sent('PATCH /v1/categories/cat_groceries')[0]!.body).toEqual({ order: 20 });
    expect(backend.sent('PATCH /v1/categories/cat_dining')[0]!.body).toEqual({ order: 10 });
    expect(backend.sent('PATCH /v1/categories/cat_coffee')).toHaveLength(0);
    await waitFor(() =>
      expect(screen.getByTestId('category-up-cat_dining').props.accessibilityState.disabled).toBe(
        true,
      ),
    );
  });

  it('shows the Worker refusing a change and loads the list again', async () => {
    worker({
      'PATCH /v1/categories/cat_dining': () =>
        json(400, { error: 'invalid_body', message: 'order: Expected integer' }),
    });
    await open();
    await press('category-down-cat_groceries');
    await waitFor(() => expect(screen.getByTestId('categories-problem')).toBeTruthy());
    expect(screen.getByText('order: Expected integer')).toBeTruthy();
    // The first PATCH was refused, so the second is never sent.
    expect(backend.sent('PATCH /v1/categories/cat_dining')).toHaveLength(1);
    expect(backend.sent('PATCH /v1/categories/cat_groceries')).toHaveLength(0);
    await waitFor(() => expect(backend.sent(GET)).toHaveLength(2));
  });

  it('adds a category to an existing group with exactly what POST takes', async () => {
    worker();
    await open();
    await press('category-add');
    await fireEvent.changeText(screen.getByTestId('category-add-name'), ' Bakery ');
    await press('category-add-group-grp_food');
    expect(screen.getByTestId('category-add-kind').props.children).toBe(
      'Kind: Spending, as the group.',
    );
    await press('category-add-icon-coffee');
    await press('category-add-budget');
    await press('category-add-save');
    await waitFor(() => expect(screen.getByTestId('category-row-cat_new')).toBeTruthy());
    const sent = backend.sent('POST /v1/categories');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      name: 'Bakery',
      groupId: 'grp_food',
      kind: 'expense',
      icon: 'coffee',
      color: 'c1',
      excludeFromBudget: true,
      order: 31,
    });
    expect(getFinance().categories.some((c) => c.id === 'cat_new')).toBe(true);
  });

  it('adds once for a fast double tap', async () => {
    worker();
    await open();
    await press('category-add');
    await fireEvent.changeText(screen.getByTestId('category-add-name'), 'Bakery');
    await press('category-add-group-grp_food');
    await act(async () => {
      fireEvent.press(screen.getByTestId('category-add-save'));
      fireEvent.press(screen.getByTestId('category-add-save'));
    });
    await waitFor(() => expect(screen.getByTestId('category-row-cat_new')).toBeTruthy());
    expect(backend.sent('POST /v1/categories')).toHaveLength(1);
  });

  it('offers no adding while the data on screen is not this backend’s', async () => {
    worker();
    live.mockReturnValue(false);
    await open();
    await press('category-add');
    expect(screen.getByTestId('category-add-not-loaded')).toBeTruthy();
    expect(screen.queryByTestId('category-add-save')).toBeNull();
  });

  it('does not change sample data when a change is saved', async () => {
    worker();
    live.mockReturnValue(false);
    await open();
    await press('category-row-cat_dining');
    await fireEvent.changeText(screen.getByTestId('category-name'), 'Restaurants');
    await press('category-save-name');
    await waitFor(() => expect(screen.getByTestId('category-notice')).toBeTruthy());
    expect(getFinance().categories.find((c) => c.id === 'cat_dining')!.name).toBe('Dining out');
  });

  it('drops the list when the backend changes, and ignores an answer for the old one', async () => {
    const slow = held();
    let n = 0;
    worker({
      [GET]: () => {
        n += 1;
        return n === 1 ? slow.promise : json(200, { categories: [cat('cat_other', 'Bakery')] });
      },
    });
    await render(<CategoriesScreen />);
    await act(async () => {
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' });
      await settle();
    });
    await waitFor(() => expect(screen.getByTestId('category-row-cat_other')).toBeTruthy());
    await act(async () => {
      slow.release(200, { categories: LIST });
      await settle();
    });
    expect(screen.queryByTestId('category-row-cat_groceries')).toBeNull();
    expect(categoriesStore.get().value!.map((c) => c.id)).toEqual(['cat_other']);
    expect(backend.sent(GET)[1]!.token).toBe('Bearer other-token');
  });
});
