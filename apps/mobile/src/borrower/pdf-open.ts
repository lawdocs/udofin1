import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { base64ToBytes } from './documents';

export type OpenResult = 'opened' | 'no_viewer' | 'failed';

/**
 * Hands the exact file to the device's own PDF viewer through the share sheet. The file is written to the app's private
 * cache (no storage permission is needed or requested) and removed straight afterwards. It is never kept as a download.
 */
export async function openPdf(contentBase64: string, title: string): Promise<OpenResult> {
  let file: File | undefined;
  try {
    if (!(await Sharing.isAvailableAsync())) return 'no_viewer';
    const bytes = base64ToBytes(contentBase64);
    file = new File(
      Paths.cache,
      `udofin-${String(Date.now())}-${Math.random().toString(36).slice(2, 10)}.pdf`,
    );
    file.create({ overwrite: true });
    file.write(bytes);
    await Sharing.shareAsync(file.uri, {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: title,
    });
    return 'opened';
  } catch {
    return 'failed';
  } finally {
    try {
      file?.delete();
    } catch {
      // The cache is private and cleaned by the system; a leftover file is not a leak to other apps.
    }
  }
}
