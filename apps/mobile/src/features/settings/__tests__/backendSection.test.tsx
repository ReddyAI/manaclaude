import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { http } from '../../../data/backend/client';
import { getBackendConfig, setBackendConfigForTests } from '../../../data/backend/config';
import { BackendSection } from '../sections/BackendSection';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../data/backend/sync', () => ({
  ...jest.requireActual('../../../data/backend/sync'),
  refreshDataset: jest.fn(async () => true),
}));

const realFetch = http.fetch;
afterEach(() => {
  http.fetch = realFetch;
  setBackendConfigForTests({ url: '', token: '' });
});

describe('Settings, Backend', () => {
  it('checks the token with the Worker before saving it, and never shows it again', async () => {
    http.fetch = jest.fn(async () => new Response('{"order":{},"connectors":[]}', { status: 200 }));
    await render(<BackendSection />);
    await fireEvent.changeText(
      screen.getByTestId('backend-url'),
      'manaclaude-api.demo.workers.dev',
    );
    await fireEvent.changeText(screen.getByTestId('backend-token'), 'demo-app-token-0123456789');
    await fireEvent.press(screen.getByTestId('backend-save'));
    await waitFor(() => expect(getBackendConfig().token).toBe('demo-app-token-0123456789'));
    expect(getBackendConfig().url).toBe('https://manaclaude-api.demo.workers.dev');
    const [url] = (http.fetch as jest.Mock).mock.calls[0] as [string];
    expect(url).toBe('https://manaclaude-api.demo.workers.dev/v1/link/options');
    expect(screen.getByTestId('backend-token').props.value).toBe('');
  });

  it('does not save a token the Worker refuses', async () => {
    http.fetch = jest.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }));
    await render(<BackendSection />);
    await fireEvent.changeText(
      screen.getByTestId('backend-url'),
      'https://manaclaude-api.demo.workers.dev',
    );
    await fireEvent.changeText(screen.getByTestId('backend-token'), 'wrong-token-000000');
    await fireEvent.press(screen.getByTestId('backend-save'));
    await waitFor(() => expect(screen.getByText(/API token is wrong/)).toBeTruthy());
    expect(getBackendConfig().token).toBe('');
  });

  it('does not bring a token back when Forget is pressed while Save is still checking', async () => {
    setBackendConfigForTests({
      url: 'https://manaclaude-api.demo.workers.dev',
      token: 'old-token',
    });
    let answer!: (r: Response) => void;
    http.fetch = jest.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    await render(<BackendSection />);
    await fireEvent.changeText(screen.getByTestId('backend-token'), 'new-token-0123456789');
    await fireEvent.press(screen.getByTestId('backend-save'));
    await fireEvent.press(screen.getByText('Forget token'));
    await waitFor(() => expect(getBackendConfig().token).toBe(''));
    await act(async () => {
      answer(new Response('{"order":{},"connectors":[]}', { status: 200 }));
      await new Promise((r) => setImmediate(r));
    });
    expect(getBackendConfig().token).toBe('');
    expect(screen.getByText('Token removed. Showing sample data.')).toBeTruthy();
  });
});
