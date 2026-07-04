export const FNATTACH_SCHEME = 'fnattach:';

export interface AttachmentRefMeta {
  id: string;
  description: string;
  fileName: string;
}

const MD_LINK_RE = /\[([^\]]*)\]\(fnattach:([0-9a-f-]{36})\)/gi;
const RAW_REF_RE = /fnattach:([0-9a-f-]{36})/gi;

export function attachmentDisplayLabel(meta: Pick<AttachmentRefMeta, 'description' | 'fileName'>): string {
  return meta.description.trim() || meta.fileName;
}

export function buildAttachmentMarkdownRef(meta: AttachmentRefMeta): string {
  const label = attachmentDisplayLabel(meta);
  return `[📎 ${label}](${FNATTACH_SCHEME}${meta.id})`;
}

export function parseAttachmentIdFromHref(href: string): string | null {
  if (!href.startsWith(FNATTACH_SCHEME)) return null;
  const id = href.slice(FNATTACH_SCHEME.length);
  return /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

/** Replace attachment refs with description or filename (for CSV / plain export). */
export function expandAttachmentRefsForExport(
  text: string,
  lookup: (id: string) => Pick<AttachmentRefMeta, 'description' | 'fileName'> | undefined,
): string {
  let out = text.replace(MD_LINK_RE, (_m, linkLabel, id) => {
    const att = lookup(id);
    if (att) return attachmentDisplayLabel(att);
    const label = String(linkLabel).replace(/^📎\s*/, '').trim();
    return label || id;
  });
  out = out.replace(RAW_REF_RE, (_m, id) => {
    const att = lookup(id);
    return att ? attachmentDisplayLabel(att) : id;
  });
  return out;
}

export function extractAttachmentIdsFromText(text: string): string[] {
  const ids = new Set<string>();
  for (const re of [MD_LINK_RE, RAW_REF_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ids.add(m[m.length - 1]!);
    }
  }
  return [...ids];
}

export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'attachment'; id: string; raw: string; label: string };

/** Split plain/markdown text into text runs and attachment ref tokens. */
export function splitTextWithAttachmentRefs(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  const re = /\[([^\]]*)\]\(fnattach:([0-9a-f-]{36})\)/gi;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, m.index) });
    }
    segments.push({
      type: 'attachment',
      id: m[2]!,
      raw: m[0],
      label: m[1]!.replace(/^📎\s*/, '').trim(),
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', text });
  }
  return segments;
}

export function segmentsToMarkdown(segments: ContentSegment[]): string {
  return segments.map((s) => (s.type === 'text' ? s.text : s.raw)).join('');
}
