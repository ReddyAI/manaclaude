import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { summarizeSpending, validateSplit, type FinanceDataset } from '@manaclaude/shared';
import { buildLookups } from '../../../data/selectors';
import { getFinance } from '../../../data/store';
import { setReceiptItems, splitTransaction, undoSplit } from '../actions';
import { buildItemSplitLines } from '../receiptSplit';
import { SplitByItemsSheet } from '../SplitByItemsSheet';
import { resetFinance, txnById } from './helpers';

jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

function receiptOf(data: FinanceDataset, id: string) {
  const r = data.receipts.find((x) => x.id === id);
  if (!r) throw new Error(`no receipt ${id}`);
  return r;
}

function monthSpend(data: FinanceDataset): number {
  const lookups = buildLookups(data);
  const today = new Date().toISOString().slice(0, 10);
  return summarizeSpending(data.transactions, lookups.treatment, {
    from: '2020-01-01',
    to: today,
    currency: 'USD',
    rates: data.fxRates,
  }).spending;
}

describe('split by items', () => {
  beforeEach(() => {
    resetFinance();
  });

  it('one category is not a split', () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    const plan = buildItemSplitLines(dinner, receiptOf(data, 'rcp_tandoori').lineItems);
    expect(plan.ok).toBe(false);
  });

  it('spreads tax and tip so the lines add up to the card charge exactly', () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    expect(dinner.amount).toBe(-6_840);
    const items = receiptOf(data, 'rcp_tandoori').lineItems; // items add up to 5,290
    const plan = buildItemSplitLines(dinner, items, { li_4: 'cat_coffee' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines.reduce((s, l) => s + l.amount, 0)).toBe(-6_840);
    expect(plan.lines.every((l) => l.amount < 0)).toBe(true);
    expect(validateSplit(dinner, plan.lines)).toEqual({ ok: true });
  });

  it('writes the parent and children together, with children matching the lines', () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    const before = monthSpend(data);
    expect(before).toBeGreaterThan(0);
    const plan = buildItemSplitLines(dinner, receiptOf(data, 'rcp_tandoori').lineItems, {
      li_4: 'cat_coffee',
    });
    if (!plan.ok) throw new Error(plan.error);

    expect(splitTransaction(dinner.id, plan.lines, 'k1')).toBeNull();
    const after = getFinance();
    const parent = txnById(after, dinner.id);
    const children = after.transactions.filter((t) => t.splitParentId === dinner.id);
    expect(parent.isSplitParent).toBe(true);
    expect(children).toHaveLength(2);
    expect(children.reduce((s, c) => s + c.amount, 0)).toBe(parent.amount);
    expect(children.map((c) => c.categoryId).sort()).toEqual(['cat_coffee', 'cat_dining']);
    // The parent leaves reports and the children take its place: nothing is counted twice.
    expect(monthSpend(after)).toBe(before);
  });

  it('a second tap does not add a second set of children', () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    const plan = buildItemSplitLines(dinner, receiptOf(data, 'rcp_tandoori').lineItems, {
      li_4: 'cat_coffee',
    });
    if (!plan.ok) throw new Error(plan.error);
    splitTransaction(dinner.id, plan.lines, 'same-key');
    const count = getFinance().transactions.length;
    expect(splitTransaction(dinner.id, plan.lines, 'same-key')).toMatch(/already split/);
    expect(getFinance().transactions).toHaveLength(count);
  });

  it('undo removes the children and the parent counts again', () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    const before = monthSpend(data);
    const plan = buildItemSplitLines(dinner, receiptOf(data, 'rcp_tandoori').lineItems, {
      li_4: 'cat_coffee',
    });
    if (!plan.ok) throw new Error(plan.error);
    splitTransaction(dinner.id, plan.lines);
    undoSplit(dinner.id);
    const after = getFinance();
    expect(txnById(after, dinner.id).isSplitParent).toBe(false);
    expect(after.transactions.some((t) => t.splitParentId === dinner.id)).toBe(false);
    expect(after.transactions).toHaveLength(data.transactions.length);
    expect(monthSpend(after)).toBe(before);
  });

  it('rebuilds the Costco split from its receipt: groceries and household', () => {
    const data = getFinance();
    undoSplit('txn_costco');
    const costco = txnById(getFinance(), 'txn_costco');
    const plan = buildItemSplitLines(costco, receiptOf(data, 'rcp_costco').lineItems);
    if (!plan.ok) throw new Error(plan.error);
    const byCategory = Object.fromEntries(plan.lines.map((l) => [l.categoryId, l.amount]));
    expect(byCategory).toEqual({ cat_groceries: -15_012, cat_household: -6_424 });
  });

  it('refuses a pending purchase and a linked transfer', () => {
    const data = getFinance();
    const pending = data.transactions.find((t) => t.pending && t.amount < 0);
    const link = data.transferLinks[0];
    if (!pending || !link) throw new Error('sample missing rows');
    const items = receiptOf(data, 'rcp_costco').lineItems;
    expect(buildItemSplitLines(pending, items, { li_c1: 'cat_dining' }).ok).toBe(false);
    expect(
      buildItemSplitLines(txnById(data, link.outTransactionId), items, { li_c1: 'cat_dining' }).ok,
    ).toBe(false);
  });

  it('the sheet lets the person add an item, change its category and split', async () => {
    const data = getFinance();
    const dinner = txnById(data, 'txn_tandoori');
    const Harness = () => {
      const receipt = getFinance().receipts.find((r) => r.id === 'rcp_tandoori')!;
      return <SplitByItemsSheet txn={dinner} receipt={receipt} visible onClose={() => {}} />;
    };
    const view = await render(<Harness />);
    expect(screen.getByTestId('split-problem')).toBeTruthy();
    expect(screen.getByTestId('split-confirm').props.accessibilityState?.disabled).toBe(true);

    // Items are added through the store; re-render picks them up.
    await act(() =>
      setReceiptItems('rcp_tandoori', [
        ...receiptOf(getFinance(), 'rcp_tandoori').lineItems,
        {
          id: 'li_x',
          description: 'Gift card',
          quantity: '1',
          amount: 1_000,
          categoryId: 'cat_gifts',
        },
      ]),
    );
    await view.rerender(<Harness />);
    expect(screen.getAllByTestId('split-line')).toHaveLength(2);

    await fireEvent.press(screen.getByTestId('split-confirm'));
    const after = getFinance();
    expect(txnById(after, 'txn_tandoori').isSplitParent).toBe(true);
    const children = after.transactions.filter((t) => t.splitParentId === 'txn_tandoori');
    expect(children.reduce((s, c) => s + c.amount, 0)).toBe(-6_840);
  });
});
