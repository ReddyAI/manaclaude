/**
 * Where the APP_API_TOKEN lives in the web build: the browser's own storage
 * for this site (localStorage), as asked. Anyone with this browser profile can
 * read it, so use the web app only on your own computer.
 */
const KEY = 'billionaire.apiToken';

export async function readToken(): Promise<string | null> {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export async function writeToken(token: string | null): Promise<void> {
  try {
    if (token) globalThis.localStorage?.setItem(KEY, token);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Private browsing can refuse storage; the token then lasts for this tab only.
  }
}
