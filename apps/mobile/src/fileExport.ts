import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { toBase64 } from '@fastnote/crypto';

/**
 * Exports a binary file on a native platform (Android/iOS).
 *
 * The Android System WebView implements neither the Web Share API nor blob-anchor
 * downloads, so the web-style paths silently do nothing inside Capacitor. Instead we
 * write the bytes into the app cache directory and hand the file to the OS share
 * sheet (FileProvider-backed), from which the user can save it to Files/Downloads or
 * send it to any app.
 *
 * Returns false when not running natively (caller should fall back to web behavior).
 * A share sheet the user dismissed still counts as handled (true).
 */
export async function exportFileNative(fileName: string, data: Uint8Array, title?: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'attachment';
  const { uri } = await Filesystem.writeFile({
    // Unique per-export subpath so identical filenames never overwrite each other
    // while an older share sheet might still be reading the previous file.
    path: `fastnote-export/${Date.now()}/${safeName}`,
    directory: Directory.Cache,
    data: toBase64(data),
    recursive: true,
  });
  try {
    await Share.share({ title: title ?? safeName, url: uri });
  } catch (err) {
    // The plugin rejects when the user dismisses the sheet — that is not a failure.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/cancel/i.test(msg)) throw err;
  }
  return true;
}
