import type { Tag, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { amountText, applyEdit, checkEdit, draftFrom, editLocks, isRealDate } from '../edit';

const data = createSampleData();
const plain = data.transactions.find(
  (t) =>
    t.amount < 0 &&
    !t.transferLinkId &&
    !t.isSplitParent &&
    !t.splitParentId &&
    t.currency === 'USD' &&
    t.originalCurrency === 'USD',
)!;
const TAGS: Tag[] = [
  { id: 'tag_a', name: 'Alpha', color: 'c1' },
  { id: 'tag_b', name: 'Beta', color: 'c2' },
];
const TODAY = '2026-11-14';
const txn = (patch: Partial<Transaction> = {}): Transaction => ({
  ...plain,
  date: '2026-11-01',
  amount: -12_34,
  originalAmount: -12_34,
  name: 'Corner Cafe',
  notes: null,
  tagIds: [],
  excluded: false,
  kind: 'regular',
  userEditedFields: [],
  ...patch,
});
const check = (t: Transaction, patch: Partial<ReturnType<typeof draftFrom>>) =>
  checkEdit(t, { ...draftFrom(t), ...patch }, TODAY, TAGS);

describe('the edit form', () => {
  it('starts from the transaction, with the size of the amount and its direction', () => {
    expect(draftFrom(txn())).toMatchObject({ amount: '12.34', direction: 'out', notes: '' });
    expect(draftFrom(txn({ amount: 5_00_000 })).direction).toBe('in');
    expect(amountText(-5, 'USD')).toBe('0.05');
    expect(amountText(1_00_000_00, 'INR')).toBe('100000.00');
  });

  it('sends nothing when nothing changed', () => {
    expect(check(txn(), {}).patch).toEqual({});
  });

  it('sends only the fields that changed', () => {
    expect(check(txn(), { name: '  Corner Café  ', notes: ' team lunch ' }).patch).toEqual({
      name: 'Corner Café',
      notes: 'team lunch',
    });
    expect(check(txn({ notes: 'x' }), { notes: '  ' }).patch).toEqual({ notes: null });
    expect(check(txn(), { kind: 'card_payment', excluded: true }).patch).toEqual({
      kind: 'card_payment',
      excluded: true,
    });
  });

  it('turns the amount into signed minor units by direction', () => {
    expect(check(txn(), { amount: '1,250.5' }).patch).toEqual({ amount: -1_250_50 });
    expect(check(txn(), { direction: 'in' }).patch).toEqual({ amount: 12_34 });
    expect(check(txn(), { amount: '12.340' }).problems.amount).toMatch(/at most 2 decimals/);
    expect(check(txn(), { amount: '-5' }).problems.amount).toMatch(/without a sign/);
    expect(check(txn(), { amount: '0' }).problems.amount).toBe('The amount cannot be zero.');
    expect(check(txn(), { amount: '' }).patch).toBeNull();
  });

  it('takes only real dates up to today', () => {
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(check(txn(), { date: '2026-02-30' }).problems.date).toMatch(/real date/);
    expect(check(txn(), { date: '2026-11-15' }).problems.date).toBe('The date is after today.');
    expect(check(txn(), { date: '2026-11-14' }).patch).toEqual({ date: '2026-11-14' });
  });

  it('needs a name of 1 to 200 characters', () => {
    expect(check(txn(), { name: ' ' }).problems.name).toBe('Type a name.');
    expect(check(txn(), { name: 'x'.repeat(201) }).problems.name).toMatch(/at most 200/);
  });

  it('sends tags as a set, in the app’s order, keeping tags this device does not know', () => {
    const t = txn({ tagIds: ['tag_zz', 'tag_b'] });
    expect(check(t, { tagIds: ['tag_b', 'tag_zz'] }).patch).toEqual({});
    expect(check(t, { tagIds: ['tag_zz', 'tag_b', 'tag_a'] }).patch).toEqual({
      tagIds: ['tag_a', 'tag_b', 'tag_zz'],
    });
  });
});

describe('what the Worker would refuse is not offered', () => {
  it('no amount on a linked transfer or part of a split, and no kind on a linked transfer', () => {
    const linked = txn({ transferLinkId: 'tl_1' });
    expect(editLocks(linked).amount).toMatch(/Unlink/);
    expect(check(linked, { amount: '99', kind: 'card_payment', direction: 'in' }).patch).toEqual(
      {},
    );
    const part = txn({ splitParentId: 'txn_whole' });
    expect(editLocks(part)).toMatchObject({ splitWhole: false, kind: null });
    expect(check(part, { amount: '99', kind: 'transfer' }).patch).toEqual({ kind: 'transfer' });
  });

  it('only name and notes on a split whole', () => {
    const whole = txn({ isSplitParent: true });
    expect(
      check(whole, {
        name: 'Groceries run',
        date: '2026-10-01',
        amount: '1',
        excluded: true,
        tagIds: ['tag_a'],
      }).patch,
    ).toEqual({ name: 'Groceries run' });
  });
});

describe('applyEdit', () => {
  it('changes the fields and marks each one as edited by hand', () => {
    const after = applyEdit(
      txn({ userEditedFields: ['categoryId'] }),
      { name: 'X', amount: -5_00 },
      '2026-11-14T00:00:00.000Z',
    );
    expect(after).toMatchObject({ name: 'X', amount: -5_00, originalAmount: -5_00 });
    expect(after.userEditedFields).toEqual(['categoryId', 'name', 'amount']);
  });

  it('keeps the amount charged in another currency', () => {
    const t = txn({ originalCurrency: 'EUR', originalAmount: -11_00 });
    expect(applyEdit(t, { amount: -20_00 }, 'now').originalAmount).toBe(-11_00);
  });
});
