import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { setFinance } from '../../../data/store';
import { goLive } from '../../transactions/__tests__/live';
import { AccountDetailScreen } from '../AccountDetailScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams,
}));
let mockParams: { id?: string } = {};
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
const data = createSampleData();
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
});

describe('the account page', () => {
  it('says why a connected account cannot be edited, and offers nothing', async () => {
    backend = await goLive(data);
    mockParams = { id: 'acc_checking' };
    await render(<AccountDetailScreen />);
    expect(screen.getByTestId('account-read-only').props.children).toMatch(/can't be changed here/);
    expect(screen.queryByTestId('account-edit')).toBeNull();
    expect(screen.queryByTestId('account-remove')).toBeNull();
  });

  it('offers Edit and Remove for an account with no connection once the Worker’s data is on screen', async () => {
    mockParams = { id: 'acc_nre' };
    await render(<AccountDetailScreen />);
    // Sample data: nothing can be sent.
    expect(screen.getByTestId('account-edit-needs-backend')).toBeTruthy();
    expect(screen.queryByTestId('account-edit')).toBeNull();
    screen.unmount();
    backend = await goLive(data);
    await render(<AccountDetailScreen />);
    expect(screen.getByTestId('account-edit')).toBeTruthy();
    expect(screen.getByTestId('account-remove')).toBeTruthy();
  });

  it('after removal says so, with where quick entries go', async () => {
    const wallet = data.accounts.find((a) => a.id === 'acc_cash_inr')!;
    backend = await goLive(data, {
      'GET /v1/accounts/acc_cash_inr/deletion-preview': () =>
        json(200, {
          accountId: wallet.id,
          account: wallet,
          previewToken: '1'.repeat(64),
          allowed: true,
          blockers: [],
          counts: {
            transactions: 0,
            balanceSnapshots: 0,
            holdings: 0,
            investmentActivities: 0,
            recurringItems: 0,
            goals: 0,
            rules: 0,
            imports: 0,
            savedLayouts: 0,
            savingImports: 0,
          },
          removes: { accounts: 1, balanceSnapshots: 0, manualBalance: false },
          detaches: { imports: 0, savedLayouts: 0 },
          defaultCash: { wasDefault: true, nextAccountId: null, createsOnNextUse: true },
        }),
      'DELETE /v1/accounts/acc_cash_inr': () =>
        json(200, {
          deletedAccountId: wallet.id,
          defaultCash: { wasDefault: true, nextAccountId: null, createsOnNextUse: true },
        }),
    });
    mockParams = { id: 'acc_cash_inr' };
    await render(<AccountDetailScreen />);
    await fireEvent.press(screen.getByTestId('account-remove'));
    await settle();
    await fireEvent.press(screen.getByTestId('remove-confirm'));
    await waitFor(() => expect(screen.getByText('Account removed')).toBeTruthy());
    expect(screen.getByText(/makes a new one called "Cash \(INR\)"/)).toBeTruthy();
  });
});
