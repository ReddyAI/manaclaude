import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { LinkOptionsResponse } from '@manaclaude/shared';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { linkApi } from '../linkApi';
import { KeysFlow } from '../KeysFlow';
import { LinkHomeScreen } from '../LinkHomeScreen';
import { PlaidFlow, plaidConfirmText } from '../PlaidFlow';
import { SimplefinFlow } from '../SimplefinFlow';
import { SophtronFlow } from '../SophtronFlow';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('react-native-plaid-link-sdk', () => ({ createPlaidLinkSession: jest.fn() }));
jest.mock('../plaidLink', () => ({
  openPlaidLink: jest.fn(async () => ({
    publicToken: 'public-demo',
    institutionName: 'Harbor Savings Bank',
  })),
}));
jest.mock('../linkApi', () => {
  const actual = jest.requireActual('../linkApi');
  return {
    ...actual,
    linkApi: Object.fromEntries(Object.keys(actual.linkApi).map((k) => [k, jest.fn()])),
  };
});
const mocked = linkApi as unknown as Record<keyof typeof linkApi, jest.Mock>;

const slots = (total: number | null, left: number | null, lifetime = false) => ({
  total,
  used: total !== null && left !== null ? total - left : 0,
  left,
  lifetime,
});
const OPTIONS: LinkOptionsResponse = {
  order: {
    bank: ['sophtron', 'simplefin', 'plaid'],
    brokerage: ['snaptrade', 'zerodha_kite', 'sophtron'],
    crypto: ['coinbase', 'wazirx'],
  },
  connectors: [
    {
      id: 'sophtron',
      name: 'Sophtron',
      configured: true,
      blockedReason: null,
      slots: slots(null, null),
    },
    {
      id: 'simplefin',
      name: 'SimpleFIN',
      configured: true,
      blockedReason: null,
      slots: slots(0, 0),
    },
    {
      id: 'plaid',
      name: 'Plaid Trial',
      configured: false,
      blockedReason: 'Plaid is off until you say so. Nothing is sent to Plaid.',
      slots: slots(10, 7, true),
    },
    {
      id: 'snaptrade',
      name: 'SnapTrade',
      configured: true,
      blockedReason: null,
      slots: slots(20, 20),
    },
    {
      id: 'zerodha_kite',
      name: 'Zerodha Kite',
      configured: true,
      blockedReason: null,
      slots: slots(null, null),
    },
    {
      id: 'coinbase',
      name: 'Coinbase',
      configured: true,
      blockedReason: null,
      slots: slots(null, null),
    },
    {
      id: 'wazirx',
      name: 'WazirX',
      configured: true,
      blockedReason: null,
      slots: slots(null, null),
    },
  ],
  plaidEnabled: false,
  credentialsReady: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  mocked.options.mockResolvedValue(OPTIONS);
});

describe('Add account', () => {
  it('lists connectors in the new order with Sophtron first and no Teller', async () => {
    await render(<LinkHomeScreen />);
    await waitFor(() => expect(screen.getByTestId('link-bank-sophtron')).toBeTruthy());
    expect(screen.getAllByText('Try first').length).toBe(3);
    expect(screen.getByTestId('link-brokerage-snaptrade')).toBeTruthy();
    expect(screen.getByTestId('link-crypto-coinbase')).toBeTruthy();
    expect(screen.queryByTestId('link-bank-teller')).toBeNull();
    expect(
      screen.getByText(/Teller is not offered: Teller shut down its API in July 2026/),
    ).toBeTruthy();
    expect(screen.getByTestId('link-import')).toBeTruthy();
    expect(
      screen.getByText('Plaid is off until you say so. Nothing is sent to Plaid.'),
    ).toBeTruthy();
  });

  it('asks to set up the backend first when it is not set', async () => {
    setBackendConfigForTests({ token: '' });
    await render(<LinkHomeScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
    expect(mocked.options).not.toHaveBeenCalled();
  });
});

describe('Plaid', () => {
  it('asks the exact question with the logins left before it uses one', async () => {
    expect(plaidConfirmText(7)).toBe(
      'This uses 1 of your 10 lifetime Plaid connections (7 left). Continue?',
    );
    mocked.plaidToken.mockResolvedValue({ linkToken: 'link-demo', expiration: null });
    mocked.plaidExchange.mockResolvedValue({ connectionIds: ['conn_p'], repaired: false });
    const onLinked = jest.fn();
    await render(<PlaidFlow connector="plaid" onLinked={onLinked} />);
    await waitFor(() =>
      expect(screen.getByTestId('plaid-confirm').props.children).toBe(
        'This uses 1 of your 10 lifetime Plaid connections (7 left). Continue?',
      ),
    );
    expect(mocked.plaidToken).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('plaid-continue'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_p'], false));
    expect(mocked.plaidExchange).toHaveBeenCalledWith({
      publicToken: 'public-demo',
      institutionName: 'Harbor Savings Bank',
    });
  });

  it('shows the backend refusal when Plaid is switched off', async () => {
    const { BackendError } = jest.requireActual('../../../data/backend/client');
    mocked.plaidToken.mockRejectedValue(
      new BackendError(
        409,
        'plaid_off',
        'Plaid is off until you say so. Nothing was sent to Plaid.',
      ),
    );
    await render(<PlaidFlow connector="plaid" onLinked={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('plaid-continue')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('plaid-continue'));
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    expect(screen.getByText(/Nothing was sent to Plaid/)).toBeTruthy();
  });
});

describe('Sophtron', () => {
  it('signs in, answers the bank, and reports the new connection', async () => {
    mocked.sophtronSearch.mockResolvedValue({
      institutions: [{ id: 'inst-1', name: 'Summit Card Services', url: null }],
    });
    mocked.sophtronStart.mockResolvedValue({
      linkId: 'link_1',
      status: 'mfa',
      challenge: {
        securityQuestions: ['First pet?'],
        tokenMethods: [],
        tokenSent: false,
        tokenRead: null,
        captchaImage: null,
      },
    });
    mocked.sophtronAnswer.mockResolvedValue({
      linkId: 'link_1',
      status: 'done',
      connectionIds: ['conn_s'],
      repaired: false,
    });
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await fireEvent.changeText(screen.getByTestId('sophtron-search'), 'summit');
    await fireEvent.press(screen.getByTestId('sophtron-search-go'));
    await waitFor(() => expect(screen.getByText('Summit Card Services')).toBeTruthy());
    await fireEvent.press(screen.getByText('Summit Card Services'));
    await fireEvent.changeText(screen.getByTestId('sophtron-user'), 'demo-user');
    await fireEvent.changeText(screen.getByTestId('sophtron-password'), 'demo-password');
    await fireEvent.press(screen.getByTestId('sophtron-connect'));
    await waitFor(() => expect(screen.getByText('First pet?')).toBeTruthy());
    expect(mocked.sophtronStart).toHaveBeenCalledWith(
      expect.objectContaining({
        institutionId: 'inst-1',
        username: 'demo-user',
        password: 'demo-password',
      }),
    );
    await fireEvent.changeText(screen.getByTestId('sophtron-answer-0'), 'Rex');
    await fireEvent.press(screen.getByTestId('sophtron-send'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
  });

  it('repairs by answering the bank again on the same login', async () => {
    mocked.sophtronStart.mockResolvedValue({
      linkId: '',
      status: 'done',
      connectionIds: ['conn_old'],
      repaired: true,
    });
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" connectionId="conn_old" onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('sophtron-refresh'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_old'], true));
    expect(mocked.sophtronStart).toHaveBeenCalledWith({ connectionId: 'conn_old', refresh: true });
  });
});

describe('SimpleFIN and keys', () => {
  it('sends the pasted setup token once and clears it', async () => {
    mocked.simplefin.mockResolvedValue({ connectionIds: ['conn_sf'], repaired: false });
    const onLinked = jest.fn();
    await render(<SimplefinFlow connector="simplefin" onLinked={onLinked} />);
    await fireEvent.changeText(
      screen.getByTestId('simplefin-token'),
      'aHR0cHM6Ly9icmlkZ2UuZXhhbXBsZS5pbnZhbGlkL2NsYWltL2RlbW8=',
    );
    await fireEvent.press(screen.getByTestId('simplefin-connect'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_sf'], false));
  });

  it('tells you to make read-only keys for Coinbase and WazirX', async () => {
    await render(<KeysFlow connector="coinbase" onLinked={jest.fn()} />);
    expect(screen.getByTestId('keys-help').props.children).toMatch(/read-only key.*only View/);
    await render(<KeysFlow connector="wazirx" onLinked={jest.fn()} />);
    expect(screen.getByTestId('keys-help').props.children).toMatch(
      /read-only key.*trading and withdrawals off/,
    );
  });
});
