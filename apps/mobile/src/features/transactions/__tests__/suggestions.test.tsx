import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { FinanceDataset, Transaction, TransferLink } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { useLookups } from '../../../data/selectors';
import { getFinance } from '../../../data/store';
import { goTo } from '../../planning/navigate';
import { PossibleTransfersScreen } from '../PossibleTransfersScreen';
import { TransactionDetailSheet } from '../TransactionDetailSheet';
import { TransactionsScreen } from '../TransactionsScreen';
import {
  applyConfirmTransfer,
  applyRejectSuggestion,
  openSuggestions,
  suggestionsFor,
} from '../transfers';
import { goLive } from './live';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
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
jest.mock('../../planning/navigate', () => ({ goTo: jest.fn(), goBack: jest.fn() }));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/**
 * Sample data with one payment out of checking and two possible arrivals,
 * stored the way the Worker's matcher stores them: two "suggested" links and
 * no transfer_link_id on any of the three transactions. All invented.
 */
function withSuggestions(): {
  data: FinanceDataset;
  out: Transaction;
  a: TransferLink;
  b: TransferLink;
} {
  const base = createSampleData();
  const free = base.transactions.filter(
    (t) => !t.transferLinkId && !t.isSplitParent && !t.splitParentId && t.currency === 'USD',
  );
  const out = free.find((t) => t.accountId === 'acc_checking' && t.amount < 0)!;
  const [in1, in2] = free.filter((t) => t.accountId !== 'acc_checking').slice(0, 2) as [
    Transaction,
    Transaction,
  ];
  const arrive = (t: Transaction, name: string): Transaction => ({
    ...t,
    amount: -out.amount,
    date: out.date,
    name,
  });
  const link = (id: string, into: Transaction, score: number): TransferLink => ({
    id,
    outTransactionId: out.id,
    inTransactionId: into.id,
    outAmount: -out.amount,
    outCurrency: 'USD',
    inAmount: -out.amount,
    inCurrency: 'USD',
    impliedRate: 1,
    status: 'suggested',
    kind: 'transfer',
    matchScore: score,
    matchedBy: 'matcher',
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  });
  const a = link('tl_sug_a', in1, 1);
  const b = link('tl_sug_b', in2, 0.95);
  const data: FinanceDataset = {
    ...base,
    transactions: base.transactions.map((t) =>
      t.id === in1.id ? arrive(t, 'Deposit one') : t.id === in2.id ? arrive(t, 'Deposit two') : t,
    ),
    transferLinks: [...base.transferLinks, b, a],
  };
  return { data, out, a, b };
}

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
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
  jest.clearAllMocks();
});

describe('suggested transfers in the Worker’s shape', () => {
  it('are found by the pair’s ids, best match first, from either side', () => {
    const { data, out, a, b } = withSuggestions();
    expect(suggestionsFor(data.transferLinks, out.id).map((l) => l.id)).toEqual([a.id, b.id]);
    expect(suggestionsFor(data.transferLinks, a.inTransactionId).map((l) => l.id)).toEqual([a.id]);
    expect(openSuggestions(data)).toEqual([{ outTransactionId: out.id, links: [a, b] }]);
    // A pair whose other side is not in the data on this device cannot be shown or decided.
    const partial = {
      ...data,
      transactions: data.transactions.filter((t) => t.id !== b.inTransactionId),
    };
    expect(openSuggestions(partial)).toEqual([{ outTransactionId: out.id, links: [a] }]);
  });

  it('turning one down marks only that pair, and changes nothing else', () => {
    const { data, out, a, b } = withSuggestions();
    const after = applyRejectSuggestion(data, b.id, 'now');
    expect(after.transferLinks.find((l) => l.id === b.id)!.status).toBe('rejected');
    expect(after.transferLinks.find((l) => l.id === a.id)!.status).toBe('suggested');
    expect(after.transactions.find((t) => t.id === out.id)).toEqual(
      data.transactions.find((t) => t.id === out.id),
    );
  });

  it('confirming one points both sides at it and drops the other suggestion, as the Worker does', () => {
    const { data, out, a, b } = withSuggestions();
    const after = applyConfirmTransfer(data, a.id, 'now');
    expect(after.transferLinks.find((l) => l.id === a.id)!.status).toBe('confirmed');
    expect(after.transferLinks.some((l) => l.id === b.id)).toBe(false);
    expect(after.transactions.find((t) => t.id === out.id)!.transferLinkId).toBe(a.id);
    expect(after.transactions.find((t) => t.id === a.inTransactionId)!.transferLinkId).toBe(a.id);
  });

  it('shows on the transaction, and "Not this one" sends the reject route for that pair only', async () => {
    const { data, out, a, b } = withSuggestions();
    backend = await goLive(data, {
      [`POST /v1/transfer-links/${b.id}/reject`]: () =>
        json(200, { link: { ...b, status: 'rejected' } }),
    });
    await render(<Detail id={out.id} />);
    expect(screen.getByTestId(`suggestion-${a.id}`)).toBeTruthy();
    expect(screen.getByTestId(`suggestion-${b.id}`)).toBeTruthy();
    expect(screen.getByText('Looks like a transfer: 2 possible matches')).toBeTruthy();
    await press(`reject-transfer-${b.id}`);
    await waitFor(() =>
      expect(backend!.sent(`POST /v1/transfer-links/${b.id}/reject`)).toHaveLength(1),
    );
    expect(backend.calls.some((c) => c.path.endsWith('/unlink'))).toBe(false);
    expect(screen.queryByTestId(`suggestion-${b.id}`)).toBeNull();
    expect(screen.getByTestId(`suggestion-${a.id}`)).toBeTruthy();
    expect(screen.getByText('Not a transfer')).toBeTruthy();
  });

  it('"Confirm" sends the confirm route and the pair shows as one transfer', async () => {
    const { data, out, a } = withSuggestions();
    backend = await goLive(data, {
      [`POST /v1/transfer-links/${a.id}/confirm`]: () =>
        json(200, { link: { ...a, status: 'confirmed' } }),
    });
    await render(<Detail id={out.id} />);
    await press(`confirm-transfer-${a.id}`);
    await waitFor(() =>
      expect(backend!.sent(`POST /v1/transfer-links/${a.id}/confirm`)).toHaveLength(1),
    );
    expect(await screen.findByTestId('unlink-transfer')).toBeTruthy();
  });

  it('are listed together, reached from Transactions', async () => {
    const { data, out, a, b } = withSuggestions();
    backend = await goLive(data, {
      [`POST /v1/transfer-links/${a.id}/reject`]: () =>
        json(200, { link: { ...a, status: 'rejected' } }),
    });
    const list = await render(<TransactionsScreen />);
    await press('open-possible-transfers');
    expect(goTo).toHaveBeenCalledWith('/transactions/transfers');
    expect(screen.getByText('Possible transfers · 1')).toBeTruthy();
    await list.unmount();
    await render(<PossibleTransfersScreen />);
    expect(screen.getByTestId(`possible-${out.id}`)).toBeTruthy();
    await press(`reject-transfer-${a.id}`);
    await waitFor(() =>
      expect(backend!.sent(`POST /v1/transfer-links/${a.id}/reject`)).toHaveLength(1),
    );
    expect(getFinance().transferLinks.find((l) => l.id === a.id)!.status).toBe('rejected');
    expect(screen.getByTestId(`suggestion-${b.id}`)).toBeTruthy();
  });

  it('the list says so when there is nothing to check', async () => {
    backend = await goLive(createSampleData());
    await render(<PossibleTransfersScreen />);
    expect(screen.getByText('Nothing to check')).toBeTruthy();
  });
});
