import type { JSONContent } from '@tiptap/core';
import { buildAttachmentMarkdownRef } from '@fastnote/shared';

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
    case 'paragraph':
      return `${indent}${serializeInline(node.content)}\n\n`;
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
  return doc.content
    .map((node) => serializeBlock(node))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}
