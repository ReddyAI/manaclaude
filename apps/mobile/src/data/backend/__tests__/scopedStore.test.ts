import { act } from '@testing-library/react-native';
import { setBackendConfigForTests } from '../config';
import { createScopedStore } from '../scopedStore';
import { fakeBackend, held, json, settle } from './helpers';
import { api } from '../client';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

/** An invented list read from the Worker. */
const store = createScopedStore(
  async () => (await api<{ items: string[] }>('GET', '/v1/items')).items,
);
let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  store.reset();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('createScopedStore', () => {
  it('loads once for callers at the same moment', async () => {
    backend = fakeBackend({ 'GET /v1/items': () => json(200, { items: ['a'] }) });
    await Promise.all([store.load(), store.load()]);
    expect(backend.sent('GET /v1/items')).toHaveLength(1);
    expect(store.get().value).toEqual(['a']);
  });

  it('loads nothing without a backend', async () => {
    backend = fakeBackend({});
    setBackendConfigForTests({ url: '', token: '' });
    await store.load();
    expect(backend.calls).toHaveLength(0);
    expect(store.get().value).toBeNull();
  });

  it('keeps a confirmed write when a list asked for earlier arrives later', async () => {
    const slow = held();
    let n = 0;
    backend = fakeBackend({
      'GET /v1/items': () => {
        n += 1;
        return n === 1 ? json(200, { items: ['a'] }) : slow.promise;
      },
    });
    await store.load();
    const late = store.load();
    await store.mutate(
      async () => 'b',
      (list, b) => [...(list ?? []), b],
    );
    slow.release(200, { items: ['a'] });
    await late;
    expect(store.get().value).toEqual(['a', 'b']);
    expect(store.get().loading).toBe(false);
  });

  it('drops the value when the backend changes and ignores a write answered for the old one', async () => {
    backend = fakeBackend({ 'GET /v1/items': () => json(200, { items: ['a'] }) });
    await store.load();
    let finish!: (v: string) => void;
    const write = store.mutate(
      () => new Promise<string>((r) => (finish = r)),
      (list, v) => [...(list ?? []), v],
    );
    await act(async () => {
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other' });
      await settle();
    });
    expect(store.get().value).toBeNull();
    finish('late');
    await expect(write).rejects.toMatchObject({ code: 'superseded' });
    expect(store.get().value).toBeNull();
  });

  it('keeps a load error as a plain sentence', async () => {
    backend = fakeBackend({
      'GET /v1/items': () =>
        json(500, { error: 'internal', message: 'Something went wrong on the server.' }),
    });
    await store.load();
    expect(store.get()).toMatchObject({
      value: null,
      error: 'Something went wrong on the server.',
    });
  });
});
