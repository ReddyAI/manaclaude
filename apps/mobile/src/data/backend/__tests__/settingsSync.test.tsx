import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_SETTINGS, type FinanceDataset, type Settings } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { act } from '@testing-library/react-native';
import { getSettings, updateSettings } from '../../settingsStore';
import { setFinance } from '../../store';
import { forgetBackendToken, saveBackendConfig, setBackendConfigForTests } from '../config';
import {
  resetSettingsSyncForTests,
  sendWaitingSettingsForTests,
  settingsDiff,
  waitingSettingsForTests,
} from '../settingsSync';
import { getBackendStatus, refreshDataset, resetBackendForTests, startBackend } from '../sync';
import { fakeBackend, held, json, settle } from './helpers';
import { files, secrets } from './mocks';

jest.mock('expo-secure-store', () => require('./mocks').secureStoreMock);
jest.mock('expo-file-system', () => require('./mocks').fileSystemMock);

const URL_A = 'https://a.demo.test';

/** What an invented backend has stored: AI off, write tools on, refunds as income. */
const SERVER: Settings = {
  ...DEFAULT_SETTINGS,
  aiEnabled: false,
  mcpWriteToolsEnabled: true,
  weekStartsOn: 1,
  moneyPolicies: { ...DEFAULT_SETTINGS.moneyPolicies, refunds: 'count_as_income' },
};

let server: Settings;
let backend: ReturnType<typeof fakeBackend>;
const dataset = (): FinanceDataset => ({ ...createSampleData(), settings: server });

/** A backend that stores settings the way the Worker does: merge the patch, answer with the result. */
function settingsBackend(extra: Parameters<typeof fakeBackend>[0] = {}) {
  return fakeBackend({
    'GET /v1/dataset': () => json(200, dataset()),
    'PATCH /v1/settings': (call) => {
      const patch = call.body as Partial<Settings>;
      server = {
        ...server,
        ...patch,
        moneyPolicies: { ...server.moneyPolicies, ...patch.moneyPolicies },
      };
      return json(200, server);
    },
    ...extra,
  });
}

async function open(): Promise<void> {
  await AsyncStorage.setItem('billionaire.backendUrl', URL_A);
  secrets.set('billionaire.apiToken', 'token-a');
  await act(async () => {
    await startBackend();
    await settle();
  });
}

async function change(patch: Partial<Settings>): Promise<void> {
  await act(async () => {
    updateSettings(patch);
    await sendWaitingSettingsForTests();
    await settle();
  });
}

const patches = () => backend.sent('PATCH /v1/settings').map((c) => c.body);

beforeEach(async () => {
  await AsyncStorage.clear();
  secrets.clear();
  files.clear();
  resetBackendForTests();
  resetSettingsSyncForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
  await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
  server = SERVER;
});

afterEach(() => backend?.restore());

describe('settings the backend keeps', () => {
  it("shows the backend's settings on a new phone without sending the phone's defaults", async () => {
    backend = settingsBackend();
    await open();
    expect(getSettings()).toMatchObject({
      aiEnabled: false,
      mcpWriteToolsEnabled: true,
      weekStartsOn: 1,
    });
    expect(getSettings().moneyPolicies.refunds).toBe('count_as_income');
    expect(patches()).toEqual([]);
    expect(server).toEqual(SERVER);
  });

  it('sends only the one setting that was changed', async () => {
    backend = settingsBackend();
    await open();
    await change({ hapticsEnabled: false });
    expect(patches()).toEqual([{ hapticsEnabled: false }]);
    expect(server).toEqual({ ...SERVER, hapticsEnabled: false });
    expect(waitingSettingsForTests()).toBeNull();
  });

  it('sends only the one money policy that was changed', async () => {
    backend = settingsBackend();
    await open();
    await change({ moneyPolicies: { ...getSettings().moneyPolicies, transfers: 'count' } });
    expect(patches()).toEqual([{ moneyPolicies: { transfers: 'count' } }]);
    expect(server.moneyPolicies).toEqual({
      ...SERVER.moneyPolicies,
      transfers: 'count',
    });
  });

  it('never sends settings that live on the phone only', async () => {
    backend = settingsBackend();
    await open();
    await change({ flexBudgeting: true, defaultRollover: true });
    expect(patches()).toEqual([]);
    expect(getSettings().flexBudgeting).toBe(true);
  });

  it('sends nothing in sample mode, and nothing saved up when a backend is added later', async () => {
    backend = settingsBackend();
    await act(async () => {
      await startBackend();
    });
    await change({ aiEnabled: true, look: 'warm' });
    expect(backend.calls).toEqual([]);
    await act(async () => {
      await saveBackendConfig({ url: URL_A, token: 'token-a' });
      await settle();
      await sendWaitingSettingsForTests();
    });
    expect(patches()).toEqual([]);
    expect(getSettings()).toMatchObject({ aiEnabled: false, look: SERVER.look });
  });

  it("waits for the backend's settings before sending, then keeps the change", async () => {
    const slow = held();
    backend = settingsBackend({ 'GET /v1/dataset': () => slow.promise });
    await AsyncStorage.setItem('billionaire.backendUrl', URL_A);
    secrets.set('billionaire.apiToken', 'token-a');
    let starting!: Promise<void>;
    await act(async () => {
      starting = startBackend();
      await settle();
    });
    // Changed while the first load is still on its way.
    await change({ look: 'compact' });
    expect(patches()).toEqual([]);

    await act(async () => {
      slow.release(200, dataset());
      await starting;
      await settle();
      await sendWaitingSettingsForTests();
      await settle();
    });
    expect(patches()).toEqual([{ look: 'compact' }]);
    // The change made here won; everything else came from the backend.
    expect(getSettings()).toMatchObject({ look: 'compact', aiEnabled: false, weekStartsOn: 1 });
    expect(server).toEqual({ ...SERVER, look: 'compact' });
  });

  it('keeps a change the backend refused and sends it again at the next reload', async () => {
    let refuse = true;
    backend = settingsBackend({
      'PATCH /v1/settings': (call) => {
        if (refuse) return json(500, { error: 'internal', message: 'Try again.' });
        server = { ...server, ...(call.body as Partial<Settings>) };
        return json(200, server);
      },
    });
    await open();
    await change({ aiEnabled: true });
    expect(getBackendStatus().error).toMatch(/^Settings not saved on the backend yet/);
    expect(waitingSettingsForTests()).toEqual({ aiEnabled: true });
    expect(getSettings().aiEnabled).toBe(true);

    refuse = false;
    await act(async () => {
      await refreshDataset();
      await sendWaitingSettingsForTests();
      await settle();
    });
    // The reload carried the backend's old value; the waiting change still won.
    expect(getSettings().aiEnabled).toBe(true);
    expect(server.aiEnabled).toBe(true);
    expect(waitingSettingsForTests()).toBeNull();
    expect(patches()).toEqual([{ aiEnabled: true }, { aiEnabled: true }]);
  });

  it('brings a waiting change back after the app is closed and opened', async () => {
    backend = settingsBackend({
      'PATCH /v1/settings': () => json(500, { error: 'internal', message: 'Try again.' }),
    });
    await open();
    await change({ mcpWriteToolsEnabled: false });
    backend.restore();

    resetBackendForTests();
    resetSettingsSyncForTests();
    backend = settingsBackend();
    await open();
    await act(async () => {
      await sendWaitingSettingsForTests();
      await settle();
    });
    expect(patches()).toEqual([{ mcpWriteToolsEnabled: false }]);
    expect(server.mcpWriteToolsEnabled).toBe(false);
    expect(await AsyncStorage.getItem('billionaire.pendingSettings')).toBeNull();
  });

  it('drops a waiting change when the token is forgotten or the backend changes', async () => {
    backend = settingsBackend({
      'PATCH /v1/settings': () => json(500, { error: 'internal', message: 'Try again.' }),
    });
    await open();
    await change({ aiEnabled: true });
    expect(waitingSettingsForTests()).toEqual({ aiEnabled: true });
    backend.restore();

    backend = settingsBackend();
    await act(async () => {
      await forgetBackendToken();
      await saveBackendConfig({ url: 'https://b.demo.test', token: 'token-b' });
      await settle();
      await sendWaitingSettingsForTests();
    });
    expect(waitingSettingsForTests()).toBeNull();
    expect(patches()).toEqual([]);
    expect(getSettings().aiEnabled).toBe(false);
  });

  it('does not let a dataset answer from before a save undo that save', async () => {
    backend = settingsBackend();
    await open();
    const slow = held();
    const stale = dataset();
    backend.restore();
    backend = settingsBackend({ 'GET /v1/dataset': () => slow.promise });
    let reload!: Promise<boolean>;
    await act(async () => {
      reload = refreshDataset();
      await settle();
    });
    await change({ weekStartsOn: 0 });
    expect(server.weekStartsOn).toBe(0);
    await act(async () => {
      slow.release(200, stale);
      await reload;
      await settle();
    });
    expect(getSettings().weekStartsOn).toBe(0);
  });

  it('lists exactly the fields that differ', () => {
    const next: Settings = {
      ...DEFAULT_SETTINGS,
      look: 'warm',
      flexBudgeting: true,
      moneyPolicies: { ...DEFAULT_SETTINGS.moneyPolicies, categoryFloor: 'zero' },
    };
    expect(settingsDiff(DEFAULT_SETTINGS, next)).toEqual({
      look: 'warm',
      moneyPolicies: { categoryFloor: 'zero' },
    });
    expect(settingsDiff(next, next)).toEqual({});
  });
});
