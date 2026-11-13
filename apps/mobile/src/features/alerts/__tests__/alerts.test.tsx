import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Alert } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { router } from 'expo-router';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { setBackendStatus } from '../../../data/backend/status';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { setFinance } from '../../../data/store';
import { AlertsEntry } from '../AlertsEntry';
import { AlertsScreen } from '../AlertsScreen';
import { dismiss, getAlertsState, loadAlerts, resetAlertsForTests } from '../alertsStore';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

/** Invented alerts in the shape GET /v1/alerts sends. */
const data = createSampleData();
const txn = data.transactions.find((t) => t.amount < 0)!;
const alert = (id: string, patch: Partial<Alert> = {}): Alert => ({
  id,
  type: 'duplicate',
  transactionId: null,
  recurringId: null,
  message: `Message of ${id}`,
  amount: null,
  currency: null,
  createdAt: '2026-11-04T06:30:00.000Z',
  dismissedAt: null,
  ...patch,
});
const THREE = [
  alert('alr_dup', {
    transactionId: txn.id,
    message: 'Corner Cafe was charged twice (4.50 USD). Check whether both are real.',
    amount: 4_50,
    currency: 'USD',
  }),
  alert('alr_big', {
    type: 'unusual',
    transactionId: 'txn_not_on_this_device',
    message: 'Hardware Store is 310.00 USD, about 6x the usual 52.00.',
    amount: 310_00,
    currency: 'USD',
  }),
  alert('alr_up', {
    type: 'price_increase',
    recurringId: 'rec_stream',
    message: 'Streamly went up from 9.99 to 12.99 USD.',
    amount: 3_00,
    currency: 'USD',
  }),
];

const LIST = 'GET /v1/alerts';
const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const shown = () => getAlertsState().alerts?.map((a) => a.id);

let backend: ReturnType<typeof fakeBackend>;
/** A Worker that lists `alerts` and takes dismissals. */
function worker(alerts: Alert[], extra: Parameters<typeof fakeBackend>[0] = {}) {
  backend = fakeBackend({
    [LIST]: () => json(200, { alerts }),
    ...Object.fromEntries(
      alerts.map((a) => [`POST /v1/alerts/${a.id}/dismiss`, () => json(200, { ok: true })]),
    ),
    ...extra,
  });
  return backend;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetAlertsForTests();
  setFinance(data);
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('alerts screen', () => {
  it('lists what the Worker sends, with the kind, the message and the amount', async () => {
    worker(THREE);
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alerts-count')).toBeTruthy());
    expect(screen.getByTestId('alerts-count').props.children).toBe('3 alerts');
    expect(screen.getByText('Possible duplicate')).toBeTruthy();
    expect(screen.getByText('Unusual charge')).toBeTruthy();
    expect(screen.getByText('Price went up')).toBeTruthy();
    expect(screen.getByText('Streamly went up from 9.99 to 12.99 USD.')).toBeTruthy();
    expect(screen.getByText('More than before')).toBeTruthy();
    expect(backend.sent(LIST)).toHaveLength(1);
    expect(backend.sent(LIST)[0]!.token).toBe('Bearer demo-token');
  });

  it('opens the transaction only when it is in the data on this device', async () => {
    worker(THREE);
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alert-alr_dup')).toBeTruthy());
    await press('alert-open-alr_dup');
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/transactions/[id]',
      params: { id: txn.id },
    });
    expect(screen.queryByTestId('alert-open-alr_big')).toBeNull();
    expect(screen.getByTestId('alert-no-transaction-alr_big')).toBeTruthy();
    await press('alert-recurring-alr_up');
    expect(router.navigate).toHaveBeenCalledWith('/recurring');
  });

  it('shows an alert of a kind it does not know, with no amount', async () => {
    worker([alert('alr_new', { type: 'low_balance' as never, message: 'Something new.' })]);
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByText('Something new.')).toBeTruthy());
    expect(screen.getByText('Alert')).toBeTruthy();
    expect(screen.getByTestId('alerts-count').props.children).toBe('1 alert');
  });

  it('removes an alert only after the Worker confirmed the dismissal', async () => {
    const answer = held();
    worker(THREE, { 'POST /v1/alerts/alr_big/dismiss': () => answer.promise });
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alert-alr_big')).toBeTruthy());
    await press('alert-dismiss-alr_big');
    // Still listed while the request is on its way, and a second tap sends nothing more.
    expect(screen.getByTestId('alert-alr_big')).toBeTruthy();
    await press('alert-dismiss-alr_big');
    expect(backend.sent('POST /v1/alerts/alr_big/dismiss')).toHaveLength(1);
    await act(async () => {
      answer.release(200, { ok: true });
      await settle();
    });
    expect(screen.queryByTestId('alert-alr_big')).toBeNull();
    expect(screen.getByTestId('alerts-count').props.children).toBe('2 alerts');
  });

  it('keeps the alert and says why when the dismissal fails', async () => {
    worker(THREE, {
      'POST /v1/alerts/alr_dup/dismiss': () => Promise.reject(new TypeError('offline')),
    });
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alert-alr_dup')).toBeTruthy());
    await press('alert-dismiss-alr_dup');
    await waitFor(() => expect(screen.getByTestId('alerts-error')).toBeTruthy());
    expect(screen.getByTestId('alerts-error').props.children).toMatch(/can't be reached/);
    expect(screen.getByTestId('alert-alr_dup')).toBeTruthy();
    expect(shown()).toEqual(['alr_dup', 'alr_big', 'alr_up']);
  });

  it('does not bring a dismissed alert back with a list that was asked for earlier', async () => {
    const first = json(200, { alerts: THREE });
    const slow = held();
    let lists = 0;
    worker(THREE, { [LIST]: () => (++lists === 1 ? first : slow.promise) });
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alert-alr_up')).toBeTruthy());
    await press('alerts-reload');
    await press('alert-dismiss-alr_up');
    await waitFor(() => expect(screen.queryByTestId('alert-alr_up')).toBeNull());
    // The reload was sent before the dismissal and still lists the alert.
    await act(async () => {
      slow.release(200, { alerts: THREE });
      await settle();
    });
    expect(shown()).toEqual(['alr_dup', 'alr_big']);
  });

  it('says so when there are none, and when the list cannot be loaded', async () => {
    worker([]);
    const view = await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByText('No alerts')).toBeTruthy());
    await view.unmount();
    backend.restore();
    resetAlertsForTests();
    backend = fakeBackend({ [LIST]: () => json(401, { error: 'unauthorized', message: '' }) });
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alerts-error')).toBeTruthy());
    expect(screen.getByTestId('alerts-error').props.children).toMatch(/API token is wrong/);
    expect(screen.queryByText('No alerts')).toBeNull();
  });

  it('says when the list is at the limit of what the Worker sends at once', async () => {
    worker(Array.from({ length: 100 }, (_, i) => alert(`alr_${i}`)));
    await render(<AlertsScreen />);
    await waitFor(() => expect(screen.getByTestId('alerts-count')).toBeTruthy());
    expect(screen.getByText(/These are the newest 100/)).toBeTruthy();
  });

  it('asks for the backend when it is not set, and sends nothing', async () => {
    worker(THREE);
    setBackendConfigForTests({ token: '' });
    await render(<AlertsScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
    expect(backend.calls).toHaveLength(0);
  });
});

describe('alerts and a changed backend', () => {
  it("drops one backend's alerts at once and ignores its late answers", async () => {
    worker(THREE);
    await loadAlerts();
    expect(shown()).toHaveLength(3);
    backend.restore();

    // Another backend is selected while a reload and a dismissal for the old one are on their way.
    const lateList = held();
    backend = fakeBackend({ [LIST]: () => lateList.promise });
    const reload = loadAlerts();
    await act(async () => setBackendConfigForTests({ url: 'https://other.demo.test' }));
    expect(getAlertsState().alerts).toBeNull();
    lateList.release(200, { alerts: THREE });
    await reload;
    await settle();
    expect(getAlertsState()).toMatchObject({ alerts: null, error: null, loading: false });
  });

  it('forgets everything when the token is forgotten', async () => {
    worker(THREE);
    await loadAlerts();
    await act(async () => setBackendConfigForTests({ token: '' }));
    expect(getAlertsState().alerts).toBeNull();
    await loadAlerts();
    expect(backend.sent(LIST)).toHaveLength(1);
    expect(getAlertsState().error).toBeNull();
  });

  it('sends one dismissal when asked twice for the same alert', async () => {
    const answer = held();
    worker(THREE, { 'POST /v1/alerts/alr_up/dismiss': () => answer.promise });
    await loadAlerts();
    const first = dismiss('alr_up');
    const second = dismiss('alr_up');
    answer.release(200, { ok: true });
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(backend.sent('POST /v1/alerts/alr_up/dismiss')).toHaveLength(1);
    expect(shown()).toEqual(['alr_dup', 'alr_big']);
  });
});

describe('the alerts row on Home', () => {
  it('is not shown without a backend', async () => {
    worker(THREE);
    setBackendConfigForTests({ token: '' });
    await render(<AlertsEntry />);
    expect(screen.queryByTestId('alerts-entry')).toBeNull();
    expect(backend.calls).toHaveLength(0);
  });

  it('shows the count, follows a dismissal, and opens the screen', async () => {
    worker(THREE);
    await render(
      <>
        <AlertsEntry />
        <AlertsScreen />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText('3 alerts')).toHaveLength(2));
    // Two parts of the app asked at the same moment: one request.
    expect(backend.sent(LIST)).toHaveLength(1);
    await press('alert-dismiss-alr_dup');
    await waitFor(() => expect(screen.getAllByText('2 alerts')).toHaveLength(2));
    await fireEvent.press(screen.getByLabelText('Alerts'));
    expect(router.navigate).toHaveBeenCalledWith('/alerts');
  });

  it('reads "No alerts" when there are none, and reloads when the data was loaded again', async () => {
    worker([]);
    await render(<AlertsEntry />);
    await waitFor(() => expect(screen.getByText('No alerts')).toBeTruthy());
    expect(backend.sent(LIST)).toHaveLength(1);
    await act(async () => {
      setBackendStatus({ lastLoadedAt: '2026-11-05T12:01:00.000Z' });
      await settle();
    });
    expect(backend.sent(LIST)).toHaveLength(2);
  });

  it('says the list could not be loaded instead of "No alerts"', async () => {
    backend = fakeBackend({ [LIST]: () => json(500, { error: 'internal', message: '' }) });
    await render(<AlertsEntry />);
    await waitFor(() =>
      expect(screen.getByText('Could not be loaded. Open to try again.')).toBeTruthy(),
    );
    expect(screen.queryByText('No alerts')).toBeNull();
  });
});
