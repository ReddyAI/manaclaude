import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Account, AccountWithManualBalance } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance } from '../../../data/store';
import { goLive } from '../../transactions/__tests__/live';
import { AccountEditSheet } from '../AccountEditSheet';

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

/** All data is invented. */
const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);
const V3 = 'c'.repeat(64);
const data = createSampleData();
const nre = data.accounts.find((a) => a.id === 'acc_nre')!;
/** The Worker's copy differs from the app's (another device renamed it), to see which one the form uses. */
const onWorker: Account = { ...nre, name: 'NRE (Worker)', balanceAsOf: '2026-11-01T12:00:00.000Z' };

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const type = (id: string, text: string) => fireEvent.changeText(screen.getByTestId(id), text);
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

async function open(handlers: Parameters<typeof goLive>[1]) {
  backend = await goLive(data, handlers);
  await render(<AccountEditSheet accountId="acc_nre" visible onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('account-edit-name')).toBeTruthy());
}

describe('editing an account', () => {
  it('fills the form from the Worker and sends only the change with its version', async () => {
    await open({
      'GET /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V1 }),
      'PATCH /v1/accounts/acc_nre': (call) =>
        json(200, {
          account: { ...onWorker, name: (call.body as { name: string }).name },
          version: V2,
        }),
    });
    expect(screen.getByTestId('account-edit-name').props.value).toBe('NRE (Worker)');
    await type('account-edit-name', ' NRE Joint ');
    await press('account-edit-save');
    await waitFor(() => expect(screen.getByTestId('account-edit-saved')).toBeTruthy());
    expect(backend!.sent('PATCH /v1/accounts/acc_nre').map((c) => c.body)).toEqual([
      { expectedVersion: V1, name: 'NRE Joint' },
    ]);
    expect(getFinance().accounts.find((a) => a.id === 'acc_nre')!.name).toBe('NRE Joint');
  });

  it('asks about net worth whenever the balance changes, and sends the answer', async () => {
    await open({
      'GET /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V1 }),
      'PATCH /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V2 }),
    });
    expect(screen.getByTestId('account-edit-networth-note').props.children).not.toMatch(
      /changing the balance/,
    );
    await type('account-edit-amount', '1500');
    expect(screen.getByTestId('account-edit-networth-note').props.children).toMatch(
      /You are changing the balance/,
    );
    await press('account-edit-networth');
    await press('account-edit-save');
    await settle();
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')[0]!.body).toEqual({
      expectedVersion: V1,
      currentBalance: { amount: 1500_00, asOf: '2026-11-01T12:00:00.000Z' },
      includeInNetWorth: false,
    });
  });

  it('shows an unknown balance as Unknown, with no amount and net worth off', async () => {
    const unknown: AccountWithManualBalance = {
      ...onWorker,
      balance: 0,
      includeInNetWorth: false,
      manualBalance: { currentKnown: false, openingBalance: null },
    };
    await open({ 'GET /v1/accounts/acc_nre': () => json(200, { account: unknown, version: V1 }) });
    expect(screen.queryByTestId('account-edit-amount')).toBeNull();
    expect(screen.getByTestId('account-edit-unknown-note')).toBeTruthy();
    expect(screen.getByTestId('account-edit-networth').props.accessibilityState).toMatchObject({
      checked: false,
      disabled: true,
    });
  });

  it('on 409 account_changed shows the Worker’s values and waits for a new save', async () => {
    let reads = 0;
    const changed = { ...onWorker, name: 'Renamed elsewhere' };
    await open({
      'GET /v1/accounts/acc_nre': () => {
        reads += 1;
        return json(
          200,
          reads === 1 ? { account: onWorker, version: V1 } : { account: changed, version: V2 },
        );
      },
      'PATCH /v1/accounts/acc_nre': (call) =>
        (call.body as { expectedVersion: string }).expectedVersion === V1
          ? json(409, {
              error: 'account_changed',
              message: 'Account changed. Reload it before saving.',
            })
          : json(200, { account: { ...changed, name: 'Mine' }, version: V3 }),
    });
    await type('account-edit-name', 'Mine');
    await press('account-edit-save');
    await waitFor(() => expect(screen.getByTestId('account-edit-notice')).toBeTruthy());
    expect(screen.getByTestId('account-edit-notice').props.children).toMatch(
      /changed somewhere else/,
    );
    expect(screen.getByTestId('account-edit-name').props.value).toBe('Renamed elsewhere');
    await settle();
    // Nothing was sent again by itself.
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')).toHaveLength(1);
    await type('account-edit-name', 'Mine');
    await press('account-edit-save');
    await waitFor(() => expect(screen.getByTestId('account-edit-saved')).toBeTruthy());
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')[1]!.body).toEqual({
      expectedVersion: V2,
      name: 'Mine',
    });
  });

  it('after a lost answer reads first, and shows it as saved when the Worker has the change', async () => {
    let reads = 0;
    await open({
      'GET /v1/accounts/acc_nre': () => {
        reads += 1;
        return json(200, {
          account: reads === 1 ? onWorker : { ...onWorker, name: 'Kept' },
          version: reads === 1 ? V1 : V2,
        });
      },
      'PATCH /v1/accounts/acc_nre': () => Promise.reject(new TypeError('Network request failed')),
    });
    await type('account-edit-name', 'Kept');
    await press('account-edit-save');
    await waitFor(() => expect(screen.getByTestId('account-edit-saved')).toBeTruthy());
    expect(screen.getByTestId('account-edit-notice').props.children).toMatch(/has your change/);
    expect(reads).toBe(2);
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')).toHaveLength(1);
  });

  it('after a lost answer the Worker does not have, shows its values and asks again', async () => {
    await open({
      'GET /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V1 }),
      'PATCH /v1/accounts/acc_nre': () => json(500, { error: 'internal', message: 'Oops.' }),
    });
    await type('account-edit-name', 'Lost');
    await press('account-edit-save');
    await waitFor(() =>
      expect(screen.getByTestId('account-edit-notice').props.children).toMatch(
        /does not have your change/,
      ),
    );
    expect(screen.getByTestId('account-edit-name').props.value).toBe('NRE (Worker)');
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')).toHaveLength(1);
  });

  it('when the read after a lost answer fails too, offers only Check again', async () => {
    let reads = 0;
    await open({
      'GET /v1/accounts/acc_nre': () => {
        reads += 1;
        return reads === 1
          ? json(200, { account: onWorker, version: V1 })
          : Promise.reject(new TypeError('Network request failed'));
      },
      'PATCH /v1/accounts/acc_nre': () => Promise.reject(new TypeError('Network request failed')),
    });
    await type('account-edit-name', 'Unsure');
    await press('account-edit-save');
    await waitFor(() => expect(screen.getByTestId('account-edit-unsure')).toBeTruthy());
    expect(screen.queryByTestId('account-edit-save')).toBeNull();
    await press('account-edit-check');
    await settle();
    expect(reads).toBe(3);
  });

  it('sends one PATCH for a double tap', async () => {
    await open({
      'GET /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V1 }),
      'PATCH /v1/accounts/acc_nre': () => json(200, { account: onWorker, version: V2 }),
    });
    await type('account-edit-name', 'Twice');
    await act(async () => {
      fireEvent.press(screen.getByTestId('account-edit-save'));
      fireEvent.press(screen.getByTestId('account-edit-save'));
    });
    await settle();
    expect(backend!.sent('PATCH /v1/accounts/acc_nre')).toHaveLength(1);
  });

  it('shows a provider account as read-only, with the reason', async () => {
    const linked = { ...onWorker, externalId: 'ext_1' };
    backend = await goLive(data, {
      'GET /v1/accounts/acc_nre': () => json(200, { account: linked, version: V1 }),
    });
    await render(<AccountEditSheet accountId="acc_nre" visible onClose={() => {}} />);
    await settle();
    await waitFor(() => expect(screen.getByTestId('account-edit-readonly')).toBeTruthy());
    expect(screen.queryByTestId('account-edit-save')).toBeNull();
  });
});
