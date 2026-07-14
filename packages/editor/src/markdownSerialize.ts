import type { JSONContent } from '@tiptap/core';
import { buildAttachmentMarkdownRef } from '@fastnote/shared';
import { FENCE_OR_CODE } from './blankLines';

function applyMarks(text: string, marks?: JSONContent['marks']): string {
  if (!marks?.length) return text;
  let out = text;
  for (const mark of [...marks].reverse()) {
    switch (mark.type) {
      case 'bold':
        out = `**${out}**`;
        break;
      case 'italic':
        out = `*${out}*`;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'link':
        out = `[${out}](${mark.attrs?.href ?? ''})`;
        break;
      default:
        break;
    }
  }
  return out;
}

function serializeInline(nodes?: JSONContent[]): string {
  if (!nodes?.length) return '';
  return nodes
    .map((node) => {
      if (node.type === 'text') {
        return applyMarks(node.text ?? '', node.marks);
      }
      if (node.type === 'attachmentRef') {
        const id = node.attrs?.id as string;
        const label = (node.attrs?.label as string) || 'attachment';
        return buildAttachmentMarkdownRef({ id, description: '', fileName: label });
      }
      if (node.type === 'hardBreak') {
        return '  \n';
      }
      if (node.type === 'inlineMath') {
        return `$${(node.attrs?.latex as string) ?? ''}$`;
      }
      if (node.content?.length) {
        return serializeInline(node.content);
      }
      return '';
    })
    .join('');
}

function serializeCodeBlock(node: JSONContent): string {
  const language = (node.attrs?.language as string | null) ?? '';
  const text = (node.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  return `\`\`\`${language}\n${text}\n\`\`\`\n\n`;
}

function serializeListItem(node: JSONContent, marker: string): string {
  let out = '';
  for (const child of node.content ?? []) {
    if (child.type === 'paragraph') {
      out += `${marker} ${serializeInline(child.content)}\n`;
    } else {
      out += serializeBlock(child, '  ');
    }
  }
  return `${out}\n`;
}

function serializeBlock(node: JSONContent, indent = ''): string {
  switch (node.type) {
    case 'paragraph': {
      const inline = serializeInline(node.content);
      // Empty and NBSP-only paragraphs stand for deliberate blank lines (see blankLines.ts).
      // They serialize to a bare newline guarded by a \u0000 sentinel so the final \n{3,}
      // collapse can't swallow it; the sentinel is stripped at the end.
      if (!inline.replace(/\u00A0/g, '').trim()) return `${indent}\u0000\n`;
      return `${indent}${inline}\n\n`;
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${indent}${'#'.repeat(level)} ${serializeInline(node.content)}\n\n`;
    }
    case 'codeBlock':
      return `${indent}${serializeCodeBlock(node)}`;
    case 'blockMath':
      return `${indent}$$\n${(node.attrs?.latex as string) ?? ''}\n$$\n\n`;
    case 'blockquote': {
      const inner = (node.content ?? []).map((c) => serializeBlock(c, '')).join('').trimEnd();
      const quoted = inner
        .split('\n')
        .map((line) => (line.trim() ? `${indent}> ${line}` : '>'))
        .join('\n');
      return `${quoted}\n\n`;
    }
    case 'bulletList':
      return (node.content ?? []).map((item) => serializeListItem(item, `${indent}-`)).join('');
    case 'orderedList':
      return (node.content ?? [])
        .map((item, index) => serializeListItem(item, `${indent}${index + 1}.`))
        .join('');
    case 'listItem':
      return serializeListItem(node, `${indent}-`);
    case 'horizontalRule':
      return `${indent}---\n\n`;
    default:
      if (node.content?.length) {
        return node.content.map((c) => serializeBlock(c, indent)).join('');
      }
      return '';
  }
}

/** Serialize editor document JSON to markdown with inline attachment positions preserved. */
export function serializeDocJsonToMarkdown(doc: JSONContent): string {
  if (!doc.content?.length) return '';
  let out = doc.content.map((node) => serializeBlock(node)).join('');
  // Collapse accidental newline runs from block suffixes — but only outside code, where blank
  // lines are literal content (the old unconditional collapse silently ate consecutive blank
  // lines inside fenced code blocks on every render-mode edit).
  out = out
    .split(FENCE_OR_CODE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/\n{3,}/g, '\n\n')))
    .join('');
  // Trailing NBSP/empty paragraphs (each serialized as a sentinel'd bare newline) are
  // deliberate trailing newlines; trimEnd() used to swallow them. Exactly one "\n" per
  // sentinel — the counterpart of preserveBlankLines' trailing rule (n newlines ⇒ n NBSP
  // paragraphs), which also covers empty paragraphs added by pressing Enter at the end of the
  // document in render mode.
  const trail = out.match(/(?:\u0000\n)+$/)?.[0] ?? '';
  const trailingBlanks = trail.length / 2;
  out = out
    .slice(0, out.length - trail.length)
    .replace(/\u0000/g, '')
    .trimEnd();
  return trailingBlanks > 0 ? out + '\n'.repeat(trailingBlanks) : out;
}
