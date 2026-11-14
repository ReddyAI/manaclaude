import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { FinanceDataset, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { getBackendStatus, resetBackendForTests } from '../../../data/backend/sync';
import { useLookups } from '../../../data/selectors';
import { getFinance } from '../../../data/store';
import { TransactionDetailSheet } from '../TransactionDetailSheet';
import { goLive } from './live';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    create() {}
    write() {}
    delete() {}
    async text() {
      return '';
    }
  },
  Paths: { document: '/doc' },
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

function Detail({ id }: { id: string }) {
  const lookups = useLookups();
  return (
    <TransactionDetailSheet
      txn={lookups.transactionsById.get(id) ?? null}
      lookups={lookups}
      onClose={() => {}}
    />
  );
}

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const pick = (data: FinanceDataset, f: (t: Transaction) => boolean) => data.transactions.find(f)!;
let backend: Awaited<ReturnType<typeof goLive>>;

/** A Worker that answers PATCH like the route: the fields sent, each marked as edited. */
function patchHandler(data: FinanceDataset) {
  return (call: { path: string; body: unknown }) => {
    const id = call.path.split('/').pop()!;
    const t = data.transactions.find((x) => x.id === id)!;
    const body = call.body as Partial<Transaction>;
    return json(200, {
      transaction: {
        ...t,
        ...body,
        userEditedFields: [...new Set([...t.userEditedFields, ...Object.keys(body)])],
      },
    });
  };
}

afterEach(() => {
  backend?.restore();
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

describe('editing a transaction', () => {
  it('sends one PATCH with only the changed fields, and the screen shows them', async () => {
    const data = createSampleData();
    const t = pick(
      data,
      (x) => x.amount < 0 && !x.transferLinkId && !x.isSplitParent && !x.splitParentId,
    );
    backend = await goLive(data, { [`PATCH /v1/transactions/${t.id}`]: patchHandler(data) });
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    await fireEvent.changeText(screen.getByTestId('edit-name'), ' Team lunch ');
    await fireEvent.changeText(screen.getByTestId('edit-amount'), '42.50');
    await press('edit-tag-tag_reimbursable');
    await press('edit-excluded');
    await press('edit-save');
    await waitFor(() => expect(backend.sent(`PATCH /v1/transactions/${t.id}`)).toHaveLength(1));
    expect(backend.sent(`PATCH /v1/transactions/${t.id}`)[0]!.body).toEqual({
      name: 'Team lunch',
      amount: -42_50,
      tagIds: ['tag_reimbursable'],
      excluded: true,
    });
    const after = getFinance().transactions.find((x) => x.id === t.id)!;
    expect(after).toMatchObject({ name: 'Team lunch', amount: -42_50, excluded: true });
    expect(after.userEditedFields).toEqual(
      expect.arrayContaining(['name', 'amount', 'tagIds', 'excluded']),
    );
    expect(screen.getByText('Left out of reports')).toBeTruthy();
    expect(screen.getAllByText('Tags').length).toBeGreaterThan(1);
  });

  it('sends nothing when nothing changed, and nothing while a field is wrong', async () => {
    const data = createSampleData();
    const t = pick(data, (x) => !x.transferLinkId && !x.isSplitParent && !x.splitParentId);
    backend = await goLive(data, { [`PATCH /v1/transactions/${t.id}`]: patchHandler(data) });
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    expect(screen.getByTestId('edit-save').props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByTestId('edit-date'), '2026-02-30');
    await press('edit-save');
    expect(screen.getByText('Use a real date written as YYYY-MM-DD.')).toBeTruthy();
    await settle();
    expect(backend.sent(`PATCH /v1/transactions/${t.id}`)).toHaveLength(0);
  });

  it('undoes the edit on screen when the Worker refuses it', async () => {
    const data = createSampleData();
    const t = pick(data, (x) => !x.transferLinkId && !x.isSplitParent && !x.splitParentId);
    backend = await goLive(data, {
      [`PATCH /v1/transactions/${t.id}`]: () =>
        json(400, { error: 'bad_request', message: 'Undo the split before changing the amount.' }),
    });
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    await fireEvent.changeText(screen.getByTestId('edit-name'), 'Changed');
    await press('edit-save');
    await waitFor(() => expect(getBackendStatus().error).toMatch(/Not saved \(edit\)/));
    expect(getFinance().transactions.find((x) => x.id === t.id)!.name).toBe(t.name);
  });

  it('offers no amount or kind on a linked transfer', async () => {
    const data = createSampleData();
    const t = pick(data, (x) => x.transferLinkId !== null);
    backend = await goLive(data);
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    expect(screen.getByTestId('edit-amount-locked')).toBeTruthy();
    expect(screen.getByTestId('edit-kind-locked')).toBeTruthy();
    expect(screen.queryByTestId('edit-amount')).toBeNull();
  });

  it('offers only name and notes on a split whole', async () => {
    const data = createSampleData();
    const t = pick(data, (x) => !x.transferLinkId && !x.isSplitParent && !x.splitParentId);
    const whole = { ...t, isSplitParent: true };
    const withWhole = {
      ...data,
      transactions: data.transactions.map((x) => (x.id === t.id ? whole : x)),
    };
    backend = await goLive(withWhole);
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    expect(screen.getByTestId('edit-split-whole')).toBeTruthy();
    expect(screen.queryByTestId('edit-date')).toBeNull();
    expect(screen.queryByTestId('edit-excluded')).toBeNull();
    expect(screen.getByTestId('edit-notes')).toBeTruthy();
  });

  it('opens with what the transaction holds now, not a form left from before', async () => {
    const data = createSampleData();
    const t = pick(data, (x) => !x.transferLinkId && !x.isSplitParent && !x.splitParentId);
    backend = await goLive(data, { [`PATCH /v1/transactions/${t.id}`]: patchHandler(data) });
    await render(<Detail id={t.id} />);
    await press('edit-transaction');
    await fireEvent.changeText(screen.getByTestId('edit-name'), 'Typed but not saved');
    await press('edit-cancel');
    await act(async () => settle());
    await press('edit-transaction');
    expect(screen.getByTestId('edit-name').props.value).toBe(t.name);
  });
});
