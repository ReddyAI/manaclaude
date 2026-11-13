import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json } from '../../../data/backend/__tests__/helpers';
import { openStoredFile } from '../openStoredFile.web';
import { stored } from './fixtures';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

/** The browser's way of opening a stored file, with a stand-in for the page. */
describe('saving a stored file through the browser', () => {
  const link = { href: '', download: '', rel: '', click: jest.fn(), remove: jest.fn() };
  const page = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } };
  const realDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let blobs: Blob[] = [];
  let later: (() => void)[] = [];
  let backend: ReturnType<typeof fakeBackend>;

  beforeEach(() => {
    jest.clearAllMocks();
    blobs = [];
    later = [];
    Object.defineProperty(globalThis, 'document', { configurable: true, value: page });
    URL.createObjectURL = jest.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:demo-1';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void) => {
      later.push(run);
      return 0;
    }) as never);
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  });
  afterEach(() => {
    backend?.restore();
    jest.restoreAllMocks();
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    if (realDocument) Object.defineProperty(globalThis, 'document', realDocument);
    else delete (globalThis as { document?: unknown }).document;
  });

  it('fetches the file with the token and saves it under its own name', async () => {
    backend = fakeBackend({
      'GET /v1/vault/imp_4/file': () =>
        new Response('Date,Amount\n2026-10-03,-4.50\n', {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        }),
    });
    expect(await openStoredFile(stored('imp_4'))).toBe('downloaded');
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.token).toBe('Bearer demo-token');
    expect(await blobs[0]!.text()).toBe('Date,Amount\n2026-10-03,-4.50\n');
    expect(link).toMatchObject({ href: 'blob:demo-1', download: 'october.csv' });
    expect(link.click).toHaveBeenCalledTimes(1);
    // The copy in the page's memory is let go afterwards.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    later.forEach((run) => run());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:demo-1');
  });

  it('saves nothing when the Worker refuses', async () => {
    backend = fakeBackend({
      'GET /v1/vault/imp_4/file': () => json(401, { error: 'unauthorized', message: '' }),
    });
    await expect(openStoredFile(stored('imp_4'))).rejects.toMatchObject({
      status: 401,
      message: 'The API token is wrong. Check it in Settings, Backend.',
    });
    expect(link.click).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('saves nothing when the backend changed while the file was on its way', async () => {
    let answer!: (r: Response) => void;
    backend = fakeBackend({
      'GET /v1/vault/imp_4/file': () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    const opening = openStoredFile(stored('imp_4'));
    setBackendConfigForTests({ url: 'https://other.demo.test' });
    answer(new Response('private rows', { status: 200 }));
    await expect(opening).rejects.toMatchObject({ code: 'superseded' });
    expect(link.click).not.toHaveBeenCalled();
  });
});
