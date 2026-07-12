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

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
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

/** Converts a picked File into an AiAttachment; throws AiAttachmentError for unusable files. */
export async function prepareAiAttachment(file: File): Promise<AiAttachment> {
  if (file.size > MAX_AI_ATTACHMENT_BYTES) {
    throw new AiAttachmentError('tooLarge', file.name);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = fileExtension(file.name);
  const base = {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
  };

  if (IMAGE_TYPES.has(file.type)) {
    return { ...base, mediaType: file.type, kind: 'image', dataBase64: toBase64(bytes) };
  }
  if (file.type === 'application/pdf' || ext === 'pdf') {
    return { ...base, mediaType: 'application/pdf', kind: 'pdf', dataBase64: toBase64(bytes) };
  }
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
