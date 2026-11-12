import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FinanceDataset } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { act } from '@testing-library/react-native';
import { getFinance, setFinance, updateFinance } from '../../store';
import { api, BackendError, isSuperseded } from '../client';
import {
  forgetBackendToken,
  getBackendConfig,
  saveBackendConfig,
  setBackendConfigForTests,
} from '../config';
import { resetSettingsSyncForTests } from '../settingsSync';
import {
  canSaveToBackend,
  getBackendStatus,
  persist,
  refreshDataset,
  resetBackendForTests,
  startBackend,
} from '../sync';
import { fakeBackend, held, json, settle } from './helpers';
import { CACHE_FILE, files, secrets } from './mocks';

jest.mock('expo-secure-store', () => require('./mocks').secureStoreMock);
jest.mock('expo-file-system', () => require('./mocks').fileSystemMock);

const URL_A = 'https://a.demo.test';
const URL_B = 'https://b.demo.test';

/** Two invented backends, told apart by their single account. */
function dataset(accountName: string): FinanceDataset {
  const sample = createSampleData();
  const first = sample.accounts[0]!;
  return { ...sample, accounts: [{ ...first, id: `acc_${accountName}`, name: accountName }] };
}
const names = () => getFinance().accounts.map((a) => a.name);
const sampleNames = createSampleData().accounts.map((a) => a.name);

let backend: ReturnType<typeof fakeBackend>;

async function open(url: string, token: string): Promise<void> {
  await AsyncStorage.setItem('billionaire.backendUrl', url);
  secrets.set('billionaire.apiToken', token);
  await act(async () => {
    await startBackend();
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  secrets.clear();
  files.clear();
  resetBackendForTests();
  resetSettingsSyncForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
});

afterEach(() => backend?.restore());

describe('data on screen belongs to the selected backend', () => {
  it('ignores a dataset answer that arrives after the token was forgotten', async () => {
    backend = fakeBackend({ 'GET /v1/dataset': () => json(200, dataset('Alpha Checking')) });
    await open(URL_A, 'token-a');
    expect(names()).toEqual(['Alpha Checking']);
    expect(files.has(CACHE_FILE)).toBe(true);

    const slow = held();
    backend.restore();
    backend = fakeBackend({ 'GET /v1/dataset': () => slow.promise });
    let reload!: Promise<boolean>;
    await act(async () => {
      reload = refreshDataset();
      await forgetBackendToken();
    });
    expect(names()).toEqual(sampleNames);
    expect(backend.calls[0]!.aborted()).toBe(true);

    await act(async () => {
      slow.release(200, dataset('Alpha Checking'));
      expect(await reload).toBe(false);
      await settle();
    });
    expect(names()).toEqual(sampleNames);
    expect(getBackendStatus()).toMatchObject({ mode: 'sample', loading: false, error: null });
    expect(files.has(CACHE_FILE)).toBe(false);
    expect(secrets.has('billionaire.apiToken')).toBe(false);
  });

  it("does not let the old backend's late answer replace the new backend's data", async () => {
    backend = fakeBackend({ 'GET /v1/dataset': () => json(200, dataset('Alpha Checking')) });
    await open(URL_A, 'token-a');

    const slowA = held();
    backend.restore();
    backend = fakeBackend({
      'GET /v1/dataset': (call) =>
        call.url === URL_A ? slowA.promise : json(200, dataset('Beta Savings')),
    });
    await act(async () => {
      void refreshDataset();
      await saveBackendConfig({ url: URL_B, token: 'token-b' });
      await settle();
    });
    expect(names()).toEqual(['Beta Savings']);
    expect(backend.calls.map((c) => `${c.url} ${c.token}`)).toEqual([
      `${URL_A} Bearer token-a`,
      `${URL_B} Bearer token-b`,
    ]);

    await act(async () => {
      slowA.release(200, dataset('Alpha Checking'));
      await settle();
    });
    expect(names()).toEqual(['Beta Savings']);
    expect(getBackendStatus()).toMatchObject({ mode: 'live', error: null, fromCache: false });
    const saved = JSON.parse(files.get(CACHE_FILE)!) as { scope: string; data: FinanceDataset };
    expect(saved.scope).toBe(getBackendConfig().scope);
    expect(saved.data.accounts[0]!.name).toBe('Beta Savings');
  });

  it("shows sample data, not the old backend's, when the new backend can't be reached", async () => {
    backend = fakeBackend({
      'GET /v1/dataset': (call) => {
        if (call.url === URL_A) return json(200, dataset('Alpha Checking'));
        throw new TypeError('Network request failed');
      },
    });
    await open(URL_A, 'token-a');
    await act(async () => {
      await saveBackendConfig({ url: URL_B, token: 'token-b' });
      await settle();
    });
    expect(names()).toEqual(sampleNames);
    expect(getBackendStatus().mode).toBe('sample');
    expect(getBackendStatus().error).toMatch(/can't be reached/);
    expect(getBackendStatus().error).not.toMatch(/Showing your data from/);
    expect(files.has(CACHE_FILE)).toBe(false);
    expect(canSaveToBackend()).toBe(false);
  });

  it('opens the saved copy only for the backend it came from', async () => {
    backend = fakeBackend({ 'GET /v1/dataset': () => json(200, dataset('Alpha Checking')) });
    await open(URL_A, 'token-a');
    backend.restore();
    backend = fakeBackend({
      'GET /v1/dataset': () => {
        throw new TypeError('Network request failed');
      },
    });

    // The app is closed and opened again with no connection: the copy shows.
    resetBackendForTests();
    setFinance(createSampleData());
    await open(URL_A, 'token-a');
    expect(names()).toEqual(['Alpha Checking']);
    expect(getBackendStatus()).toMatchObject({ mode: 'live', fromCache: true });

    // The same file under another backend's scope is not shown.
    resetBackendForTests();
    setFinance(createSampleData());
    await AsyncStorage.setItem('billionaire.backendScope', 'another-backend');
    await open(URL_B, 'token-b');
    expect(names()).toEqual(sampleNames);
    expect(getBackendStatus().mode).toBe('sample');

    // A copy saved before scopes existed is not shown either.
    files.set(CACHE_FILE, JSON.stringify({ data: dataset('Old Copy'), savedAt: '2026-11-01' }));
    resetBackendForTests();
    await open(URL_B, 'token-b');
    expect(names()).toEqual(sampleNames);
  });

  it('keeps the scope when the same URL and token are saved again', async () => {
    await saveBackendConfig({ url: URL_A, token: 'token-a' });
    const first = getBackendConfig().scope;
    await saveBackendConfig({ url: `${URL_A}/`, token: ' token-a ' });
    expect(getBackendConfig().scope).toBe(first);
    await saveBackendConfig({ url: URL_A, token: 'token-a2' });
    expect(getBackendConfig().scope).not.toBe(first);
    expect(getBackendConfig().scope).not.toContain('token');
  });
});

describe('requests belong to the selected backend', () => {
  it('drops an answer that arrives after the backend changed', async () => {
    setBackendConfigForTests({ url: URL_A, token: 'token-a' });
    const slow = held();
    backend = fakeBackend({ 'GET /v1/accounts': () => slow.promise });
    const request = api('GET', '/v1/accounts').catch((e: unknown) => e);
    await settle();
    setBackendConfigForTests({ url: URL_B, token: 'token-b' });
    slow.release(200, [{ id: 'acc_alpha' }]);
    const err = await request;
    expect(isSuperseded(err)).toBe(true);
    expect((err as BackendError).offline).toBe(false);
    expect((err as Error).message).toMatch(/backend settings changed/);
  });

  it('leaves a check that names its own URL and token alone', async () => {
    setBackendConfigForTests({ url: URL_A, token: 'token-a' });
    const slow = held();
    backend = fakeBackend({ 'GET /v1/link/options': () => slow.promise });
    const check = api('GET', '/v1/link/options', undefined, { url: URL_B, token: 'token-b' });
    await settle();
    setBackendConfigForTests({ url: URL_A, token: 'token-a2' });
    slow.release(200, { ok: true });
    await expect(check).resolves.toEqual({ ok: true });
    expect(backend.calls[0]!.aborted()).toBe(false);
  });
});

describe('saving changes', () => {
  it('sends nothing while the sample data is still on screen', async () => {
    setBackendConfigForTests({ url: URL_A, token: 'token-a' });
    backend = fakeBackend({ 'PUT /v1/budgets': () => json(200, {}) });
    const before = getFinance();
    updateFinance((d) => ({ ...d, budgets: [] }));
    expect(await persist('budget', before, () => api('PUT', '/v1/budgets', {}))).toBeNull();
    expect(backend.calls).toHaveLength(0);
    expect(getFinance().budgets).toEqual([]);
  });

  it('neither undoes nor reports a save whose backend was forgotten meanwhile', async () => {
    backend = fakeBackend({ 'GET /v1/dataset': () => json(200, dataset('Alpha Checking')) });
    await open(URL_A, 'token-a');
    const slow = held();
    backend.restore();
    backend = fakeBackend({ 'PUT /v1/budgets': () => slow.promise });

    const before = getFinance();
    updateFinance((d) => ({ ...d, budgets: [] }));
    const onSaved = jest.fn();
    let saving!: Promise<unknown>;
    await act(async () => {
      saving = persist('budget', before, () => api('PUT', '/v1/budgets', {}), { onSaved });
      await forgetBackendToken();
      slow.release(500, { error: 'internal', message: 'Something went wrong on the server.' });
      expect(await saving).toBeNull();
      await settle();
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(names()).toEqual(sampleNames);
    expect(getBackendStatus().error).toBeNull();
  });
});
