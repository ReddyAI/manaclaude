import { Platform } from 'react-native';

/**
 * A multipart form with one file read from a local uri: a file:// path on the
 * phone (React Native sends it from disk), a blob: or data: URL on the web.
 */
export async function fileForm(
  uri: string,
  name: string,
  type: string,
  fields: Record<string, string | undefined> = {},
): Promise<FormData> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, v);
  if (Platform.OS === 'web') {
    const blob = await (await fetch(uri)).blob();
    form.append('file', blob, name);
  } else {
    form.append('file', { uri, name, type } as unknown as Blob);
  }
  return form;
}

export function imageTypeOf(uri: string): string {
  const ext = /\.(png|webp|heic|jpe?g)(\?|$)/i.exec(uri)?.[1]?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  const data = /^data:(image\/[a-z]+);/i.exec(uri)?.[1];
  return data ?? 'image/jpeg';
}
