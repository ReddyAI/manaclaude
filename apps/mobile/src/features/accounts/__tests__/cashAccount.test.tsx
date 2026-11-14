import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Account, FinanceDataset } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance } from '../../../data/store';
import { goLive } from '../../transactions/__tests__/live';
import { createCashAccount } from '../actions';
import { CashAccountSheet } from '../CashAccountSheet';
import { checkCashAccount, currencyChoices, defaultCashFor } from '../cashAccount';

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

/** Sample data without its INR cash account, so INR has no quick-entry account yet. */
function noInrCash(): FinanceDataset {
  const d = createSampleData();
  return { ...d, accounts: d.accounts.filter((a) => !(a.type === 'cash' && a.currency === 'INR')) };
}
const made = (body: Record<string, unknown>): Account => ({
  ...createSampleData().accounts.find((a) => a.type === 'cash')!,
  id: 'acc_new_cash',
  name: body.name as string,
  currency: body.currency as string,
  balance: body.balance as number,
  isDefaultCash: body.isDefault as boolean,
});

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

describe('the cash account form', () => {
  const accounts = createSampleData().accounts;

  it('offers USD and INR first, then other currencies in use', () => {
    expect(currencyChoices(accounts).slice(0, 2)).toEqual(['USD', 'INR']);
  });

  it('makes exactly the body the route takes', () => {
    const r = checkCashAccount(
      { name: ' Travel pouch ', currency: 'USD', balance: '1,250.50', isDefault: true },
      accounts,
    );
    // USD already has a quick-entry account in the sample data, so it is not made the default.
    expect(defaultCashFor(accounts, 'USD')).not.toBeNull();
    expect(r.body).toEqual({
      name: 'Travel pouch',
      currency: 'USD',
      balance: 1_250_50,
      isDefault: false,
    });
  });

  it('needs a name, a new one, and the cash on hand (0 is fine, below 0 is not)', () => {
    const base = { name: 'Pouch', currency: 'INR', balance: '0', isDefault: false };
    expect(checkCashAccount(base, accounts).body?.balance).toBe(0);
    expect(checkCashAccount({ ...base, name: '' }, accounts).problems.name).toBe('Type a name.');
    expect(checkCashAccount({ ...base, name: 'x'.repeat(101) }, accounts).problems.name).toMatch(
      /at most 100/,
    );
    const taken = accounts.find((a) => !a.hidden)!.name;
    expect(
      checkCashAccount({ ...base, name: taken.toUpperCase() }, accounts).problems.name,
    ).toMatch(/already have/);
    expect(checkCashAccount({ ...base, balance: '' }, accounts).problems.balance).toMatch(
      /0 is fine/,
    );
    expect(checkCashAccount({ ...base, balance: '-1' }, accounts).problems.balance).toMatch(
      /below zero/,
    );
  });
});

describe('adding a cash account', () => {
  it('posts it, shows it is ready, and puts it in the app’s data', async () => {
    backend = await goLive(noInrCash(), {
      'POST /v1/accounts/cash': (call) =>
        json(201, { account: made(call.body as Record<string, unknown>) }),
    });
    await render(<CashAccountSheet visible onClose={() => {}} />);
    await fireEvent.changeText(screen.getByTestId('cash-account-name'), 'Home safe');
    await press('cash-account-currency-INR');
    await fireEvent.changeText(screen.getByTestId('cash-account-balance'), '5000');
    await press('cash-account-save');
    await waitFor(() => expect(screen.getByTestId('cash-account-made')).toBeTruthy());
    expect(backend.sent('POST /v1/accounts/cash')[0]!.body).toEqual({
      name: 'Home safe',
      currency: 'INR',
      balance: 5000_00,
      isDefault: true,
    });
    expect(getFinance().accounts.some((a) => a.id === 'acc_new_cash')).toBe(true);
  });

  it('does not offer quick entries when that currency already has an account for them', async () => {
    backend = await goLive(createSampleData());
    await render(<CashAccountSheet visible onClose={() => {}} />);
    await press('cash-account-currency-USD');
    expect(screen.getByTestId('cash-account-has-default')).toBeTruthy();
    expect(screen.queryByTestId('cash-account-default')).toBeNull();
  });

  it('makes one account for a fast double tap', async () => {
    const slow = held();
    backend = await goLive(noInrCash(), { 'POST /v1/accounts/cash': () => slow.promise });
    await render(<CashAccountSheet visible onClose={() => {}} />);
    await fireEvent.changeText(screen.getByTestId('cash-account-name'), 'Home safe');
    await fireEvent.changeText(screen.getByTestId('cash-account-balance'), '0');
    await act(async () => {
      fireEvent.press(screen.getByTestId('cash-account-save'));
      fireEvent.press(screen.getByTestId('cash-account-save'));
    });
    expect(backend.sent('POST /v1/accounts/cash')).toHaveLength(1);
    await act(async () => {
      slow.release(201, {
        account: made({ name: 'Home safe', currency: 'INR', balance: 0, isDefault: true }),
      });
      await settle();
    });
  });

  it('says the account may exist when the answer is lost, and sends nothing again by itself', async () => {
    backend = await goLive(noInrCash(), {
      'POST /v1/accounts/cash': () => Promise.reject(new TypeError('Network request failed')),
    });
    await render(<CashAccountSheet visible onClose={() => {}} />);
    await fireEvent.changeText(screen.getByTestId('cash-account-name'), 'Home safe');
    await fireEvent.changeText(screen.getByTestId('cash-account-balance'), '0');
    await press('cash-account-save');
    await waitFor(() => expect(screen.getByTestId('cash-account-problem')).toBeTruthy());
    expect(screen.getByTestId('cash-account-problem').props.children).toMatch(
      /may have been made all the same/,
    );
    await settle();
    expect(backend.sent('POST /v1/accounts/cash')).toHaveLength(1);
  });

  it('never puts the account into sample data', async () => {
    resetBackendForTests();
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    const stand = fakeBackend({
      'POST /v1/accounts/cash': (call) =>
        json(201, { account: made(call.body as Record<string, unknown>) }),
    });
    try {
      await createCashAccount({ name: 'Pouch', currency: 'INR', balance: 0, isDefault: false });
      expect(getFinance().accounts.some((a) => a.id === 'acc_new_cash')).toBe(false);
    } finally {
      stand.restore();
    }
  });

  it('waits for this backend’s data, and needs a backend at all', async () => {
    resetBackendForTests();
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    const view = await render(<CashAccountSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('cash-account-not-loaded')).toBeTruthy();
    await view.unmount();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<CashAccountSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('cash-account-no-backend')).toBeTruthy();
  });
});
