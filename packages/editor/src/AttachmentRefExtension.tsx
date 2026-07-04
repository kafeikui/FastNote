import { Node, mergeAttributes, type MarkdownParseHelpers, type MarkdownToken } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { NoteAttachment } from '@fastnote/shared';
import {
  FNATTACH_SCHEME,
  attachmentDisplayLabel,
  buildAttachmentMarkdownRef,
  parseAttachmentIdFromHref,
} from '@fastnote/shared';
import { EmbeddedAttachmentChip } from '@fastnote/ui';

export type AttachmentRefExtensionOptions = {
  getAttachment?: (id: string) => NoteAttachment | undefined;
  onDownload?: (id: string) => void;
  onEdit?: (id: string, description: string) => void | Promise<void>;
};

const FNATTACH_MD_RE = /^\[([^\]]*)\]\(fnattach:([0-9a-f-]{36})\)/;

function linkTokenLabel(token: MarkdownToken): string {
  const nested = token.tokens;
  if (nested?.length) {
    return nested
      .map((t) => (t.type === 'text' ? t.text ?? '' : ''))
      .join('')
      .replace(/^📎\s*/, '')
      .trim();
  }
  const raw = (token as MarkdownToken & { text?: string; label?: string }).label
    ?? (token as MarkdownToken & { text?: string }).text
    ?? '';
  return String(raw).replace(/^📎\s*/, '').trim();
}

function AttachmentRefView({ node, deleteNode, extension, getPos, editor }: NodeViewProps) {
  const id = node.attrs.id as string;
  const att = extension.options.getAttachment?.(id);
  const label = att ? attachmentDisplayLabel(att) : (node.attrs.label as string) || id;
  const description = att?.description ?? '';
  const fileName = att?.fileName ?? '';

  return (
    <NodeViewWrapper as="span" className="fn-embed-attach-wrap" draggable data-drag-handle>
      <EmbeddedAttachmentChip
        attachmentId={id}
        label={label}
        description={description}
        fileName={fileName}
        draggable
        onDownload={(attachmentId) => extension.options.onDownload?.(attachmentId)}
        onEdit={async (attachmentId, desc) => {
          await extension.options.onEdit?.(attachmentId, desc);
          const pos = getPos();
          if (typeof pos === 'number') {
            editor.commands.command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                label: desc.trim() || fileName || label,
              });
              return true;
            });
          }
        }}
        onRemove={() => deleteNode()}
      />
    </NodeViewWrapper>
  );
}

export const AttachmentRef = Node.create<AttachmentRefExtensionOptions>({
  name: 'attachmentRef',
  priority: 1010,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return {
      getAttachment: undefined,
      onDownload: undefined,
      onEdit: undefined,
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes) =>
          attributes.id ? { 'data-attachment-id': attributes.id } : {},
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-label') ?? '',
        renderHTML: (attributes) =>
          attributes.label ? { 'data-label': attributes.label } : {},
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-attachment-id]' },
      {
        tag: 'a[href]',
        getAttrs: (element) => {
          const href =
            typeof element === 'string'
              ? ''
              : (element as HTMLElement).getAttribute('href') ?? '';
          const id = parseAttachmentIdFromHref(href);
          if (!id) return false;
          const el = element as HTMLElement;
          const label = (el.textContent ?? '').replace(/^📎\s*/, '').trim();
          return { id, label };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-node-type': 'attachmentRef',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentRefView);
  },

  markdownTokenizer: {
    name: 'attachmentRef',
    level: 'inline',
    start(src) {
      const marker = '](fnattach:';
      const end = src.indexOf(marker);
      if (end === -1) return -1;
      return src.lastIndexOf('[', end);
    },
    tokenize(src) {
      const match = FNATTACH_MD_RE.exec(src);
      if (!match) return undefined;
      const label = match[1]!.replace(/^📎\s*/, '').trim();
      const id = match[2]!;
      return {
        type: 'attachmentRef',
        raw: match[0],
        label,
        id,
        href: `${FNATTACH_SCHEME}${id}`,
      };
    },
  },

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) => {
    if (token.type === 'attachmentRef') {
      const id = (token as MarkdownToken & { id?: string }).id;
      const label = (token as MarkdownToken & { label?: string }).label ?? '';
      if (id) return helpers.createNode('attachmentRef', { id, label });
    }
    const href = token.href ?? '';
    if (href.startsWith(FNATTACH_SCHEME)) {
      const id = parseAttachmentIdFromHref(href);
      if (id) return helpers.createNode('attachmentRef', { id, label: linkTokenLabel(token) });
    }
    return [];
  },

  renderMarkdown: (node) => {
    const id = node.attrs?.id as string;
    const label = (node.attrs?.label as string) || 'attachment';
    return buildAttachmentMarkdownRef({ id, description: '', fileName: label });
  },
});
