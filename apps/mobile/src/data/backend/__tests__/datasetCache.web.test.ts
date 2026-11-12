import { createSampleData } from '@manaclaude/shared/sample';
import { readCachedDataset, writeCachedDataset } from '../datasetCache.web';

/** The browser's copy of the dataset, with a small in-memory localStorage. */
describe('saved copy in the browser', () => {
  const store = new Map<string, string>();
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterAll(() => {
    if (real) Object.defineProperty(globalThis, 'localStorage', real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  beforeEach(() => store.clear());

  it('is returned only to the backend that saved it', async () => {
    const data = createSampleData();
    await writeCachedDataset(data, '2026-11-05T12:00:00.000Z', 'scope-a');
    expect((await readCachedDataset('scope-a'))?.savedAt).toBe('2026-11-05T12:00:00.000Z');
    expect(await readCachedDataset('scope-b')).toBeNull();
    expect(await readCachedDataset('')).toBeNull();
  });

  it('ignores a copy saved before scopes existed, and deletes on request', async () => {
    store.set(
      'billionaire.dataset.v1',
      JSON.stringify({ data: createSampleData(), savedAt: '2026-11-01T00:00:00.000Z' }),
    );
    expect(await readCachedDataset('scope-a')).toBeNull();
    await writeCachedDataset(null, '', '');
    expect(store.size).toBe(0);
  });
});
