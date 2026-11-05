import * as SecureStore from 'expo-secure-store';

/**
 * Where the APP_API_TOKEN lives on the phone: the Android Keystore through
 * expo-secure-store, never AsyncStorage. (The web build uses tokenStorage.web.ts.)
 */
const KEY = 'billionaire.apiToken';

export async function readToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function writeToken(token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(KEY, token);
  else await SecureStore.deleteItemAsync(KEY);
}
