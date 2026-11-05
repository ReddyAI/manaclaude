/**
 * Web build: the provider's page opens in a new tab. The Worker's callback
 * shows "go back to Billionaire" there, and the screen offers a Done button.
 */
export function linkReturnUrl(): string | undefined {
  return undefined;
}

export async function openLinkPage(
  url: string,
): Promise<{ result: 'ok' | 'error' | 'closed'; message: string | null }> {
  globalThis.open?.(url, '_blank', 'noopener');
  return { result: 'closed', message: null };
}
