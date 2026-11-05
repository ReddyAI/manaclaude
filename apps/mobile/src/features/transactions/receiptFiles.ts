import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

/**
 * Getting a receipt photo onto the device (session A): camera, gallery, or a
 * file shared into the app from the Android share sheet. Photos are copied
 * into the app's documents folder so they outlive the picker's cache. Upload
 * to R2 is session B's job; until then the Receipt record points here.
 */

export type ReceiptSource = 'camera' | 'gallery';

/** The camera needs a real device; the web build only offers the gallery (file picker). */
export function receiptSourcesAvailable(): ReceiptSource[] {
  return Platform.OS === 'web' ? ['gallery'] : ['camera', 'gallery'];
}

/** Copy a picked or shared image into the app's receipts folder. Returns the new uri. */
export function saveReceiptImage(sourceUri: string): string {
  if (Platform.OS === 'web') return sourceUri;
  try {
    const dir = new Directory(Paths.document, 'receipts');
    if (!dir.exists) dir.create({ intermediates: true });
    const extension = /\.(png|webp|heic|jpe?g)(\?|$)/i.exec(sourceUri)?.[1]?.toLowerCase() ?? 'jpg';
    const target = new File(dir, `receipt-${Date.now().toString(36)}.${extension}`);
    new File(sourceUri).copy(target);
    return target.uri;
  } catch {
    // If copying fails the original uri still shows the photo for now.
    return sourceUri;
  }
}

export type PickResult =
  | { status: 'picked'; uri: string }
  | { status: 'cancelled' }
  | { status: 'denied'; message: string };

/** Open the camera or the gallery and return where the photo ended up. */
export async function pickReceiptImage(source: ReceiptSource): Promise<PickResult> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {
        status: 'denied',
        message: 'Camera access is off. Allow it in Settings to photograph receipts.',
      };
    }
  }
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 0.8,
    allowsEditing: false,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return { status: 'cancelled' };
  return { status: 'picked', uri: saveReceiptImage(asset.uri) };
}
