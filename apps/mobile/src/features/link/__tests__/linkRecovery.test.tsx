import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Connection, SophtronLinkStatus } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { act } from 'react';
import { BackendError } from '../../../data/backend/client';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { refreshDataset } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { BrowserFlow } from '../BrowserFlow';
import { linkApi } from '../linkApi';
import { SophtronFlow } from '../SophtronFlow';
import { sophtronTiming } from '../sophtronPoll';

/**
 * Block N: the app's side of the Worker's recoverable Sophtron completion and
 * verified SnapTrade repair (codex-log "Item 3"). The Worker and the browser
 * are stand-ins; every name, id and answer is invented.
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
  canSaveToBackend: jest.fn(() => true),
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
const browser = WebBrowser.openAuthSessionAsync as jest.Mock;

const REAL_TIMING = { ...sophtronTiming };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const err = (status: number, code: string, message = `HTTP ${status}`) =>
  new BackendError(status, code, message);
const offline = () => err(0, 'offline', "The backend can't be reached.");
const pending = (): SophtronLinkStatus => ({ linkId: 'link_1', status: 'pending' });
const done = (ids: string[], repaired: boolean): SophtronLinkStatus => ({
  linkId: 'link_1',
  status: 'done',
  connectionIds: ids,
  repaired,
});
const mfa = (question = 'First pet?'): SophtronLinkStatus => ({
  linkId: 'link_1',
  status: 'mfa',
  challenge: {
    securityQuestions: [question],
    tokenMethods: [],
    tokenSent: false,
    tokenRead: null,
    captchaImage: null,
  },
});
const BANK = 'Summit Card Services';
const SOPHTRON_REPAIR = 'conn_sophtron_summit';
const SNAP = 'conn_snaptrade_northfield';

function connection(over: Partial<Connection>): Connection {
  return {
    id: 'conn_new',
    connectorId: 'sophtron',
    institutionName: BANK,
    status: 'syncing',
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    syncCursor: null,
    accountIds: [],
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
    ...over,
  };
}

/** The next reload of the data shows these connections. */
function reloadShows(change: (connections: Connection[]) => Connection[], ok = true) {
  reload.mockImplementation(async () => {
    if (!ok) return false;
    const data = getFinance();
    setFinance({ ...data, connections: change(data.connections) });
    return true;
  });
}

function setStatus(id: string, status: Connection['status']) {
  const data = getFinance();
  setFinance({
    ...data,
    connections: data.connections.map((c) => (c.id === id ? { ...c, status } : c)),
  });
}

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

async function answerQuestion(text = 'Rex') {
  await waitFor(() => expect(screen.getByTestId('sophtron-answer-0')).toBeTruthy());
  await fireEvent.changeText(screen.getByTestId('sophtron-answer-0'), text);
  await fireEvent.press(screen.getByTestId('sophtron-send'));
}

const textOf = (id: string) => String(screen.getByTestId(id).props.children);

beforeEach(() => {
  jest.clearAllMocks();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  setFinance(createSampleData());
  Object.assign(sophtronTiming, REAL_TIMING, { pollMs: 5, rateLimitWaitMs: 5 });
  reload.mockResolvedValue(true);
  mocked.sophtronStart.mockResolvedValue(pending());
});

afterAll(() => {
  Object.assign(sophtronTiming, REAL_TIMING);
});

describe('Sophtron: the linkId is kept and only ever asked about', () => {
  it('a done answer goes on with the connection and repaired flag it names', async () => {
    mocked.sophtronStatus.mockResolvedValue(done([SOPHTRON_REPAIR], true));
    const onLinked = jest.fn();
    await render(
      <SophtronFlow connector="sophtron" connectionId={SOPHTRON_REPAIR} onLinked={onLinked} />,
    );
    await fireEvent.press(screen.getByTestId('sophtron-refresh'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith([SOPHTRON_REPAIR], true));
    expect(reload).not.toHaveBeenCalled();
  });

  it('after a 5xx and a timeout, asks again about the same linkId and never starts again', async () => {
    mocked.sophtronStatus
      .mockRejectedValueOnce(err(500, 'internal'))
      .mockRejectedValueOnce(offline())
      .mockResolvedValueOnce(done(['conn_s'], false));
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    expect(mocked.sophtronStatus.mock.calls).toEqual([['link_1'], ['link_1'], ['link_1']]);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('waits longer after a 429 before asking again', async () => {
    sophtronTiming.rateLimitWaitMs = 150;
    const at: number[] = [];
    mocked.sophtronStatus.mockImplementation(async () => {
      at.push(performance.now());
      if (at.length === 1) throw err(429, 'rate_limited', 'Too many requests.');
      return done(['conn_s'], false);
    });
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(140);
    expect(screen.queryByTestId('link-error')).toBeNull();
  });

  it.each([
    ['without the connection', { linkId: 'link_1', status: 'done' } as SophtronLinkStatus],
    ['with an empty connection list', done([], false)],
  ])('a done answer %s is not guessed, even if one appears', async (_name, answer) => {
    mocked.sophtronStatus.mockResolvedValue(answer);
    reloadShows((all) => [...all, connection({})]);
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(onLinked).not.toHaveBeenCalled();
    expect(textOf('sophtron-unconfirmed')).toMatch(/can't confirm how this sign-in ended/);
  });

  it.each([
    ['another connection', done(['conn_other'], true)],
    ['repaired false', done([SOPHTRON_REPAIR], false)],
  ])('a repair answered with %s is not taken as the repair', async (_name, answer) => {
    mocked.sophtronStatus.mockResolvedValue(answer);
    const onLinked = jest.fn();
    await render(
      <SophtronFlow connector="sophtron" connectionId={SOPHTRON_REPAIR} onLinked={onLinked} />,
    );
    await fireEvent.press(screen.getByTestId('sophtron-refresh'));
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(onLinked).not.toHaveBeenCalled();
    expect(textOf('sophtron-unconfirmed')).toMatch(/has not marked anything repaired/);
  });

  it('a 404 ends the sign-in', async () => {
    mocked.sophtronStatus.mockRejectedValue(err(404, 'not_found', 'This sign-in has expired.'));
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    await pause(30);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('sophtron-search')).toBeTruthy();
  });
});

describe('Sophtron: 409 link_result_unavailable', () => {
  const unavailable = () =>
    err(409, 'link_result_unavailable', 'This sign-in result is no longer available.');

  it('reloads Accounts, says it plainly, and starts nothing by itself', async () => {
    mocked.sophtronStatus.mockRejectedValue(unavailable());
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(textOf('sophtron-unconfirmed')).toMatch(
      /can't confirm how this sign-in ended.*has not started another sign-in/,
    );
    expect(textOf('sophtron-reloaded')).toMatch(
      /Accounts has been reloaded.*"Summit Card Services" is there.*not linked twice/,
    );
    await pause(40);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();

    // Starting over is your own tap, and it only goes back to picking a bank.
    await fireEvent.press(screen.getByTestId('sophtron-start-over'));
    expect(screen.getByTestId('sophtron-search')).toBeTruthy();
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('offers no new sign-in until Accounts has been reloaded', async () => {
    mocked.sophtronStatus.mockRejectedValue(unavailable());
    reloadShows((all) => all, false);
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(textOf('sophtron-reloaded')).toMatch(/could not be reloaded/);
    expect(screen.queryByTestId('sophtron-start-over')).toBeNull();

    reload.mockResolvedValue(true);
    await fireEvent.press(screen.getByTestId('sophtron-reload'));
    await waitFor(() => expect(screen.getByTestId('sophtron-start-over')).toBeTruthy());
    expect(reload).toHaveBeenCalledTimes(2);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('on start, the same screen', async () => {
    mocked.sophtronStart.mockRejectedValue(unavailable());
    await render(
      <SophtronFlow connector="sophtron" connectionId={SOPHTRON_REPAIR} onLinked={jest.fn()} />,
    );
    await fireEvent.press(screen.getByTestId('sophtron-refresh'));
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(textOf('sophtron-reloaded')).toMatch(/no longer shows a problem there/);
    expect(mocked.sophtronStatus).not.toHaveBeenCalled();
  });
});

describe('Sophtron: a start whose answer was lost', () => {
  it.each([
    ['no answer', offline()],
    ['a 500', err(500, 'internal')],
    ['a 502', err(502, 'provider_error')],
    ['a 429', err(429, 'rate_limited')],
  ])('after %s, reloads Accounts and never sends start again', async (_name, e) => {
    mocked.sophtronStart.mockRejectedValue(e);
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('sophtron-reloaded')).toBeTruthy());
    expect(textOf('sophtron-unconfirmed')).toMatch(
      /didn't arrive, so a sign-in may have started at the bank anyway. Nothing was sent again/,
    );
    await pause(30);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
    expect(mocked.sophtronStatus).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('a refused start (400) just says why and stays on the form', async () => {
    mocked.sophtronStart.mockRejectedValue(err(400, 'bad_request', 'Enter the password.'));
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    expect(screen.getByTestId('sophtron-connect')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('Sophtron: answers to the bank', () => {
  beforeEach(() => {
    mocked.sophtronStart.mockResolvedValue(mfa());
  });

  it('after an answer with no reply, asks about the same sign-in before asking again', async () => {
    mocked.sophtronAnswer.mockRejectedValueOnce(offline());
    let release!: (s: SophtronLinkStatus) => void;
    mocked.sophtronStatus.mockReturnValueOnce(new Promise((r) => (release = r)));
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await answerQuestion();
    await waitFor(() => expect(mocked.sophtronStatus).toHaveBeenCalledWith('link_1'));
    expect(textOf('sophtron-notice')).toMatch(/may or may not have reached the bank/);
    // No question on screen while the Worker is asked.
    expect(screen.queryByTestId('sophtron-answer-0')).toBeNull();
    await act(async () => release(mfa('Street you grew up on?')));
    await waitFor(() => expect(screen.getByText('Street you grew up on?')).toBeTruthy());
    expect(mocked.sophtronAnswer).toHaveBeenCalledTimes(1);
    expect(mocked.sophtronStart).toHaveBeenCalledTimes(1);
  });

  it('never answers after done: a 404 racing completion is followed by a status check', async () => {
    mocked.sophtronAnswer.mockRejectedValueOnce(err(404, 'not_found'));
    mocked.sophtronStatus.mockResolvedValueOnce(done(['conn_s'], false));
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    await answerQuestion();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_s'], false));
    await pause(30);
    expect(mocked.sophtronAnswer).toHaveBeenCalledTimes(1);
    expect(mocked.sophtronStatus).toHaveBeenCalledTimes(1);
  });

  it('after a 429 on an answer, waits longer before the status check', async () => {
    sophtronTiming.rateLimitWaitMs = 150;
    mocked.sophtronAnswer.mockRejectedValueOnce(err(429, 'rate_limited'));
    mocked.sophtronStatus.mockResolvedValueOnce(done(['conn_s'], false));
    const onLinked = jest.fn();
    await render(<SophtronFlow connector="sophtron" onLinked={onLinked} />);
    await signIn();
    const sent = performance.now();
    await answerQuestion();
    await pause(60);
    expect(mocked.sophtronStatus).not.toHaveBeenCalled();
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(performance.now() - sent).toBeGreaterThanOrEqual(140);
  });

  it('an answer refused outright (400) stays on the question, with no status check', async () => {
    mocked.sophtronAnswer.mockRejectedValueOnce(err(400, 'invalid_body', 'Answer too long.'));
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await answerQuestion();
    await waitFor(() => expect(screen.getByTestId('link-error')).toBeTruthy());
    await pause(30);
    expect(mocked.sophtronStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId('sophtron-answer-0')).toBeTruthy();
  });

  it('two quick taps send one answer', async () => {
    mocked.sophtronStart.mockResolvedValue({
      linkId: 'link_1',
      status: 'mfa',
      challenge: {
        securityQuestions: [],
        tokenMethods: ['Text 555-0100'],
        tokenSent: false,
        tokenRead: null,
        captchaImage: null,
      },
    });
    let release!: (s: SophtronLinkStatus) => void;
    mocked.sophtronAnswer.mockReturnValue(new Promise((r) => (release = r)));
    await render(<SophtronFlow connector="sophtron" onLinked={jest.fn()} />);
    await signIn();
    await waitFor(() => expect(screen.getByText('Text 555-0100')).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByText('Text 555-0100'));
      fireEvent.press(screen.getByText('Text 555-0100'));
    });
    expect(mocked.sophtronAnswer).toHaveBeenCalledTimes(1);
    await act(async () => release(pending()));
  });
});

describe('SnapTrade repair', () => {
  const back = { type: 'success', url: 'billionaire://link?link=snaptrade&status=ok' };

  beforeEach(() => {
    setStatus(SNAP, 'needs_repair');
    mocked.snaptradeStart.mockResolvedValue({ linkId: 'link_st', url: 'https://portal.test/x' });
    browser.mockResolvedValue(back);
  });

  async function repairNow(onLinked = jest.fn()) {
    await render(<BrowserFlow connector="snaptrade" connectionId={SNAP} onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('browser-open'));
    return onLinked;
  }

  it('200 with repaired true is a finished repair', async () => {
    mocked.snaptradeComplete.mockResolvedValue({ connectionIds: [SNAP], repaired: true });
    const onLinked = await repairNow();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith([SNAP], true));
    expect(reload).not.toHaveBeenCalled();
  });

  it('an answer that is not a repair of this connection is not taken as one', async () => {
    mocked.snaptradeComplete.mockResolvedValue({ connectionIds: ['conn_st'], repaired: false });
    const onLinked = await repairNow();
    await waitFor(() => expect(textOf('link-error')).toMatch(/repair is not confirmed/));
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('repair_not_finished: finish in SnapTrade, then retry the same linkId on your tap', async () => {
    mocked.snaptradeComplete
      .mockRejectedValueOnce(err(409, 'repair_not_finished'))
      .mockResolvedValueOnce({ connectionIds: [SNAP], repaired: true });
    const onLinked = await repairNow();
    await waitFor(() => expect(screen.getByTestId('browser-retry')).toBeTruthy());
    expect(textOf('link-error')).toMatch(/Finish reconnecting your brokerage in SnapTrade/);
    await pause(30);
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('browser-retry'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith([SNAP], true));
    expect(mocked.snaptradeComplete.mock.calls).toEqual([['link_st'], ['link_st']]);
    expect(mocked.snaptradeStart).toHaveBeenCalledTimes(1);
  });

  it('connection_changed: reloads Accounts and asks for a new repair, with no retry', async () => {
    mocked.snaptradeComplete.mockRejectedValue(err(409, 'connection_changed'));
    const onLinked = await repairNow();
    await waitFor(() => expect(textOf('link-error')).toMatch(/start a new repair/));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('browser-retry')).toBeNull();
    expect(screen.queryByTestId('browser-done')).toBeNull();
    expect(onLinked).not.toHaveBeenCalled();
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no answer', offline()],
    ['a 500', err(500, 'internal')],
  ])('after %s, reloads Accounts before it offers a retry', async (_name, e) => {
    mocked.snaptradeComplete.mockRejectedValueOnce(e);
    const onLinked = await repairNow();
    await waitFor(() => expect(screen.getByTestId('browser-retry')).toBeTruthy());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(textOf('link-error')).toMatch(/still needs repair/);
    await pause(30);
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('after a lost answer, a repair Accounts shows as saved goes on to its sync', async () => {
    mocked.snaptradeComplete.mockRejectedValueOnce(offline());
    reloadShows((all) => all.map((c) => (c.id === SNAP ? { ...c, status: 'syncing' } : c)));
    const onLinked = await repairNow();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith([SNAP], true));
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
  });

  it('after a lost answer, no retry until Accounts could be reloaded', async () => {
    mocked.snaptradeComplete.mockRejectedValueOnce(offline());
    reloadShows((all) => all, false);
    await repairNow();
    await waitFor(() => expect(screen.getByTestId('browser-reload')).toBeTruthy());
    expect(screen.queryByTestId('browser-retry')).toBeNull();
    expect(textOf('link-error')).toMatch(/could not be reloaded/);

    reload.mockResolvedValue(true);
    await fireEvent.press(screen.getByTestId('browser-reload'));
    await waitFor(() => expect(screen.getByTestId('browser-retry')).toBeTruthy());
    expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
  });

  it('web: while Accounts must be reloaded, Done is not offered either', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'web');
    try {
      browser.mockResolvedValue({ type: 'dismiss' });
      mocked.snaptradeComplete.mockRejectedValueOnce(offline());
      reloadShows((all) => all, false);
      await repairNow();
      await waitFor(() => expect(screen.getByTestId('browser-done')).toBeTruthy());
      await fireEvent.press(screen.getByTestId('browser-done'));
      await waitFor(() => expect(screen.getByTestId('browser-reload')).toBeTruthy());
      expect(screen.queryByTestId('browser-done')).toBeNull();
      expect(screen.queryByTestId('browser-retry')).toBeNull();
      expect(mocked.snaptradeComplete).toHaveBeenCalledTimes(1);
    } finally {
      os.restore();
    }
  });

  it('a retry that gets 404 reloads; a saved repair goes on, otherwise no retry', async () => {
    mocked.snaptradeComplete
      .mockRejectedValueOnce(offline())
      .mockRejectedValueOnce(err(404, 'not_found'));
    const onLinked = await repairNow();
    await waitFor(() => expect(screen.getByTestId('browser-retry')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('browser-retry'));
    await waitFor(() => expect(textOf('link-error')).toMatch(/attempt has ended/));
    expect(screen.queryByTestId('browser-retry')).toBeNull();
    expect(onLinked).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('a 404 after the repair was saved goes on to the sync', async () => {
    mocked.snaptradeComplete.mockRejectedValueOnce(err(404, 'not_found'));
    reloadShows((all) => all.map((c) => (c.id === SNAP ? { ...c, status: 'syncing' } : c)));
    const onLinked = await repairNow();
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith([SNAP], true));
  });

  it('a provider error (502) offers a retry without a reload', async () => {
    mocked.snaptradeComplete.mockRejectedValueOnce(
      err(502, 'provider_error', 'SnapTrade did not answer properly.'),
    );
    await repairNow();
    await waitFor(() => expect(screen.getByTestId('browser-retry')).toBeTruthy());
    expect(reload).not.toHaveBeenCalled();
    expect(textOf('link-error')).toMatch(/SnapTrade did not answer properly/);
  });

  it('a new link: 201 with repaired false goes on as a new link', async () => {
    mocked.snaptradeComplete.mockResolvedValue({ connectionIds: ['conn_st'], repaired: false });
    const onLinked = jest.fn();
    await render(<BrowserFlow connector="snaptrade" onLinked={onLinked} />);
    await fireEvent.press(screen.getByTestId('browser-open'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(['conn_st'], false));
  });
});
