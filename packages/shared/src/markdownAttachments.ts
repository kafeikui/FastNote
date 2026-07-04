import { FNATTACH_SCHEME, parseAttachmentIdFromHref } from './attachmentRefs';

/** Convert fnattach markdown links to HTML spans the editor can parse reliably. */
export function markdownWithAttachmentHtml(markdown: string): string {
  const re = /\[([^\]]*)\]\(fnattach:([0-9a-f-]{36})\)/gi;
  return markdown.replace(re, (_m, label, id) => {
    const safeLabel = String(label).replace(/^📎\s*/, '').trim();
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<span data-attachment-id="${id}" data-label="${esc(safeLabel)}" data-node-type="attachmentRef"></span>`;
  });
}

/** Ensure attachment refs survive editor round-trips (merge HTML spans back if missing). */
export function ensureAttachmentRefsInMarkdown(markdown: string, htmlFallback?: string): string {
  if (!htmlFallback) return markdown;
  const refs = [...htmlFallback.matchAll(/data-attachment-id="([0-9a-f-]{36})"/g)].map((m) => m[1]!);
  let out = markdown;
  for (const id of refs) {
    if (out.includes(`${FNATTACH_SCHEME}${id}`)) continue;
    const labelMatch = htmlFallback.match(
      new RegExp(`data-attachment-id="${id}"[^>]*data-label="([^"]*)"`),
    );
    const label = labelMatch?.[1]?.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&') || 'attachment';
    out += `\n\n[📎 ${label}](${FNATTACH_SCHEME}${id})`;
  }
  return out;
}

export function attachmentRefFromAnchor(href: string): { id: string } | null {
  const id = parseAttachmentIdFromHref(href);
  return id ? { id } : null;
}
