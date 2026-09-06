import { unzipSync, strFromU8 } from 'fflate';
import type { AiAttachment } from '@fastnote/shared';

/**
 * Converts user-picked files into AiAttachment records ready to be sent to the
 * Anthropic API:
 *
 * - images (png/jpeg/gif/webp) and PDFs are kept as base64 and sent as native
 *   image / document content blocks;
 * - .docx is unzipped locally (fflate) and its word/document.xml is reduced to
 *   plain text;
 * - legacy .doc is scanned with a best-effort binary text extractor (the format
 *   is proprietary; formatting and some fragments may be lost);
 * - anything that decodes as UTF-8 (txt/md/csv/json/...) is inlined as text.
 *
 * Everything happens in the renderer — no attachment bytes leave the machine
 * except inside the (user-initiated) API request itself.
 */

export const MAX_AI_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Anthropic's documented optimal long-edge limit — anything larger is downscaled server-side
// anyway, so keeping megapixel photos only wastes memory and tokens.
const AI_IMAGE_MAX_DIM = 1568;
// Images below this size are attached as-is even when re-encoding could shave a bit more.
const AI_IMAGE_REENCODE_BYTES = 512 * 1024;
const AI_IMAGE_QUALITY = 0.85;

export type AiAttachmentErrorCode = 'tooLarge' | 'unsupported' | 'emptyDoc';

export class AiAttachmentError extends Error {
  constructor(
    public code: AiAttachmentErrorCode,
    public fileName: string,
  ) {
    super(`${code}: ${fileName}`);
    this.name = 'AiAttachmentError';
  }
}

/**
 * Base64 via the native FileReader data-URL encoder. The old JS loop
 * (String.fromCharCode + btoa) built the whole binary string through thousands of
 * intermediate concatenations — several extra copies of the payload as GC churn, which
 * matters on the memory-starved Android WebView.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = fr.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/** Extracts plain text from a .docx file (OOXML zip; body text lives in word/document.xml). */
export function extractDocxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('word/document.xml missing');
  const xml = strFromU8(docXml);
  const paragraphs = xml.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const parts: string[] = [];
    const withTabsAndBreaks = para.replace(/<w:tab[^>]*\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n');
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(withTabsAndBreaks)) !== null) {
      parts.push(decodeXmlEntities(m[1]));
    }
    if (parts.length > 0) lines.push(parts.join(''));
  }
  return lines.join('\n').trim();
}

/**
 * Best-effort text recovery from a legacy binary .doc file. Word 97+ stores body text as
 * UTF-16LE runs inside the OLE container; scanning for printable UTF-16LE sequences (ASCII +
 * CJK) recovers most prose without needing a full OLE/DOC parser. Formatting is lost and some
 * noise/omissions are possible — good enough as chat context.
 */
export function extractDocLegacyText(bytes: Uint8Array): string {
  const out: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 16) {
      out.push(String.fromCharCode(...run).replace(/\r/g, '\n'));
    }
    run = [];
  };
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    const printableAscii = code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127);
    const cjk =
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3000 && code <= 0x30ff) || // CJK punctuation + kana
      (code >= 0xff00 && code <= 0xffef); // full-width forms
    if (printableAscii || cjk) {
      run.push(code);
    } else {
      flush();
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const TEXTUAL_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'ts', 'tsx', 'jsx', 'css', 'py', 'java', 'c', 'cpp', 'h', 'sh', 'sql', 'log', 'ini', 'toml',
]);

function fileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/**
 * Downscales/re-encodes an image so its base64 stays small. Attached photos used to go into the
 * message at full size (several MB each); the base64 blobs then lived inside the session JSON,
 * which is re-stringified + encrypted on every persist and pushed to the server as one blob —
 * a few camera photos froze and OOM-crashed the Android WebView. Returns null when the original
 * bytes should be used (GIFs keep their animation; small images aren't worth re-encoding; any
 * decode/encode failure falls back to the original).
 */
async function downscaleImageForAi(file: File): Promise<{ blob: Blob; mediaType: string } | null> {
  if (file.type === 'image/gif') return null;
  const url = URL.createObjectURL(file);
  try {
    // Intrinsic size comes from the header parse alone — the <img> is never painted, so the
    // full-resolution pixels are not decoded here. (naturalWidth/Height are already
    // EXIF-oriented in modern engines.)
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = url;
    });
    const scale = Math.min(1, AI_IMAGE_MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale === 1 && file.size <= AI_IMAGE_REENCODE_BYTES) return null;
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    try {
      let drawn = false;
      try {
        // Decode-time downsampling: with resize options the decoder subsamples while decoding,
        // so peak memory is bounded by the *target* size. The previous createImageBitmap(file)
        // call decoded the full-resolution RGBA bitmap first (a 48MP photo is ~190MB), which is
        // what OOM-crashed the Android WebView before the scaling even started.
        const bitmap = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        try {
          ctx.drawImage(bitmap, 0, 0, w, h);
          drawn = true;
        } finally {
          bitmap.close();
        }
      } catch {
        // Engines without resize-option support: let drawImage decode+scale internally.
        ctx.drawImage(img, 0, 0, w, h);
        drawn = true;
      }
      if (!drawn) return null;
      // WebP keeps alpha and compresses well; engines without a WebP encoder (Safari) fall back
      // to PNG per spec, so trust blob.type rather than the requested type.
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', AI_IMAGE_QUALITY));
      if (!blob || !IMAGE_TYPES.has(blob.type)) return null;
      // A PNG-fallback re-encode of an unscaled image can come out larger than the source.
      if (blob.size >= file.size) return null;
      return { blob, mediaType: blob.type };
    } finally {
      // Drop the canvas backing store immediately instead of waiting for GC.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Converts a picked File into an AiAttachment; throws AiAttachmentError for unusable files. */
export async function prepareAiAttachment(file: File): Promise<AiAttachment> {
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
  };

  // Images: downscale before the size check, so an oversized camera photo becomes sendable
  // instead of being rejected.
  if (IMAGE_TYPES.has(file.type)) {
    const scaled = await downscaleImageForAi(file);
    if (scaled) {
      if (scaled.blob.size > MAX_AI_ATTACHMENT_BYTES) throw new AiAttachmentError('tooLarge', file.name);
      return {
        ...base,
        size: scaled.blob.size,
        mediaType: scaled.mediaType,
        kind: 'image',
        dataBase64: await blobToBase64(scaled.blob),
      };
    }
    if (file.size > MAX_AI_ATTACHMENT_BYTES) throw new AiAttachmentError('tooLarge', file.name);
    return {
      ...base,
      mediaType: file.type,
      kind: 'image',
      dataBase64: await blobToBase64(file),
    };
  }

  if (file.size > MAX_AI_ATTACHMENT_BYTES) {
    throw new AiAttachmentError('tooLarge', file.name);
  }
  const ext = fileExtension(file.name);
  if (file.type === 'application/pdf' || ext === 'pdf') {
    return { ...base, mediaType: 'application/pdf', kind: 'pdf', dataBase64: await blobToBase64(file) };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === 'docx') {
    let text: string;
    try {
      text = extractDocxText(bytes);
    } catch {
      throw new AiAttachmentError('unsupported', file.name);
    }
    if (!text) throw new AiAttachmentError('emptyDoc', file.name);
    return { ...base, mediaType: 'text/plain', kind: 'text', text };
  }
  if (ext === 'doc') {
    const text = extractDocLegacyText(bytes);
    if (!text) throw new AiAttachmentError('emptyDoc', file.name);
    return { ...base, mediaType: 'text/plain', kind: 'text', text };
  }
  if (file.type.startsWith('text/') || TEXTUAL_EXTENSIONS.has(ext)) {
    const text = decodeUtf8Strict(bytes) ?? '';
    if (!text.trim()) throw new AiAttachmentError('emptyDoc', file.name);
    return { ...base, mediaType: file.type || 'text/plain', kind: 'text', text };
  }
  // Last resort: accept anything that is valid UTF-8 text.
  const text = decodeUtf8Strict(bytes);
  if (text && text.trim() && !text.includes('\u0000')) {
    return { ...base, mediaType: 'text/plain', kind: 'text', text };
  }
  throw new AiAttachmentError('unsupported', file.name);
}
