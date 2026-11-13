import type { Category, CategoryGroup } from '@manaclaude/shared';
import { freeColor, moveOrders, nameProblem, orderAtEnd, sectionCategories } from '../categories';

/** Invented categories in the shape GET /v1/categories sends. */
const cat = (id: string, patch: Partial<Category> = {}): Category => ({
  id,
  name: id.replace('cat_', ''),
  groupId: 'grp_food',
  kind: 'expense',
  icon: 'tag',
  color: 'c1',
  excludeFromBudget: false,
  archived: false,
  order: 0,
  ...patch,
});
const GROUPS: CategoryGroup[] = [
  { id: 'grp_food', name: 'Food', kind: 'expense', order: 2 },
  { id: 'grp_income', name: 'Income', kind: 'income', order: 0 },
  { id: 'grp_empty', name: 'Pets', kind: 'expense', order: 5 },
];

describe('sectionCategories', () => {
  it('lists groups in their order, empty ones too, then the archived categories', () => {
    const { sections, archived } = sectionCategories(
      [
        cat('cat_b', { order: 2 }),
        cat('cat_a', { order: 1 }),
        cat('cat_pay', { groupId: 'grp_income', kind: 'income' }),
        cat('cat_old', { archived: true }),
      ],
      GROUPS,
    );
    expect(sections.map((s) => s.title)).toEqual(['Income', 'Food', 'Pets']);
    expect(sections[1]!.active.map((c) => c.id)).toEqual(['cat_a', 'cat_b']);
    expect(sections[2]!.active).toEqual([]);
    expect(archived.map((c) => c.id)).toEqual(['cat_old']);
  });

  it('puts a category whose group is not on this device under its own section, closed to adding', () => {
    const { sections } = sectionCategories([cat('cat_x', { groupId: 'grp_gone' })], GROUPS);
    const other = sections.find((s) => s.groupId === 'grp_gone')!;
    expect(other).toMatchObject({ title: 'Other group', known: false, kind: null });
    expect(other.active.map((c) => c.id)).toEqual(['cat_x']);
  });
});

describe('moveOrders', () => {
  const list = [
    cat('cat_a', { order: 10 }),
    cat('cat_b', { order: 20 }),
    cat('cat_c', { order: 30 }),
  ];

  it('swaps the two values when a category moves one place', () => {
    expect(moveOrders(list, 'cat_b', -1)).toEqual([
      { id: 'cat_b', order: 10 },
      { id: 'cat_a', order: 20 },
    ]);
    expect(moveOrders(list, 'cat_b', 1)).toEqual([
      { id: 'cat_c', order: 20 },
      { id: 'cat_b', order: 30 },
    ]);
  });

  it('does nothing at either end or for an unknown id', () => {
    expect(moveOrders(list, 'cat_a', -1)).toEqual([]);
    expect(moveOrders(list, 'cat_c', 1)).toEqual([]);
    expect(moveOrders(list, 'cat_x', 1)).toEqual([]);
  });

  it('still moves categories that share one value (new ones get 999)', () => {
    const tied = [
      cat('cat_a', { order: 5 }),
      cat('cat_n1', { order: 999 }),
      cat('cat_n2', { order: 999 }),
    ];
    const changes = moveOrders(tied, 'cat_n2', -1);
    expect(changes).toEqual([{ id: 'cat_n1', order: 1000 }]);
    // Applied, the moved category comes first.
    const after = tied.map((c) => ({
      ...c,
      order: changes.find((x) => x.id === c.id)?.order ?? c.order,
    }));
    const sorted = [...after].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    expect(sorted.map((c) => c.id)).toEqual(['cat_a', 'cat_n2', 'cat_n1']);
  });
});

describe('a new category', () => {
  it('goes after the others in its group', () => {
    expect(orderAtEnd([cat('a', { order: 3 }), cat('b', { order: 7 })])).toBe(8);
    expect(orderAtEnd([])).toBeUndefined();
  });

  it('gets a colour the group does not use yet', () => {
    expect(freeColor([cat('a', { color: 'c1' }), cat('b', { color: 'c2' })])).toBe('c3');
  });
});

describe('nameProblem', () => {
  const all = [
    cat('cat_a', { name: 'Groceries' }),
    cat('cat_old', { name: 'Snacks', archived: true }),
  ];

  it('needs a name of at most 60 characters after trimming', () => {
    expect(nameProblem('   ', all, 'grp_food')).toBe('Type a name.');
    expect(nameProblem('x'.repeat(61), all, 'grp_food')).toMatch(/at most 60/);
    expect(nameProblem(` ${'x'.repeat(60)} `, all, 'grp_food')).toBeNull();
  });

  it('refuses a name the group already has, pointing to an archived one', () => {
    expect(nameProblem('groceries ', all, 'grp_food')).toMatch(/already has "Groceries"/);
    expect(nameProblem('snacks', all, 'grp_food')).toMatch(/archived.*Bring it back/);
    expect(nameProblem('Groceries', all, 'grp_income')).toBeNull();
    expect(nameProblem('Groceries', all, 'grp_food', 'cat_a')).toBeNull();
  });
});
