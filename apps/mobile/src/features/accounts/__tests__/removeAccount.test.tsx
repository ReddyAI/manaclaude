import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountDeletionPreview, AccountWithManualBalance } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance } from '../../../data/store';
import { goLive } from '../../transactions/__tests__/live';
import { RemoveAccountSheet } from '../RemoveAccountSheet';

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
const T1 = '1'.repeat(64);
const T2 = '2'.repeat(64);
const base = createSampleData();
const pouch = {
  ...base.accounts.find((a) => a.id === 'acc_cash_inr')!,
  id: 'acc_pouch',
  name: 'Pouch',
  isDefaultCash: false,
  createdAt: '2026-12-01T00:00:00.000Z',
};
const data = { ...base, accounts: [...base.accounts, pouch] };
const wallet = data.accounts.find((a) => a.id === 'acc_cash_inr')!;
const counts = {
  transactions: 0,
  balanceSnapshots: 2,
  holdings: 0,
  investmentActivities: 0,
  recurringItems: 0,
  goals: 0,
  rules: 0,
  imports: 0,
  savedLayouts: 0,
  savingImports: 0,
};
const preview = (over: Partial<AccountDeletionPreview> = {}): AccountDeletionPreview => ({
  accountId: wallet.id,
  account: wallet,
  previewToken: T1,
  allowed: true,
  blockers: [],
  counts,
  removes: { accounts: 1, balanceSnapshots: 2, manualBalance: false },
  detaches: { imports: 0, savedLayouts: 0 },
  defaultCash: { wasDefault: true, nextAccountId: 'acc_pouch', createsOnNextUse: false },
  ...over,
});

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
let removed: string[] = [];
afterEach(() => {
  backend?.restore();
  backend = undefined;
  removed = [];
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

async function open(handlers: Parameters<typeof goLive>[1]) {
  backend = await goLive(data, handlers);
  await render(
    <RemoveAccountSheet
      accountId={wallet.id}
      visible
      onClose={() => {}}
      onRemoved={(note) => removed.push(note)}
    />,
  );
  await settle();
}
const PATH = '/v1/accounts/acc_cash_inr';

describe('removing an account', () => {
  it('shows a blocked preview with every reason and no way to remove', async () => {
    await open({
      [`GET ${PATH}/deletion-preview`]: () =>
        json(
          200,
          preview({
            allowed: false,
            blockers: ['account_not_empty', 'account_in_use'],
            counts: { ...counts, transactions: 4, rules: 1, recurringItems: 1 },
          }),
        ),
    });
    expect(screen.getByTestId('remove-blocker-account_not_empty')).toBeTruthy();
    expect(screen.getByText(/4 transactions/)).toBeTruthy();
    expect(screen.getByText(/1 recurring item and 1 rule/)).toBeTruthy();
    expect(screen.queryByTestId('remove-confirm')).toBeNull();
    await press('remove-recheck');
    await settle();
    expect(backend!.sent(`GET ${PATH}/deletion-preview`)).toHaveLength(2);
  });

  it('says what goes, which wallet takes quick entries, and deletes with the token shown', async () => {
    await open({
      [`GET ${PATH}/deletion-preview`]: () => json(200, preview()),
      [`DELETE ${PATH}`]: () =>
        json(200, {
          deletedAccountId: wallet.id,
          defaultCash: { wasDefault: true, nextAccountId: 'acc_pouch', createsOnNextUse: false },
        }),
    });
    expect(screen.getByText(/2 saved balance readings/)).toBeTruthy();
    expect(screen.getByTestId('remove-cash').props.children).toBe(
      'Quick cash entries in INR go to this account now. After removal they go to "Pouch".',
    );
    expect(screen.getByTestId('remove-nonzero')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByTestId('remove-confirm'));
      fireEvent.press(screen.getByTestId('remove-confirm'));
    });
    await settle();
    expect(backend!.sent(`DELETE ${PATH}`).map((c) => c.body)).toEqual([{ previewToken: T1 }]);
    expect(removed).toEqual([
      'Removed "Wallet (INR)". Quick cash entries in INR now go to "Pouch".',
    ]);
    expect(getFinance().accounts.some((a) => a.id === wallet.id)).toBe(false);
    expect(getFinance().accounts.find((a) => a.id === 'acc_pouch')!.isDefaultCash).toBe(true);
  });

  it('shows an unknown balance as Unknown', async () => {
    const unknown: AccountWithManualBalance = {
      ...wallet,
      balance: 0,
      manualBalance: { currentKnown: false, openingBalance: null },
    };
    await open({
      [`GET ${PATH}/deletion-preview`]: () => json(200, preview({ account: unknown })),
    });
    expect(screen.getByTestId('remove-balance-unknown')).toBeTruthy();
    expect(screen.queryByTestId('remove-balance')).toBeNull();
    expect(screen.queryByTestId('remove-nonzero')).toBeNull();
  });

  it('on 409 account_changed shows the new preview and waits for a new confirmation', async () => {
    let reads = 0;
    await open({
      [`GET ${PATH}/deletion-preview`]: () => {
        reads += 1;
        return json(200, preview({ previewToken: reads === 1 ? T1 : T2 }));
      },
      [`DELETE ${PATH}`]: (call) =>
        (call.body as { previewToken: string }).previewToken === T1
          ? json(409, { error: 'account_changed', message: 'Changed.' })
          : json(200, { deletedAccountId: wallet.id, defaultCash: null }),
    });
    await press('remove-confirm');
    await settle();
    expect(screen.getByTestId('remove-notice').props.children).toMatch(/nothing was removed/);
    // The new token was not used by itself.
    expect(backend!.sent(`DELETE ${PATH}`)).toHaveLength(1);
    expect(removed).toEqual([]);
    await press('remove-confirm');
    await settle();
    expect(backend!.sent(`DELETE ${PATH}`)[1]!.body).toEqual({ previewToken: T2 });
    expect(removed).toHaveLength(1);
  });

  it('on a refusal shows the reasons again', async () => {
    let reads = 0;
    await open({
      [`GET ${PATH}/deletion-preview`]: () => {
        reads += 1;
        return json(
          200,
          reads === 1
            ? preview()
            : preview({
                allowed: false,
                blockers: ['import_in_progress'],
                counts: { ...counts, savingImports: 1 },
              }),
        );
      },
      [`DELETE ${PATH}`]: () => json(409, { error: 'account_delete_refused', message: 'No.' }),
    });
    await press('remove-confirm');
    await settle();
    expect(screen.getByTestId('remove-blocker-import_in_progress')).toBeTruthy();
    expect(screen.queryByTestId('remove-confirm')).toBeNull();
  });

  it('after a lost answer checks the account: still there means not removed', async () => {
    await open({
      [`GET ${PATH}/deletion-preview`]: () => json(200, preview()),
      [`DELETE ${PATH}`]: () => Promise.reject(new TypeError('Network request failed')),
      [`GET ${PATH}`]: () => json(200, { account: wallet, version: 'f'.repeat(64) }),
    });
    await press('remove-confirm');
    await settle();
    expect(backend!.sent(`GET ${PATH}`)).toHaveLength(1);
    expect(screen.getByTestId('remove-notice').props.children).toMatch(/still there/);
    expect(backend!.sent(`DELETE ${PATH}`)).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it('after a lost answer, a 404 means it was removed', async () => {
    await open({
      [`GET ${PATH}/deletion-preview`]: () => json(200, preview()),
      [`DELETE ${PATH}`]: () => json(502, { error: 'internal', message: 'Bad gateway.' }),
      [`GET ${PATH}`]: () => json(404, { error: 'not_found', message: 'Account not found.' }),
    });
    await press('remove-confirm');
    await waitFor(() => expect(removed).toHaveLength(1));
    expect(removed[0]).toMatch(/answer was lost, but the account is gone/);
  });

  it('when that check fails too, offers only Check again', async () => {
    await open({
      [`GET ${PATH}/deletion-preview`]: () => json(200, preview()),
      [`DELETE ${PATH}`]: () => Promise.reject(new TypeError('Network request failed')),
      [`GET ${PATH}`]: () => Promise.reject(new TypeError('Network request failed')),
    });
    await press('remove-confirm');
    await settle();
    expect(screen.getByTestId('remove-unsure')).toBeTruthy();
    expect(screen.queryByTestId('remove-confirm')).toBeNull();
    await press('remove-check');
    await settle();
    expect(backend!.sent(`GET ${PATH}`)).toHaveLength(2);
    expect(backend!.sent(`DELETE ${PATH}`)).toHaveLength(1);
  });
});
