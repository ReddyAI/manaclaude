import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { AssistantsSection } from '../../settings/sections/AssistantsSection';
import { ConnectAssistantScreen } from '../ConnectAssistantScreen';
import {
  checkDraft,
  LOST_TEXT,
  mcpServerUrl,
  NOT_CONFIGURED_TEXT,
  redirectProblem,
  SUPERSEDED_TEXT,
} from '../mcpClient';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
const clip = Clipboard.setStringAsync as jest.Mock;

// Invented values only.
const CLIENT_ID = 'demo-client-1f2e';
const SECRET = 'demo-secret-4b9c7d1e0a';
const REDIRECT = 'https://assistant.demo.test/oauth/callback';
const CREATE = 'POST /v1/mcp/clients';

let backend: ReturnType<typeof fakeBackend>;
afterEach(() => backend?.restore());
beforeEach(() => {
  jest.clearAllMocks();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
async function fill(name = 'Perplexity', redirect = REDIRECT) {
  await fireEvent.changeText(screen.getByTestId('mcp-name'), name);
  await fireEvent.changeText(screen.getByTestId('mcp-redirect-0'), redirect);
}
const made = () => json(201, { clientId: CLIENT_ID, clientSecret: SECRET });

describe('the MCP client form', () => {
  it('gives the server address as the Worker URL plus /mcp', () => {
    expect(mcpServerUrl('https://api.demo.test/')).toBe('https://api.demo.test/mcp');
    expect(mcpServerUrl('api.demo.test')).toBe('https://api.demo.test/mcp');
    expect(mcpServerUrl('')).toBe('');
  });

  it('builds the exact body, trimmed, and refuses what the Worker would', () => {
    expect(checkDraft({ name: '  Perplexity ', redirects: [` ${REDIRECT} `] }).body).toEqual({
      name: 'Perplexity',
      redirectUris: [REDIRECT],
    });
    expect(checkDraft({ name: ' ', redirects: [REDIRECT] }).body).toBeNull();
    expect(checkDraft({ name: 'x'.repeat(101), redirects: [REDIRECT] }).name).toBe(
      'At most 100 characters.',
    );
    expect(checkDraft({ name: 'P', redirects: [REDIRECT, REDIRECT] }).redirects).toEqual({
      1: 'This address is already in the list.',
    });
    expect(checkDraft({ name: 'P', redirects: [] }).ok).toBe(false);
    const six = [1, 2, 3, 4, 5, 6].map((n) => `${REDIRECT}/${n}`);
    expect(checkDraft({ name: 'P', redirects: six.slice(0, 5) }).ok).toBe(true);
    expect(checkDraft({ name: 'P', redirects: six }).redirects).toEqual({
      5: 'At most 5 addresses.',
    });
    expect(redirectProblem('http://assistant.demo.test/cb')).toMatch(/https/);
    expect(redirectProblem('http://localhost:3000/cb')).toBeNull();
    expect(redirectProblem('not a url')).toMatch(/not a web address/);
  });
});

describe('connecting an assistant', () => {
  it('sends the name and addresses once, then shows the ID and secret once with a warning', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    backend = fakeBackend({ [CREATE]: made });
    await render(<ConnectAssistantScreen />);
    expect(screen.getByTestId('mcp-server-url').props.children).toBe('https://api.demo.test/mcp');
    await fill(' Perplexity ');
    await press('mcp-redirect-add');
    await fireEvent.changeText(
      screen.getByTestId('mcp-redirect-1'),
      'https://assistant.demo.test/cb2',
    );
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-client-secret')).toBeTruthy());
    expect(backend.sent(CREATE)).toHaveLength(1);
    expect(backend.sent(CREATE)[0]!.body).toEqual({
      name: 'Perplexity',
      redirectUris: [REDIRECT, 'https://assistant.demo.test/cb2'],
    });
    expect(screen.getByTestId('mcp-made').props.children).toBe('Client made for "Perplexity"');
    expect(screen.getByTestId('mcp-client-id').props.children).toBe(CLIENT_ID);
    expect(screen.getByTestId('mcp-client-secret').props.children).toBe(SECRET);
    expect(screen.getByTestId('mcp-secret-warning').props.children).toBe(
      "This secret is shown only now and can't be shown again.",
    );

    // Never written to the device, never logged.
    await settle();
    const keys = await AsyncStorage.getAllKeys();
    const stored = await AsyncStorage.multiGet(keys);
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify((SecureStore.setItemAsync as jest.Mock).mock.calls)).not.toContain(
      SECRET,
    );
    for (const spy of [log, info]) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    log.mockRestore();
    info.mockRestore();

    // Done takes it off the screen for good.
    await press('mcp-done');
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByTestId('mcp-client-secret')).toBeNull();
    expect(screen.getByTestId('mcp-name').props.value).toBe('');
  });

  it('copies the secret marked sensitive and the ID and address as plain text', async () => {
    backend = fakeBackend({ [CREATE]: made });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-client-secret')).toBeTruthy());
    await press('mcp-client-secret-copy');
    await press('mcp-client-id-copy');
    await press('mcp-server-url-copy');
    await settle();
    expect(clip.mock.calls).toEqual([
      [SECRET, { android: { isSensitive: true } }],
      [CLIENT_ID, undefined],
      ['https://api.demo.test/mcp', undefined],
    ]);
    expect(screen.getAllByText('Copied.')).toHaveLength(3);
  });

  it('says how to copy by hand when copying fails', async () => {
    clip.mockImplementationOnce(async () => {
      throw new Error('no clipboard');
    });
    backend = fakeBackend({});
    await render(<ConnectAssistantScreen />);
    await press('mcp-server-url-copy');
    await waitFor(() => expect(screen.getByText(/Copying didn't work here/)).toBeTruthy());
  });

  it('shows only the ID when the Worker made a client without a secret', async () => {
    backend = fakeBackend({
      [CREATE]: () => json(201, { clientId: CLIENT_ID, clientSecret: null }),
    });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-no-secret')).toBeTruthy());
    expect(screen.queryByTestId('mcp-client-secret')).toBeNull();
  });

  it('sends nothing while the form has a problem', async () => {
    backend = fakeBackend({ [CREATE]: made });
    await render(<ConnectAssistantScreen />);
    await fill('Perplexity', 'http://assistant.demo.test/cb');
    await press('mcp-create');
    expect(screen.getByText('Use an https:// address (http:// only for localhost).')).toBeTruthy();
    await fill('', REDIRECT);
    await press('mcp-create');
    expect(screen.getByText('Give the assistant a name, for example "Perplexity".')).toBeTruthy();
    expect(backend.sent(CREATE)).toHaveLength(0);
  });

  it('offers at most five addresses', async () => {
    backend = fakeBackend({});
    await render(<ConnectAssistantScreen />);
    for (let i = 0; i < 4; i += 1) await press('mcp-redirect-add');
    expect(screen.getByTestId('mcp-redirect-4')).toBeTruthy();
    expect(screen.queryByTestId('mcp-redirect-add')).toBeNull();
    await press('mcp-redirect-remove-4');
    expect(screen.getByTestId('mcp-redirect-add')).toBeTruthy();
  });

  it('makes one client for a fast double tap', async () => {
    const answer = held();
    backend = fakeBackend({ [CREATE]: () => answer.promise });
    await render(<ConnectAssistantScreen />);
    await fill();
    await act(async () => {
      fireEvent.press(screen.getByTestId('mcp-create'));
      fireEvent.press(screen.getByTestId('mcp-create'));
    });
    expect(backend.sent(CREATE)).toHaveLength(1);
    await act(async () => answer.release(201, { clientId: CLIENT_ID, clientSecret: SECRET }));
    await waitFor(() => expect(screen.getByTestId('mcp-client-secret')).toBeTruthy());
    expect(backend.sent(CREATE)).toHaveLength(1);
  });

  it('explains 503 not_configured in plain words and keeps the form', async () => {
    backend = fakeBackend({
      [CREATE]: () => json(503, { error: 'not_configured', message: 'OAuth is not available.' }),
    });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-failure')).toBeTruthy());
    expect(screen.getByTestId('mcp-failure').props.children).toBe(NOT_CONFIGURED_TEXT);
    expect(screen.getByTestId('mcp-name').props.value).toBe('Perplexity');
  });

  it("passes on the Worker's reason for a refused body", async () => {
    backend = fakeBackend({
      [CREATE]: () => json(400, { error: 'invalid_body', message: 'redirectUris.0: Invalid URL' }),
    });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-failure')).toBeTruthy());
    expect(screen.getByTestId('mcp-failure').props.children).toBe(
      'Nothing was made. redirectUris.0: Invalid URL',
    );
  });

  it.each([
    ['a lost answer', (a: ReturnType<typeof held>) => a.fail()],
    ['a server failure', (a: ReturnType<typeof held>) => a.release(500, { error: 'internal' })],
  ])('after %s, says a client may exist and never sends again by itself', async (_, end) => {
    const answer = held();
    backend = fakeBackend({ [CREATE]: () => answer.promise });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await act(async () => end(answer));
    await waitFor(() => expect(screen.getByTestId('mcp-failure')).toBeTruthy());
    expect(screen.getByTestId('mcp-failure').props.children).toBe(LOST_TEXT);
    await settle(20);
    expect(backend.sent(CREATE)).toHaveLength(1);
  });

  it('drops the secret when the backend changes', async () => {
    backend = fakeBackend({ [CREATE]: made });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-client-secret')).toBeTruthy());
    await act(async () =>
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' }),
    );
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.getByTestId('mcp-server-url').props.children).toBe('https://other.demo.test/mcp');
  });

  it('drops an answer that arrives after the backend changed and says a client may exist there', async () => {
    const answer = held();
    backend = fakeBackend({ [CREATE]: () => answer.promise });
    await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await act(async () =>
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' }),
    );
    await act(async () => answer.release(201, { clientId: CLIENT_ID, clientSecret: SECRET }));
    await waitFor(() => expect(screen.getByTestId('mcp-failure')).toBeTruthy());
    expect(screen.getByTestId('mcp-failure').props.children).toBe(SUPERSEDED_TEXT);
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('is gone when the screen closes', async () => {
    backend = fakeBackend({ [CREATE]: made });
    const view = await render(<ConnectAssistantScreen />);
    await fill();
    await press('mcp-create');
    await waitFor(() => expect(screen.getByTestId('mcp-client-secret')).toBeTruthy());
    await view.unmount();
    await render(<ConnectAssistantScreen />);
    expect(screen.queryByText(SECRET)).toBeNull();
    expect(screen.queryByTestId('mcp-client-secret')).toBeNull();
  });

  it('asks for the backend first when none is set', async () => {
    setBackendConfigForTests({ url: '', token: '' });
    await render(<ConnectAssistantScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
  });
});

describe('AI assistants in Settings', () => {
  it('shows the MCP address with a copy button and a way in', async () => {
    await render(<AssistantsSection />);
    expect(screen.getByTestId('settings-mcp-url').props.children).toBe('https://api.demo.test/mcp');
    await press('settings-mcp-url-copy');
    await waitFor(() => expect(screen.getByText('Copied.')).toBeTruthy());
    expect(clip).toHaveBeenCalledWith('https://api.demo.test/mcp', undefined);
    expect(screen.getByTestId('settings-assistants')).toBeTruthy();
  });

  it('says the backend is needed when none is set', async () => {
    setBackendConfigForTests({ url: '', token: '' });
    await render(<AssistantsSection />);
    expect(screen.getByText('Needs the backend')).toBeTruthy();
    expect(screen.queryByTestId('settings-assistants')).toBeNull();
  });
});
