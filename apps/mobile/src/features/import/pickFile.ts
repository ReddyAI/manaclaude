import * as DocumentPicker from 'expo-document-picker';
import { mimeFor, type PickedFile } from './importApi';

/** Opens the system file picker for one statement file. null when cancelled. */
export async function pickStatementFile(): Promise<PickedFile | null> {
  const res = await DocumentPicker.getDocumentAsync({
    type: [
      'text/csv',
      'text/comma-separated-values',
      'application/pdf',
      'application/x-ofx',
      'application/vnd.intu.qfx',
      'application/qif',
      'text/plain',
      '*/*',
    ],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (res.canceled) return null;
  const asset = res.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, name: asset.name, mimeType: mimeFor(asset.name, asset.mimeType) };
}
