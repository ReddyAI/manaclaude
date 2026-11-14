import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { SophtronLinkStatus } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { BackendError } from '../../../data/backend/client';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { refreshDataset } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { BrowserFlow } from '../BrowserFlow';
import { linkApi, syncUntilDone } from '../linkApi';
import { startRepair } from '../repair';
import { SophtronFlow } from '../SophtronFlow';
import { sophtronTiming } from '../sophtronPoll';
import { SyncStep } from '../SyncStep';

/**
 * Safer linking (the phone's half of review findings 10 and 11). The Worker
 * and the browser are stand-ins; every name and id is invented.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-linking', () => ({ createURL: (path: string) => `billionaire://${path}` }));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../../data/backend/sync', () => ({
  refreshDataset: jest.fn(),
  canSaveToBackend: jest.fn(),
}));
jest.mock('../linkApi', () => {
  const actual = jest.requireActual('../linkApi');
  return {
    ...actual,
    syncUntilDone: jest.fn(),
    linkApi: Object.fromEntries(Object.keys(actual.linkApi).map((k) => [k, jest.fn()])),
  };
});

const mocked = linkApi as unknown as Record<keyof typeof linkApi, jest.Mock>;
const reload = refreshDataset as jest.Mock;
const sync = syncUntilDone as jest.Mock;
const browser = WebBrowser.openAuthSessionAsync as jest.Mock;

const REAL_TIMING = { ...sophtronTiming };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** An answer the test lets go later, to play a slow Worker. */
function held<T>() {
  let release!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

const offline = () => new BackendError(0, 'offline', "The backend can't be reached.");
const pending = (linkId = 'link_1'): SophtronLinkStatus => ({ linkId, status: 'pending' });
const BANK = 'Summit Card Services';
/** Search, pick the bank, enter the sign-in and press Connect. */
async function signIn() {
  mocked.sophtronSearch.mockResolvedValue({
    institutions: [{ id: 'inst-1', name: BANK, url: null }],
  });
  await fireEvent.changeText(screen.getByTestId('sophtron-search'), 'summit');
  await fireEvent.press(screen.getByTestId('sophtron-search-go'));
  await waitFor(() => expect(screen.getByText(BANK)).toBeTruthy());
  await fireEvent.press(screen.getByText(BANK));
  await fireEvent.changeText(screen.getByTestId('sophtron-user'), 'demo-user');
  await fireEvent.changeText(screen.getByTestId('sophtron-password'), 'demo-password');
  await fireEvent.press(screen.getByTestId('sophtron-connect'));
}

beforeEach(() => {
  jest.clearAllMocks();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  setFinance(createSampleData());
  Object.assign(sophtronTiming, REAL_TIMING, { pollMs: 5 });
  reload.mockResolvedValue(true);
  mocked.sophtronStart.mockResolvedValue(pending());
});

afterAll(() => {
  Object.assign(sophtronTiming, REAL_TIMING);
});

describe('Sophtron: one status request at a time', () => {
  it('waits for each answer before it asks again', async () => {
    const first = held<SophtronLinkStatus>();
    const second = held<SophtronLinkStatus>();
    mocked.sophtronStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1));
    // Many poll intervals pass while the first answer is still on its way.
    await pause(80);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);

    first.release(pending());
    await waitFor(() => expect(mocked.sophtronStatus).toHaveBeenCalledTimes(2));
    await pause(80);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(2);

    second.release({
      linkId: 'link_1',
      status: 'done',
      connectionIds: ['conn_s'],
      repaired: false,
    });
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(2);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('stops asking when the screen is left', async () => {
    const first = held<SophtronLinkStatus>();
    mocked.sophtronStatus.mockReturnValueOnce(first.promise).mockResolvedValue(pending());
    const onLinked = jest.fn();
    const view = await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1));
    await view.unmount();
    first.release(pending());
    await pause(60);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('tries again after a request that got no answer', async () => {
    mocked.sophtronStatus
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce(pending())
      .mockResolvedValueOnce({
        linkId: 'link_1',
        status: 'done',
        connectionIds: ['conn_s'],
        repaired: false,
      });
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(3);
  });

  it('stops after three failures in a row and can check the same sign-in again', async () => {
    mocked.sophtronStatus
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce({
        linkId: 'link_1',
        status: 'done',
        connectionIds: ['conn_s'],
        repaired: false,
      });
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-stalled')).toBeTruthy());
    expect(screen.getByTestId('sophtron-stalled').props.children).toMatch(
      /can't be reached.*Check again before you start a new one/,
    );
    await pause(40);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(3);
    expect(onLinked).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('sophtron-check-again'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    expect(mocked.sophtronStatus).toHaveBeenLastCalledWith('link_1');
    // The same sign-in was checked; the bank was not signed in to a second time.
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('does not wait forever: stops at the limit and offers to check again', async () => {
    sophtronTiming.maxPolls = 3;
    mocked.sophtronStatus.mockResolvedValue(pending());
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-stalled')).toBeTruthy());
    expect(screen.getByTestId('sophtron-stalled').props.children).toMatch(/taking longer/);
    expect(screen.queryByLabelText('Signing in')).toBeNull();
    await pause(40);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(3);
  });

  it('goes back to the start when the sign-in has expired on the Worker', async () => {
    mocked.sophtronStatus.mockRejectedValue(
      new BackendError(404, 'not_found', 'This sign-in has expired. Start again.'),
    );
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    expect(screen.getByText('This sign-in has expired. Start again.')).toBeTruthy();
    expect(screen.getByTestId('sophtron-search')).toBeTruthy();
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);
  });
});

describe('SnapTrade and Zerodha in the browser', () => {
  const backWith = (status: string, message?: string) => ({
    type: 'success',
    url: `billionaire://link?link=snaptrade&status=${status}${message ? `&message=${encodeURIComponent(message)}` : ''}`,
  });

  beforeEach(() => {
    mocked.snaptradeStart.mockResolvedValue({ linkId: 'link_st', url: 'https://portal.test/x' });
    mocked.kiteStart.mockResolvedValue({ linkId: 'link_k', url: 'https://kite.test/x' });
  });

  it('completes a login that came back as finished', async () => {
    browser.mockResolvedValue(backWith('ok'));
    mocked.snaptradeComplete.mockResolvedValue({ connectionIds: ['conn_st'], repaired: false });
    const onLinked = jest.fn();
    await render(<BrowserFlow connector="snaptrade" onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_st'], false));
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
    expect(mocked.snaptradeComplete).toHaveBeenCalledWith('link_st');
  });

  it.each(['cancel', 'dismiss'])(
    'repair: a %sed window completes nothing and never reports a repair',
    async (type) => {
      browser.mockResolvedValue({ type });
      mocked.snaptradeComplete.mockResolvedValue({
        connectionIds: ['conn_snaptrade_northfield'],
        repaired: true,
      });
      const onLinked = jest.fn();
      await render(
        <BrowserFlow
          connector="snaptrade"
          connectionId="conn_snaptrade_northfield"
          onLinked={onLinked}
        />,
      );
      await fireEvent.press(screen.getByTestId('browser-open'));
      await waitFor(() => expect(screen.getByTestId('browser-closed')).toBeTruthy());
      expect(screen.getByTestId('browser-closed').props.children).toMatch(
        /closed before the login finished, so nothing was changed.*still needs repair/,
      );
      await pause(20);
      expect(mocked.snaptradeComplete).not.toHaveBeenCalled();
      expect(onLinked).not.toHaveBeenCalled();
      // No way to claim a cancelled repair as finished: only opening it again.
      expect(screen.queryByTestId('browser-done')).toBeNull();
      expect(screen.getByTestId('browser-open')).toBeTruthy();
    },
  );

  it('new link: a closed window completes nothing by itself; finishing is your own tap', async () => {
    browser.mockResolvedValue({ type: 'cancel' });
    mocked.snaptradeComplete.mockResolvedValue({ connectionIds: ['conn_st'], repaired: false });
    const onLinked = jest.fn();
    await render(<BrowserFlow connector="snaptrade" onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(screen.getByTestId('browser-closed')).toBeTruthy());
    await pause(20);
    expect(mocked.snaptradeComplete).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('browser-done'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_st'], false));
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
  });

  it('new link: saying you finished when you did not shows the Worker’s answer', async () => {
    browser.mockResolvedValue({ type: 'cancel' });
    mocked.snaptradeComplete.mockRejectedValue(
      new BackendError(409, 'not_finished', 'No new brokerage found yet.'),
    );
    const onLinked = jest.fn();
    await render(<BrowserFlow connector="snaptrade" onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(screen.getByTestId('browser-done')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('browser-done'));
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    expect(screen.getByTestId('link-error').props.children).toMatch(/No new brokerage yet/);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('a login that came back with an error completes nothing', async () => {
    browser.mockResolvedValue(backWith('error', 'The brokerage refused the login.'));
    const onLinked = jest.fn();
    await render(
      <BrowserFlow
        connector="snaptrade"
        connectionId="conn_snaptrade_northfield"
        onLinked={onLinked}
      />,
    );
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    expect(screen.getByText('The brokerage refused the login.')).toBeTruthy();
    expect(mocked.snaptradeComplete).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(screen.queryByTestId('browser-done')).toBeNull();
  });

  it('Zerodha: a closed window is not a login, even though the connection exists', async () => {
    browser.mockResolvedValue({ type: 'dismiss' });
    const onLinked = jest.fn();
    await render(
      <BrowserFlow connector="zerodha_kite" connectionId="conn_kite" onLinked={onLinked} />,
    );
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(screen.getByTestId('browser-closed')).toBeTruthy());
    expect(reload).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
    expect(screen.queryByTestId('browser-done')).toBeNull();
  });

  it('web: opening the tab completes nothing; Done is your own tap', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      browser.mockResolvedValue({ type: 'dismiss' });
      mocked.snaptradeComplete.mockResolvedValue({ connectionIds: ['conn_st'], repaired: false });
      const onLinked = jest.fn();
      await render(<BrowserFlow connector="snaptrade" onLinked={onLinked} />);
      await fireEvent.press(screen.getByTestId('browser-open'));
      await waitFor(() => expect(screen.getByTestId('browser-done')).toBeTruthy());
      await pause(20);
      expect(mocked.snaptradeComplete).not.toHaveBeenCalled();
      expect(screen.queryByTestId('browser-closed')).toBeNull();
      await fireEvent.press(screen.getByTestId('browser-done'));
      await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_st'], false));
    } finally {
      os.restore();
    }
  });
});

describe('After a repair, the sync is the proof', () => {
  const report = (outcome: string, error: string | null = null) => ({
    connectionId: 'conn_snaptrade_northfield',
    connectorId: 'snaptrade',
    outcome,
    more: false,
    status: outcome === 'ok' ? 'healthy' : 'needs_repair',
    error,
    summary: null,
  });

  it('does not say Repaired before the sync has worked', async () => {
    const running = held<ReturnType<typeof report>>();
    sync.mockReturnValue(running.promise);
    await render(<SyncStep connectionIds={['conn_snaptrade_northfield']} repaired />);
    expect(screen.getByTestId('sync-headline').props.children).toBe(
      'Checking the login with a sync...',
    );
    expect(screen.queryByText(/Repaired/)).toBeNull();
    running.release(report('ok'));
    await waitFor(() =>
      expect(screen.getByTestId('sync-headline').props.children).toBe('Repaired and synced'),
    );
    expect(sync).toHaveBeenCalledWith('conn_snaptrade_northfield', expect.any(Function), {
      force: true,
    });
  });

  it.each([
    ['needs_repair', 'The brokerage asks you to sign in again.'],
    ['error', 'SnapTrade is not set up: missing a key'],
    ['skipped', null],
  ])('reports the repair as not confirmed when the sync ends as %s', async (outcome, error) => {
    sync.mockResolvedValue(report(outcome, error));
    await render(<SyncStep connectionIds={['conn_snaptrade_northfield']} repaired />);
    await waitFor(() =>
      expect(screen.getByTestId('sync-headline').props.children).toBe(
        'The repair is not confirmed',
      ),
    );
    expect(screen.queryByText(/Repaired/)).toBeNull();
    expect(screen.getByTestId('sync-progress').props.children).toMatch(
      /the connection keeps its error/,
    );
    // The Worker's message ends as a sentence before the app's own follows.
    if (error)
      expect(screen.getByTestId('sync-progress').props.children).toContain(
        `${error.replace(/\.$/, '')}. The sync after the repair`,
      );
  });

  it('a new link keeps its wording', async () => {
    sync.mockResolvedValue(report('ok'));
    await render(<SyncStep connectionIds={['conn_st']} repaired={false} />);
    await waitFor(() => expect(screen.getByTestId('sync-headline').props.children).toBe('All set'));
  });

  it('Zerodha one-tap repair: connected again only when the sync worked', async () => {
    mocked.kiteStart.mockResolvedValue({ linkId: 'link_k', url: 'https://kite.test/x' });
    browser.mockResolvedValue({ type: 'success', url: 'billionaire://link?status=ok' });
    const kite = getFinance().connections.find((c) => c.id === 'conn_kite')!;

    sync.mockResolvedValue(report('needs_repair', 'Zerodha asks you to log in again.'));
    const failed = await startRepair(kite);
    expect(failed).toMatch(/Zerodha asks you to log in again\..*not confirmed yet/);
    expect(failed).not.toMatch(/connected again/);

    sync.mockResolvedValue(report('ok'));
    expect(await startRepair(kite)).toBe('Zerodha is connected again.');

    // A closed window: nothing is synced and nothing is claimed.
    sync.mockClear();
    browser.mockResolvedValue({ type: 'cancel' });
    expect(await startRepair(kite)).toBeNull();
    expect(sync).not.toHaveBeenCalled();
  });
});
