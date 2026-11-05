import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

/**
 * Opens a provider's page (the Kite login, the SnapTrade portal) in an
 * in-app browser on the phone. When the Worker's callback sends the browser
 * to billionaire://link, the browser closes and the app gets the result.
 * (The web build uses browser.web.ts.)
 */
export function linkReturnUrl(): string {
  return Linking.createURL('link');
}

export async function openLinkPage(
  url: string,
): Promise<{ result: 'ok' | 'error' | 'closed'; message: string | null }> {
  const res = await WebBrowser.openAuthSessionAsync(url, linkReturnUrl());
  if (res.type !== 'success') return { result: 'closed', message: null };
  const back = new URL(res.url);
  const status = back.searchParams.get('status');
  return {
    result: status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'closed',
    message: back.searchParams.get('message'),
  };
}
