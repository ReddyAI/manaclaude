import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Account, ManualAccountRequest } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { goLive } from '../../transactions/__tests__/live';
import { AccountsScreen } from '../AccountsScreen';
import { createAccountByHand } from '../actions';
import { ManualAccountSheet } from '../ManualAccountSheet';
import { byHandOutcome, readByHand } from '../manualAccount';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({}),
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
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/**
 * Block S: an account kept by hand from the Accounts tab (POST
 * /v1/accounts/manual). All data is invented.
 */

const made = (body: ManualAccountRequest): Account => ({
  ...createSampleData().accounts.find((a) => a.type === 'checking')!,
  id: 'acc_by_hand',
  name: body.name,
  type: body.type,
  currency: body.currency,
  balance: body.currentBalance?.amount ?? 0,
  connectionId: null,
  externalId: null,
});
const created = (call: { body: unknown }) => {
  const body = call.body as ManualAccountRequest;
  return json(201, { account: made(body), replayed: false });
};

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const type = (id: string, text: string) => fireEvent.changeText(screen.getByTestId(id), text);

/** Fills in a car worth INR 6,50,000 today. */
async function fillCar() {
  await type('new-account-name', 'Family car');
  await press('new-account-type-vehicle');
  await press('new-account-currency-INR');
  await press('new-account-balance-known');
  await type('new-account-balance', '650000');
}

let backend: Awaited<ReturnType<typeof goLive>> | undefined;
beforeEach(async () => {
  await AsyncStorage.clear();
});
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

describe('outcomes', () => {
  it('no answer or a Worker failure is unsure, 409 a conflict, anything else refused', () => {
    expect(byHandOutcome(0)).toBe('unsure');
    expect(byHandOutcome(500)).toBe('unsure');
    expect(byHandOutcome(503)).toBe('unsure');
    expect(byHandOutcome(409)).toBe('conflict');
    expect(byHandOutcome(400)).toBe('refused');
    expect(byHandOutcome(401)).toBe('refused');
    expect(byHandOutcome(404)).toBe('refused');
  });
});

describe('adding an account by hand', () => {
  it('is offered on the Connectors tab', async () => {
    backend = await goLive(createSampleData());
    await render(<AccountsScreen />);
    await fireEvent.press(screen.getByText('Connectors'));
    await press('add-manual-account');
    expect(screen.getByTestId('manual-account-sheet')).toBeTruthy();
    expect(screen.getByTestId('import-new-account')).toBeTruthy();
  });

  it('offers property, vehicles and loans, with a value for a car', async () => {
    backend = await goLive(createSampleData());
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    for (const t of ['property', 'vehicle', 'loan', 'mortgage', 'savings', 'crypto'])
      expect(screen.getByTestId(`new-account-type-${t}`)).toBeTruthy();
    expect(screen.queryByTestId('new-account-type-cash')).toBeNull();
    await press('new-account-type-vehicle');
    expect(screen.getByText('Do you know what it is worth today?')).toBeTruthy();
    await press('new-account-balance-known');
    expect(screen.getByText('Value')).toBeTruthy();
  });

  it('sends exactly the route body with a creation key and puts the account in the data', async () => {
    backend = await goLive(createSampleData(), { 'POST /v1/accounts/manual': created });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-made')).toBeTruthy());
    const sent = backend.sent('POST /v1/accounts/manual');
    expect(sent).toHaveLength(1);
    const body = sent[0]!.body as ManualAccountRequest;
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect({ ...body, idempotencyKey: 'k' }).toEqual({
      idempotencyKey: 'k',
      name: 'Family car',
      type: 'vehicle',
      currency: 'INR',
      currentBalance: { amount: 650000_00, asOf: '2026-11-05T12:00:00.000Z' },
    });
    expect(screen.getByTestId('manual-account-made').props.children).toBe(
      '"Family car" is ready. It is on the Accounts tab.',
    );
    expect(getFinance().accounts.some((a) => a.id === 'acc_by_hand')).toBe(true);
    // Nothing is left waiting once the answer is seen.
    expect(await readByHand()).toBeNull();
  });

  it('sends an unknown balance as unknown, never as zero', async () => {
    backend = await goLive(createSampleData(), { 'POST /v1/accounts/manual': created });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await type('new-account-name', 'Plot in Guntur');
    await press('new-account-type-property');
    await press('new-account-currency-INR');
    await press('new-account-balance-unknown');
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-made')).toBeTruthy());
    const body = backend.sent('POST /v1/accounts/manual')[0]!.body as ManualAccountRequest;
    expect(body.currentBalance).toBeNull();
    expect('includeInNetWorth' in body).toBe(false);
  });

  it('a lost answer keeps the request; Try again sends it unchanged and gets the same account', async () => {
    let first = true;
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': (call) => {
        if (first) {
          first = false;
          return Promise.reject(new TypeError('Network request failed'));
        }
        return json(200, { account: made(call.body as ManualAccountRequest), replayed: true });
      },
    });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-unsure')).toBeTruthy());
    expect((await readByHand())?.name).toBe('Family car');
    await press('manual-account-retry');
    await waitFor(() => expect(screen.getByTestId('manual-account-made')).toBeTruthy());
    const [a, b] = backend.sent('POST /v1/accounts/manual');
    expect(b!.body).toEqual(a!.body);
    expect(screen.getByTestId('manual-account-made').props.children).toMatch(
      /had already been made by your first try\. No second account was made\./,
    );
    expect(await readByHand()).toBeNull();
  });

  it('a 500 is unsure too', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': () =>
        json(500, { error: 'internal', message: 'Storage failed.' }),
    });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-unsure')).toBeTruthy());
    expect(screen.getByTestId('manual-account-problem').props.children).toBe('Storage failed.');
  });

  it('a request left waiting is offered again after reopening, for the same backend only', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': () => Promise.reject(new TypeError('Network request failed')),
    });
    const first = await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-unsure')).toBeTruthy());
    await first.unmount();
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('manual-account-unsure')).toBeTruthy());
    expect(screen.getByText(/"Family car" was made/)).toBeTruthy();
  });

  it('a request left waiting for another backend is not offered', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': () => Promise.reject(new TypeError('Network request failed')),
    });
    const first = await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-unsure')).toBeTruthy());
    await first.unmount();
    expect(await readByHand()).not.toBeNull();
    setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' });
    expect(await readByHand()).toBeNull();
  });

  it('a 409 is never sent again; Start over drops it', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': () =>
        json(409, {
          error: 'idempotency_conflict',
          message: 'That key was used with other details.',
        }),
    });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-conflict')).toBeTruthy());
    expect(screen.queryByTestId('manual-account-retry')).toBeNull();
    expect(screen.getByText(/Check the Accounts tab for "Family car"/)).toBeTruthy();
    await press('manual-account-forget');
    expect(screen.getByTestId('import-new-account')).toBeTruthy();
    expect(await readByHand()).toBeNull();
    expect(backend.sent('POST /v1/accounts/manual')).toHaveLength(1);
  });

  it('a refusal says why, keeps the form and drops the request', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/accounts/manual': () =>
        json(400, { error: 'invalid_body', message: 'The name is too long.' }),
    });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await press('new-account-create');
    await waitFor(() =>
      expect(screen.getByTestId('manual-account-problem').props.children).toBe(
        'The name is too long.',
      ),
    );
    expect(screen.getByTestId('import-new-account')).toBeTruthy();
    expect(await readByHand()).toBeNull();
  });

  it('makes one request for a fast double tap', async () => {
    const slow = held();
    backend = await goLive(createSampleData(), { 'POST /v1/accounts/manual': () => slow.promise });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await fillCar();
    await act(async () => {
      fireEvent.press(screen.getByTestId('new-account-create'));
      fireEvent.press(screen.getByTestId('new-account-create'));
      await settle();
    });
    expect(backend.sent('POST /v1/accounts/manual')).toHaveLength(1);
    await act(async () => {
      const body = backend!.sent('POST /v1/accounts/manual')[0]!.body as ManualAccountRequest;
      slow.release(201, { account: made(body), replayed: false });
      await settle();
    });
    expect(screen.getByTestId('manual-account-made')).toBeTruthy();
  });

  it('starts on the first type offered (property)', async () => {
    backend = await goLive(createSampleData(), { 'POST /v1/accounts/manual': created });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    await type('new-account-name', 'Flat in Pune');
    await press('new-account-currency-INR');
    await press('new-account-balance-unknown');
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('manual-account-made')).toBeTruthy());
    expect((backend.sent('POST /v1/accounts/manual')[0]!.body as ManualAccountRequest).type).toBe(
      'property',
    );
  });

  it("never puts the Worker's account into sample data", async () => {
    resetBackendForTests();
    await act(() => setFinance(createSampleData()));
    const fake = fakeBackend({ 'POST /v1/accounts/manual': created });
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    const request: ManualAccountRequest = {
      idempotencyKey: 'demo-key-1',
      name: 'Old scooter',
      type: 'vehicle',
      currency: 'INR',
      currentBalance: null,
    };
    await createAccountByHand(request);
    expect(getFinance().accounts.some((a) => a.id === 'acc_by_hand')).toBe(false);
    fake.restore();
  });

  it('needs a backend with its data loaded', async () => {
    resetBackendForTests();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('manual-account-no-backend')).toBeTruthy();
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    await render(<ManualAccountSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('manual-account-not-loaded')).toBeTruthy();
  });
});
