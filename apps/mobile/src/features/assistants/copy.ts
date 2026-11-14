import * as Clipboard from 'expo-clipboard';

/**
 * Copies text for pasting into an assistant. A secret is marked sensitive,
 * so Android 13 and later don't show it in the clipboard preview or offer it
 * on the keyboard. Returns false when copying failed.
 */
export async function copyText(text: string, opts: { sensitive?: boolean } = {}): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(
      text,
      opts.sensitive ? { android: { isSensitive: true } } : undefined,
    );
  } catch {
    return false;
  }
}
