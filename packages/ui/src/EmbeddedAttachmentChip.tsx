import { useState, type DragEvent, type MouseEvent } from 'react';
import { attachmentDisplayLabel } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

export interface EmbeddedAttachmentChipProps {
  attachmentId: string;
  label: string;
  description: string;
  fileName: string;
  draggable?: boolean;
  onDownload: (id: string) => void;
  onEdit: (id: string, description: string) => void | Promise<void>;
  onRemove: (id: string) => void;
  /** Wired up by consumers that support drag-to-reorder (e.g. table cells). */
  onDragStart?: (e: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLSpanElement>) => void;
  onDragOver?: (e: DragEvent<HTMLSpanElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLSpanElement>) => void;
  onDrop?: (e: DragEvent<HTMLSpanElement>) => void;
  /** Highlights this chip as the current drop target while another chip is being dragged over it. */
  dragOver?: boolean;
}

export function EmbeddedAttachmentChip({
  attachmentId,
  label,
  description,
  fileName,
  draggable: draggableHandle,
  onDownload,
  onEdit,
  onRemove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  dragOver,
}: EmbeddedAttachmentChipProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const tooltip = description.trim() || fileName || label;

  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const startEdit = (e: MouseEvent) => {
    stop(e);
    setDraft(description);
    setEditing(true);
  };

  const commitEdit = async (e: MouseEvent) => {
    stop(e);
    await onEdit(attachmentId, draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <span className="fn-embed-attach fn-embed-attach--edit">
        <input
          className="fn-embed-attach__edit-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={fileName || t('embeddedAttachmentChip.descriptionPlaceholder')}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitEdit(e as unknown as MouseEvent);
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button type="button" title={t('embeddedAttachmentChip.save')} onClick={(e) => void commitEdit(e)}>
          ✓
        </button>
        <button type="button" title={t('embeddedAttachmentChip.cancel')} onClick={(e) => { stop(e); setEditing(false); }}>
          ✕
        </button>
      </span>
    );
  }

  return (
    <span
      className={`fn-embed-attach${draggableHandle ? ' fn-embed-attach--draggable' : ''}${dragOver ? ' fn-embed-attach--drag-over' : ''}`}
      data-tip={tooltip}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {draggableHandle ? (
        <span
          className="fn-embed-attach__drag"
          title={t('embeddedAttachmentChip.dragToMove')}
          data-drag-handle
          draggable
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          ⠿
        </span>
      ) : null}
      <span className="fn-embed-attach__icon">📎</span>
      <span className="fn-embed-attach__label">{label || attachmentDisplayLabel({ description, fileName })}</span>
      <span className="fn-embed-attach__actions">
        <button type="button" title={t('embeddedAttachmentChip.download')} onClick={(e) => { stop(e); onDownload(attachmentId); }}>
          ↓
        </button>
        <button type="button" title={t('embeddedAttachmentChip.editDescription')} onClick={startEdit}>
          ✎
        </button>
        <button type="button" title={t('embeddedAttachmentChip.remove')} onClick={(e) => { stop(e); onRemove(attachmentId); }}>
          ×
        </button>
      </span>
      {tooltip ? <span className="fn-embed-attach__tooltip">{tooltip}</span> : null}
    </span>
  );
}
