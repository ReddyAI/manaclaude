import AsyncStorage from '@react-native-async-storage/async-storage';
import { getBackendConfig } from '../../data/backend/config';

/**
 * Remembers the one import whose save has started but whose outcome this
 * phone has not seen yet. If the connection drops or the app closes in the
 * middle, the import screen finds it here and asks the backend what happened,
 * so nobody has to guess and import the file a second time. It is tied to
 * the backend it was sent to.
 */
const KEY = 'billionaire.pendingImport';

export interface PendingImport {
  importId: string;
  fileName: string;
  startedAt: string;
}

export async function rememberPendingImport(importId: string, fileName: string): Promise<void> {
  const value = {
    scope: getBackendConfig().scope,
    importId,
    fileName,
    startedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(KEY, JSON.stringify(value)).catch(() => {});
}

export async function clearPendingImport(importId?: string): Promise<void> {
  if (importId) {
    const current = await readPendingImport();
    if (current && current.importId !== importId) return;
  }
  await AsyncStorage.removeItem(KEY).catch(() => {});
}

export async function readPendingImport(): Promise<PendingImport | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<PendingImport> & { scope?: string };
    if (!saved.importId || saved.scope !== getBackendConfig().scope) return null;
    return {
      importId: saved.importId,
      fileName: saved.fileName ?? 'the file',
      startedAt: saved.startedAt ?? '',
    };
  } catch {
    return null;
  }
}
