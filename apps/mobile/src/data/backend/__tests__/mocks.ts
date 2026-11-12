/**
 * In-memory stand-ins for the phone's secure store and file system, shared by
 * the backend tests. Use with:
 *   jest.mock('expo-secure-store', () => require('./mocks').secureStoreMock);
 *   jest.mock('expo-file-system', () => require('./mocks').fileSystemMock);
 */
export const secrets = new Map<string, string>();
export const files = new Map<string, string>();

export const secureStoreMock = {
  getItemAsync: async (key: string) => secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secrets.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secrets.delete(key);
  },
};

class MemoryFile {
  private path: string;
  constructor(dir: string, name: string) {
    this.path = `${dir}/${name}`;
  }
  get exists(): boolean {
    return files.has(this.path);
  }
  create(): void {
    files.set(this.path, '');
  }
  write(text: string): void {
    files.set(this.path, text);
  }
  delete(): void {
    files.delete(this.path);
  }
  async text(): Promise<string> {
    return files.get(this.path) ?? '';
  }
}

export const fileSystemMock = { File: MemoryFile, Paths: { document: '/doc' } };

export const CACHE_FILE = '/doc/billionaire-dataset.json';
