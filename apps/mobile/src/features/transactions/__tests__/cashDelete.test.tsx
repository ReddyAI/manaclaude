import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { Account, AccountWithManualBalance, FinanceDataset } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { useLookups } from '../../../data/selectors';
import { getFinance, setFinance } from '../../../data/store';
import { applyAddCash, pickCashAccount } from '../cash';
import { cashDeleteCheck, reversedText } from '../cashDelete';
import { TransactionDetailSheet } from '../TransactionDetailSheet';
import { TransactionRoute } from '../TransactionRoute';
import { goLive } from './live';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({ id: mockId }),
}));
let mockId = '';
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
  Directory: class {},
  Paths: { document: '/doc' },
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/** All data is invented. */
function withReceipt(): FinanceDataset {
  const d = createSampleData();
  const kirana = d.transactions.find((t) => t.name === 'Kirana store')!;
  return {
    ...d,
    transactions: d.transactions.map((t) =>
      t.id === kirana.id ? { ...t, receiptId: 'rcp_kirana' } : t,
    ),
    receipts: [
      ...d.receipts,
      {
        ...d.receipts[0]!,
        id: 'rcp_kirana',
        r2Key: 'receipts/rcp_kirana.jpg',
        matchedTransactionId: kirana.id,
        status: 'matched',
      },
    ],
  };
}
const data = withReceipt();
const kirana = data.transactions.find((t) => t.name === 'Kirana store')!;
const wallet = data.accounts.find((a) => a.id === 'acc_cash_inr')!;
const path = `/v1/transactions/${kirana.id}`;

function Sheet({ id }: { id: string }) {
  const lookups = useLookups();
  const txn = getFinance().transactions.find((t) => t.id === id) ?? kirana;
  return <TransactionDetailSheet txn={txn} lookups={lookups} onClose={() => {}} />;
}
const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
});

describe('which cash entries can be deleted', () => {
  const d = createSampleData();
  it('offers a hand-entered cash entry, nothing else', () => {
    expect(cashDeleteCheck(kirana, d)).toEqual({ offer: true });
    const card = d.transactions.find((t) => t.accountId === 'acc_card_cashback')!;
    expect(cashDeleteCheck(card, d)).toEqual({ offer: false, todo: null });
    expect(cashDeleteCheck({ ...kirana, importId: 'imp_1' }, d)).toEqual({
      offer: false,
      todo: null,
    });
    // A hand entry on an account that is not cash (the route only takes cash).
    expect(cashDeleteCheck({ ...kirana, accountId: 'acc_nre' }, d)).toEqual({
      offer: false,
      todo: null,
    });
    // An automatic ATM deposit carries the Worker's own id.
    expect(cashDeleteCheck({ ...kirana, externalId: 'atm:txn_1' }, d).offer).toBe(false);
    const linked = {
      ...d,
      accounts: d.accounts.map((a) => (a.id === wallet.id ? { ...a, connectionId: 'c' } : a)),
    };
    expect(cashDeleteCheck(kirana, linked).offer).toBe(false);
  });

  it('says what to undo first for a split or a transfer, including a suggested one', () => {
    expect(cashDeleteCheck({ ...kirana, isSplitParent: true }, d)).toMatchObject({
      todo: /undo its split/,
    });
    const link = { ...d.transferLinks[0]!, outTransactionId: 'x', inTransactionId: kirana.id };
    expect(
      cashDeleteCheck(kirana, { ...d, transferLinks: [{ ...link, status: 'suggested' }] }),
    ).toMatchObject({ todo: /unlink the transfer/ });
    expect(
      cashDeleteCheck(kirana, { ...d, transferLinks: [{ ...link, status: 'rejected' }] }),
    ).toEqual({ offer: true });
  });

  it('says how the balance moved', () => {
    const acc = { ...wallet, balance: 10_000_00 };
    expect(reversedText(-500_00, acc)).toBe(
      'The cash balance went back up by ₹500.00, to ₹10,000.00.',
    );
    expect(reversedText(200_00, acc)).toMatch(/went down by ₹200.00/);
    expect(reversedText(0, acc)).toMatch(/did not move, because a balance was entered/);
    const unknown: AccountWithManualBalance = {
      ...acc,
      manualBalance: { currentKnown: false, openingBalance: null },
    };
    expect(reversedText(0, unknown)).toMatch(/unknown, so it stays unknown/);
  });
});

describe('deleting a cash entry', () => {
  const after: Account = { ...wallet, balance: wallet.balance + 124_000 };

  it('asks once, sends one DELETE, says how far the balance moved and keeps the receipt', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () =>
        json(200, {
          deletedTransactionId: kirana.id,
          reversedBalanceAmount: -124_000,
          account: after,
        }),
    });
    await render(<Sheet id={kirana.id} />);
    await press('cash-delete-start');
    expect(screen.getByTestId('cash-delete-ask')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('cash-delete-confirm'));
      fireEvent.press(screen.getByTestId('cash-delete-confirm'));
    });
    await settle();
    expect(backend.sent(`DELETE ${path}`)).toHaveLength(1);
    expect(screen.getByTestId('cash-deleted-text').props.children).toBe(
      `Deleted. The cash balance went back up by ₹1,240.00, to ₹${(after.balance / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.`,
    );
    expect(screen.getByTestId('cash-deleted-receipts')).toBeTruthy();
    const now = getFinance();
    expect(now.transactions.some((t) => t.id === kirana.id)).toBe(false);
    expect(now.accounts.find((a) => a.id === wallet.id)!.balance).toBe(after.balance);
    expect(now.receipts.find((r) => r.id === 'rcp_kirana')).toMatchObject({
      matchedTransactionId: null,
      status: 'needs_review',
    });
  });

  it('keeps the result on screen when the entry was opened by its own address', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () =>
        json(200, {
          deletedTransactionId: kirana.id,
          reversedBalanceAmount: -124_000,
          account: after,
        }),
    });
    mockId = kirana.id;
    await render(<TransactionRoute />);
    await press('cash-delete-start');
    await press('cash-delete-confirm');
    await settle();
    expect(screen.getByTestId('cash-deleted-text').props.children).toMatch(/went back up/);
  });

  it('explains a refusal in plain words and deletes nothing', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () =>
        json(409, {
          error: 'cash_balance_unknown',
          message: 'The original balance effect is unknown.',
        }),
    });
    await render(<Sheet id={kirana.id} />);
    await press('cash-delete-start');
    await press('cash-delete-confirm');
    await settle();
    expect(screen.getByTestId('cash-delete-refused').props.children).toMatch(
      /Enter the cash account's balance first/,
    );
    expect(getFinance().transactions.some((t) => t.id === kirana.id)).toBe(true);
  });

  it('after a lost answer reads the entry: still there means not deleted', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () => Promise.reject(new TypeError('Network request failed')),
      [`GET ${path}`]: () => json(200, { transaction: kirana }),
    });
    await render(<Sheet id={kirana.id} />);
    await press('cash-delete-start');
    await press('cash-delete-confirm');
    await settle();
    expect(backend.sent(`GET ${path}`)).toHaveLength(1);
    expect(screen.getByTestId('cash-delete-refused').props.children).toMatch(/still there/);
    expect(backend.sent(`DELETE ${path}`)).toHaveLength(1);
  });

  it('after a lost answer, a 404 means deleted', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () => json(500, { error: 'internal', message: 'Oops.' }),
      [`GET ${path}`]: () => json(404, { error: 'not_found', message: 'Transaction not found.' }),
    });
    await render(<Sheet id={kirana.id} />);
    await press('cash-delete-start');
    await press('cash-delete-confirm');
    await settle();
    expect(screen.getByTestId('cash-deleted-text').props.children).toMatch(/answer was lost/);
    expect(getFinance().transactions.some((t) => t.id === kirana.id)).toBe(false);
  });

  it('when the check fails too, offers only Check again', async () => {
    backend = await goLive(data, {
      [`DELETE ${path}`]: () => Promise.reject(new TypeError('Network request failed')),
      [`GET ${path}`]: () => Promise.reject(new TypeError('Network request failed')),
    });
    await render(<Sheet id={kirana.id} />);
    await press('cash-delete-start');
    await press('cash-delete-confirm');
    await settle();
    expect(screen.getByTestId('cash-delete-unsure')).toBeTruthy();
    expect(screen.queryByTestId('cash-delete-confirm')).toBeNull();
    await press('cash-delete-check');
    await settle();
    expect(backend.sent(`GET ${path}`)).toHaveLength(2);
    expect(backend.sent(`DELETE ${path}`)).toHaveLength(1);
  });

  it('is not offered on sample data', async () => {
    setFinance(createSampleData());
    await render(<Sheet id={kirana.id} />);
    expect(screen.queryByTestId('cash-delete-start')).toBeNull();
  });
});

describe('cash balances on the device', () => {
  it('a quick entry leaves an unknown balance unknown', () => {
    const d = createSampleData();
    const unknown = {
      ...wallet,
      balance: 0,
      manualBalance: { currentKnown: false, openingBalance: null },
    } as AccountWithManualBalance;
    const out = applyAddCash(
      { ...d, accounts: d.accounts.map((a) => (a.id === wallet.id ? unknown : a)) },
      {
        id: 't1',
        now: '2026-11-14T00:00:00.000Z',
        date: '2026-11-14',
        accountId: wallet.id,
        amount: 500,
        direction: 'expense',
        categoryId: 'cat_dining',
        note: '',
      },
    );
    expect(out.accounts.find((a) => a.id === wallet.id)!.balance).toBe(0);
  });

  it('picks the quick-entry wallet as the Worker does: default, else oldest, no connection', () => {
    const a = (id: string, createdAt: string, over: Partial<Account> = {}): Account => ({
      ...wallet,
      id,
      createdAt,
      isDefaultCash: false,
      ...over,
    });
    expect(
      pickCashAccount(
        [a('b', '2026-02-01'), a('a', '2026-03-01'), a('c', '2026-01-01', { connectionId: 'x' })],
        'INR',
      )!.id,
    ).toBe('b');
    expect(pickCashAccount([a('b', '2026-02-01'), a('a', '2026-02-01')], 'INR')!.id).toBe('a');
    expect(
      pickCashAccount([a('b', '2026-02-01'), a('z', '2026-05-01', { isDefaultCash: true })], 'INR')!
        .id,
    ).toBe('z');
  });
});
