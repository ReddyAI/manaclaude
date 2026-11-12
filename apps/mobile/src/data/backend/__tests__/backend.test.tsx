import { createSampleData } from '@manaclaude/shared/sample';
import { act } from '@testing-library/react-native';
import { getFinance, setFinance, updateFinance } from '../../store';
import { api, BackendError, http } from '../client';
import { isValidUrl, normalizeUrl, setBackendConfigForTests } from '../config';
import { getBackendStatus, persist, refreshDataset } from '../sync';

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

const realFetch = http.fetch;
function reply(status: number, body: unknown) {
  http.fetch = jest.fn(async () => new Response(JSON.stringify(body), { status }));
  return http.fetch as jest.Mock;
}

afterEach(() => {
  http.fetch = realFetch;
  setBackendConfigForTests({ url: '', token: '' });
});

describe('backend settings', () => {
  it('normalizes the Worker address', () => {
    expect(normalizeUrl(' manaclaude-api.demo.workers.dev/ ')).toBe(
      'https://manaclaude-api.demo.workers.dev',
    );
    expect(isValidUrl('https://manaclaude-api.demo.workers.dev')).toBe(true);
    expect(isValidUrl('http://example.com')).toBe(false);
    expect(isValidUrl('http://localhost:8787')).toBe(true);
  });
});

describe('api client', () => {
  beforeEach(() => setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' }));

  it('sends the bearer token and parses JSON', async () => {
    const f = reply(200, { ok: true });
    expect(await api('GET', '/v1/x')).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.demo.test/v1/x');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer demo-token');
  });

  it('says plainly when the token is wrong or the backend is unreachable', async () => {
    reply(401, { error: 'unauthorized', message: 'Missing or wrong API token.' });
    await expect(api('GET', '/v1/x')).rejects.toThrow(/API token is wrong/);
    http.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const err = await api('GET', '/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as BackendError).offline).toBe(true);
    expect((err as Error).message).toMatch(/can't be reached/);
  });
});

describe('loading and saving through the backend', () => {
  beforeEach(() => {
    setFinance(createSampleData());
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  });

  it('replaces the data with GET /v1/dataset, and keeps it when the backend is down', async () => {
    const live = { ...createSampleData(), accounts: [] };
    reply(200, live);
    await act(async () => {
      expect(await refreshDataset()).toBe(true);
    });
    expect(getFinance().accounts).toEqual([]);
    expect(getBackendStatus()).toMatchObject({ mode: 'live', error: null });

    http.fetch = jest.fn(async () => {
      throw new TypeError('offline');
    });
    await act(async () => {
      expect(await refreshDataset()).toBe(false);
    });
    expect(getFinance().accounts).toEqual([]);
    expect(getBackendStatus().error).toMatch(/can't be reached.*Showing your data from/);
  });

  it('undoes a change the backend refused and says what was not saved', async () => {
    // Saving is allowed once the backend's own data is on screen.
    reply(200, createSampleData());
    await act(async () => {
      await refreshDataset();
    });
    const before = getFinance();
    updateFinance((d) => ({ ...d, budgets: [] }));
    reply(500, { error: 'internal', message: 'Something went wrong on the server.' });
    await act(async () => {
      await persist('budget', before, () => api('PUT', '/v1/budgets', {}));
    });
    expect(getFinance()).toBe(before);
    expect(getBackendStatus().error).toMatch(/^Not saved \(budget\)/);
  });

  it('does nothing extra in sample mode', async () => {
    setBackendConfigForTests({ token: '' });
    const f = reply(200, {});
    const before = getFinance();
    expect(await persist('x', before, () => api('GET', '/v1/x'))).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
