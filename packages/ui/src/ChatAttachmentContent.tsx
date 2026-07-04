import { useEffect, useState, type MouseEvent } from 'react';
import type { ChatAttachmentRef, ChatMessage } from '@fastnote/shared';
import { formatFileSize } from '@fastnote/shared';
import { useT, type TFunction } from '@fastnote/i18n';
import { EmbeddedAttachmentChip } from './EmbeddedAttachmentChip';

interface ChatAttachmentContentProps {
  messageId: string;
  messageDirection: ChatMessage['direction'];
  attachments: ChatAttachmentRef[];
  onDownload: (attachmentId: string) => void | Promise<void>;
  onEdit: (attachmentId: string, description: string) => void | Promise<void>;
  onRemove: (messageId: string, attachmentId: string) => void | Promise<void>;
  onLoadPreview?: (attachmentId: string) => Promise<Blob | null>;
}

function fileIcon(mime: string): string {
  if (mime.startsWith('image/')) return '🖼';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.includes('pdf')) return '📄';
  return '📎';
}

function confirmRemoveAttachment(
  direction: ChatMessage['direction'],
  fileName: string,
  t: TFunction,
): boolean {
  if (direction !== 'in') return true;
  return confirm(t('chatAttachment.deleteConfirm', { name: fileName }));
}

function ChatImagePreview({
  attachment,
  messageId,
  messageDirection,
  onLoadPreview,
  onDownload,
  onRemove,
  t,
}: {
  attachment: ChatAttachmentRef;
  messageId: string;
  messageDirection: ChatMessage['direction'];
  onLoadPreview?: (attachmentId: string) => Promise<Blob | null>;
  onDownload: (attachmentId: string) => void | Promise<void>;
  onRemove: (messageId: string, attachmentId: string) => void | Promise<void>;
  t: TFunction;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!onLoadPreview || !attachment.mimeType.startsWith('image/')) return;
    let active = true;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const blob = await onLoadPreview(attachment.id);
        if (!active || !blob) {
          if (active) setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.mimeType, onLoadPreview]);

  const handleRemove = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirmRemoveAttachment(messageDirection, attachment.fileName, t)) return;
    void onRemove(messageId, attachment.id);
  };

  if (url && !failed) {
    return (
      <div className="fn-chat__attachment-image-wrap">
        <button
          type="button"
          className="fn-chat__attachment-image-btn"
          title={attachment.fileName}
          onClick={() => void onDownload(attachment.id)}
        >
          <img
            className="fn-chat__attachment-image"
            src={url}
            alt={attachment.description || attachment.fileName}
          />
          <span className="fn-chat__attachment-image-name">{attachment.fileName}</span>
        </button>
        <button
          type="button"
          className="fn-chat__attachment-image-remove"
          title={t('chatAttachment.delete')}
          onClick={handleRemove}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div className="fn-chat__attachment-file">
      <span className="fn-chat__attachment-file-icon">{fileIcon(attachment.mimeType)}</span>
      <div className="fn-chat__attachment-file-meta">
        <span className="fn-chat__attachment-file-name">{attachment.fileName}</span>
        <span className="fn-chat__attachment-file-size">{formatFileSize(attachment.size)}</span>
      </div>
      <button type="button" title={t('chatAttachment.download')} onClick={() => void onDownload(attachment.id)}>
        ↓
      </button>
      <button type="button" title={t('chatAttachment.delete')} onClick={handleRemove}>
        ×
      </button>
    </div>
  );
}

export function ChatAttachmentContent({
  messageId,
  messageDirection,
  attachments,
  onDownload,
  onEdit,
  onRemove,
  onLoadPreview,
}: ChatAttachmentContentProps) {
  const t = useT();
  const handleRemove = (attachmentId: string, fileName: string) => {
    if (!confirmRemoveAttachment(messageDirection, fileName, t)) return;
    void onRemove(messageId, attachmentId);
  };

  return (
    <div className="fn-chat__attachments">
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') ? (
          <ChatImagePreview
            key={att.id}
            attachment={att}
            messageId={messageId}
            messageDirection={messageDirection}
            onLoadPreview={onLoadPreview}
            onDownload={onDownload}
            onRemove={onRemove}
            t={t}
          />
        ) : (
          <div key={att.id} className="fn-chat__attachment-file-wrap">
            <EmbeddedAttachmentChip
              attachmentId={att.id}
              label={att.description || att.fileName}
              description={att.description}
              fileName={att.fileName}
              draggable={false}
              onDownload={(id) => void onDownload(id)}
              onEdit={(id, desc) => void onEdit(id, desc)}
              onRemove={(id) => handleRemove(id, att.fileName)}
            />
          </div>
        ),
      )}
    </div>
  );
}
