import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createSampleData } from '@manaclaude/shared/sample';
import { router } from 'expo-router';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { setFinance } from '../../../data/store';
import { VaultFileScreen } from '../VaultFileScreen';
import { VaultScreen } from '../VaultScreen';
import { getVaultState, loadVault, resetVaultForTests } from '../vaultStore';
import { LISTED, stored } from './fixtures';

/** What the stand-in for the phone's file system saw. */
const mockFs = {
  dirs: new Set<string>(),
  files: new Set<string>(),
  downloads: [] as { url: string; target: string; headers: Record<string, string> }[],
  previews: [] as { uri: string; mimeType?: string; title?: string }[],
  canPreview: true,
  failWith: null as Error | null,
  hold: null as Promise<void> | null,
};
const mockParams = { id: 'imp_4' };

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => {
  const join = (parts: (string | { uri: string })[]) =>
    parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts);
    }
    get exists() {
      return mockFs.dirs.has(this.uri);
    }
    create() {
      mockFs.dirs.add(this.uri);
    }
    delete() {
      mockFs.dirs.delete(this.uri);
      for (const f of [...mockFs.files]) if (f.startsWith(`${this.uri}/`)) mockFs.files.delete(f);
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(parts);
    }
    static async downloadFileAsync(
      url: string,
      target: File,
      options: { headers: Record<string, string> },
    ) {
      mockFs.downloads.push({ url, target: target.uri, headers: options.headers });
      if (mockFs.hold) await mockFs.hold;
      // As on Android: the body is written straight to the target, so a
      // download that fails part way leaves a partial file behind.
      mockFs.files.add(target.uri);
      if (mockFs.failWith) throw mockFs.failWith;
      return target;
    }
    static async canPreview() {
      return mockFs.canPreview;
    }
    static async preview(file: File, options: { mimeType?: string; title?: string }) {
      mockFs.previews.push({ uri: file.uri, ...options });
    }
  }
  return { Directory, File, Paths: { cache: { uri: 'file:///cache' } } };
});

const LIST = 'GET /v1/vault';
const FILE = (id: string) => `GET /v1/vault/${id}/file`;
const CSV = 'Date,Description,Amount\n2026-10-03,Corner Cafe,-4.50\n2026-10-04,Book Nook,-12.00\n';
const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const text = (id: string) => screen.getByTestId(id).props.children as string;
const file = (body: string, type = 'text/csv') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

let backend: ReturnType<typeof fakeBackend>;
function worker(handlers: Parameters<typeof fakeBackend>[0] = {}) {
  backend = fakeBackend({ [LIST]: () => json(200, { files: LISTED }), ...handlers });
  return backend;
}

async function openFile(id: string) {
  mockParams.id = id;
  await render(<VaultFileScreen />);
  await waitFor(() => expect(screen.getByTestId('vault-file-name')).toBeTruthy());
}

beforeEach(() => {
  jest.clearAllMocks();
  resetVaultForTests();
  mockFs.dirs.clear();
  mockFs.files.clear();
  mockFs.downloads.length = 0;
  mockFs.previews.length = 0;
  mockFs.canPreview = true;
  mockFs.failWith = null;
  mockFs.hold = null;
  mockParams.id = 'imp_4';
  setFinance(createSampleData());
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('stored statements list', () => {
  it('shows one row per file, with what it is and what became of it', async () => {
    worker();
    await render(<VaultScreen />);
    await waitFor(() => expect(screen.getByTestId('vault-count')).toBeTruthy());
    // Five stored copies are three files.
    expect(text('vault-count')).toBe('3 files');
    expect(screen.getByText('october.csv')).toBeTruthy();
    expect(screen.getByText('CSV · 12 KB · stored 2026-11-04')).toBeTruthy();
    expect(screen.getByText('PDF · 1.4 MB · stored 2026-11-02')).toBeTruthy();
    expect(screen.getByText('Imported')).toBeTruthy();
    expect(screen.getByText('Import undone')).toBeTruthy();
    expect(screen.getByText('Not imported')).toBeTruthy();
    expect(backend.sent(LIST)).toHaveLength(1);
    expect(backend.sent(LIST)[0]!.token).toBe('Bearer demo-token');
    expect(screen.queryByTestId('vault-limit')).toBeNull();
  });

  it('opens the page of a file', async () => {
    worker();
    await render(<VaultScreen />);
    await waitFor(() => expect(screen.getByTestId('vault-file-imp_4')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('october.csv'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/vault/[id]', params: { id: 'imp_4' } });
  });

  it('says when there is nothing, when the list fails, and when it is cut off', async () => {
    worker({ [LIST]: () => json(200, { files: [] }) });
    const empty = await render(<VaultScreen />);
    await waitFor(() => expect(screen.getByText('No stored files yet')).toBeTruthy());
    await empty.unmount();
    backend.restore();

    resetVaultForTests();
    worker({ [LIST]: () => json(500, { error: 'internal', message: 'Something went wrong.' }) });
    const failed = await render(<VaultScreen />);
    await waitFor(() => expect(text('vault-error')).toBe('Something went wrong.'));
    expect(screen.queryByText('No stored files yet')).toBeNull();
    await failed.unmount();
    backend.restore();

    resetVaultForTests();
    const many = Array.from({ length: 200 }, (_, i) => stored(`imp_${i}`, { sha256: `s${i}` }));
    worker({ [LIST]: () => json(200, { files: many }) });
    await render(<VaultScreen />);
    await waitFor(() => expect(screen.getByTestId('vault-limit')).toBeTruthy());
    expect(text('vault-limit')).toMatch(/newest 200 stored copies/);
  });

  it('asks for the backend when it is not set, and sends nothing', async () => {
    worker();
    setBackendConfigForTests({ token: '' });
    await render(<VaultScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
    expect(backend.calls).toHaveLength(0);
  });

  it("drops one backend's list at once and ignores its late answer", async () => {
    const late = held();
    worker({ [LIST]: () => late.promise });
    const load = loadVault();
    await act(async () => setBackendConfigForTests({ url: 'https://other.demo.test' }));
    late.release(200, { files: LISTED });
    await load;
    await settle();
    expect(getVaultState()).toEqual({ records: null, loading: false, error: null });
  });

  it('removes a copy an earlier open left on the phone', async () => {
    worker();
    mockFs.dirs.add('file:///cache/statements');
    mockFs.files.add('file:///cache/statements/october.csv');
    await render(<VaultScreen />);
    await waitFor(() => expect(screen.getByTestId('vault-count')).toBeTruthy());
    expect(mockFs.files.size).toBe(0);
  });
});

describe('one stored file', () => {
  it('says what the file is and what was done with it', async () => {
    worker();
    await openFile('imp_4');
    expect(text('vault-file-name')).toBe('october.csv');
    expect(screen.getByText('Imported')).toBeTruthy();
    expect(screen.getByText('12 KB')).toBeTruthy();
    // First stored on the day of its oldest copy.
    expect(screen.getByText('2026-11-04')).toBeTruthy();
    expect(screen.getByText('NRE Savings')).toBeTruthy();
    expect(screen.getByText('2026-11-03: 12 added, 2 already there, 0 left out.')).toBeTruthy();
    expect(screen.getByText('It was also previewed 2 more times without importing.')).toBeTruthy();
  });

  it('is found by the id of any copy, and says so when the id is not listed', async () => {
    worker();
    await openFile('imp_3');
    expect(text('vault-file-name')).toBe('october.csv');
    await screen.unmount();
    mockParams.id = 'imp_gone';
    await render(<VaultFileScreen />);
    await waitFor(() => expect(screen.getByText('File not found')).toBeTruthy());
  });

  it('shows the text of a CSV, read from the Worker with the token', async () => {
    worker({ [FILE('imp_4')]: () => file(CSV) });
    await openFile('imp_4');
    await press('vault-file-show');
    await waitFor(() => expect(screen.getByTestId('vault-file-text')).toBeTruthy());
    expect(text('vault-file-lines')).toBe('3 lines');
    expect(screen.getByText('2026-10-03,Corner Cafe,-4.50')).toBeTruthy();
    const sent = backend.sent(FILE('imp_4'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe('Bearer demo-token');
    // Nothing was written to the phone to show it.
    expect(mockFs.downloads).toHaveLength(0);
  });

  it('shows the first 300 lines of a long file and says how many there are', async () => {
    const long = Array.from({ length: 450 }, (_, i) => `2026-10-01,Row ${i + 1},-1.00`).join('\n');
    worker({ [FILE('imp_4')]: () => file(long) });
    await openFile('imp_4');
    await press('vault-file-show');
    await waitFor(() => expect(text('vault-file-lines')).toBe('First 300 of 450 lines'));
    expect(screen.getByText('2026-10-01,Row 300,-1.00')).toBeTruthy();
    expect(screen.queryByText('2026-10-01,Row 301,-1.00')).toBeNull();
  });

  it('says why when the file cannot be read', async () => {
    worker({
      [FILE('imp_4')]: () =>
        json(404, {
          error: 'not_found',
          message: 'The original file is missing from the vault.',
        }),
    });
    await openFile('imp_4');
    await press('vault-file-show');
    await waitFor(() =>
      expect(text('vault-file-error')).toBe('The original file is missing from the vault.'),
    );
    expect(screen.queryByTestId('vault-file-text')).toBeNull();
    backend.restore();

    worker({ [FILE('imp_4')]: () => Promise.reject(new TypeError('offline')) });
    await press('vault-file-show');
    await waitFor(() => expect(text('vault-file-error')).toMatch(/can't be reached/));
  });

  it('does not show a file that arrives after the backend changed', async () => {
    const late = held();
    worker({ [FILE('imp_4')]: () => late.promise });
    await openFile('imp_4');
    await press('vault-file-show');
    backend.restore();
    // The other backend has no such file.
    backend = fakeBackend({ [LIST]: () => json(200, { files: [] }) });
    await act(async () => {
      setBackendConfigForTests({ url: 'https://other.demo.test' });
      await settle();
    });
    await act(async () => {
      late.promise.catch(() => {});
      late.release(200, 'old backend,private,row');
      await settle();
    });
    expect(screen.queryByTestId('vault-file-text')).toBeNull();
    expect(screen.queryByText(/old backend/)).toBeNull();
    expect(screen.getByText('File not found')).toBeTruthy();
  });

  it('offers no text view for a PDF and hands it to another app', async () => {
    worker();
    await openFile('imp_2');
    expect(screen.queryByTestId('vault-file-show')).toBeNull();
    expect(screen.getByText('2026-11-02: 30 added, then removed by undo.')).toBeTruthy();
    expect(screen.getByText('2026-09-01 to 2026-09-30')).toBeTruthy();
    await press('vault-file-open');
    await waitFor(() => expect(mockFs.previews).toHaveLength(1));
    expect(mockFs.downloads).toEqual([
      {
        url: 'https://api.demo.test/v1/vault/imp_2/file',
        target: 'file:///cache/statements/nro-september.pdf',
        headers: { authorization: 'Bearer demo-token' },
      },
    ]);
    expect(mockFs.previews[0]).toEqual({
      uri: 'file:///cache/statements/nro-september.pdf',
      mimeType: 'application/pdf',
      title: 'nro-september.pdf',
    });
    expect(screen.queryByTestId('vault-file-error')).toBeNull();
  });

  it('keeps one opened copy at a time on the phone', async () => {
    worker();
    mockFs.dirs.add('file:///cache/statements');
    mockFs.files.add('file:///cache/statements/earlier.pdf');
    await openFile('imp_2');
    await press('vault-file-open');
    await waitFor(() => expect(mockFs.previews).toHaveLength(1));
    expect([...mockFs.files]).toEqual(['file:///cache/statements/nro-september.pdf']);
  });

  it('says so when no app on the phone opens the file, and keeps no copy', async () => {
    worker();
    mockFs.canPreview = false;
    await openFile('imp_2');
    await press('vault-file-open');
    await waitFor(() => expect(text('vault-file-note')).toMatch(/No app on this phone/));
    expect(mockFs.previews).toHaveLength(0);
    expect(mockFs.files.size).toBe(0);
  });

  it('reports a download the Worker refused or that never arrived', async () => {
    worker();
    await openFile('imp_2');
    mockFs.failWith = new Error('UnableToDownload: response has status 404');
    await press('vault-file-open');
    await waitFor(() =>
      expect(text('vault-file-error')).toBe('The original file is missing from the vault.'),
    );
    mockFs.failWith = new Error('UnableToDownload: response has status 401');
    await press('vault-file-open');
    await waitFor(() => expect(text('vault-file-error')).toMatch(/API token is wrong/));
    mockFs.failWith = new Error('Network request failed');
    await press('vault-file-open');
    await waitFor(() => expect(text('vault-file-error')).toMatch(/could not be downloaded/));
    expect(mockFs.previews).toHaveLength(0);
    expect(mockFs.files.size).toBe(0);
  });

  it('does not open a download that finished after the backend changed', async () => {
    worker();
    let finish!: () => void;
    mockFs.hold = new Promise<void>((resolve) => (finish = resolve));
    await openFile('imp_2');
    await press('vault-file-open');
    await waitFor(() => expect(mockFs.downloads).toHaveLength(1));
    backend.restore();
    backend = fakeBackend({ [LIST]: () => json(200, { files: [] }) });
    await act(async () => {
      setBackendConfigForTests({ url: 'https://other.demo.test' });
      await settle();
    });
    await act(async () => {
      finish();
      await settle();
    });
    expect(mockFs.previews).toHaveLength(0);
    expect(mockFs.files.size).toBe(0);
  });
});
