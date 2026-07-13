import {
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type { NoteAttachment } from '@fastnote/shared';
import {
  attachmentDisplayLabel,
  segmentsToMarkdown,
  splitTextWithAttachmentRefs,
} from '@fastnote/shared';
import { EmbeddedAttachmentChip } from '@fastnote/ui';

export interface AttachmentDragPos {
  rowId: string;
  colId: string;
  index: number;
}

/** Custom MIME type used to carry the drag payload across cells (and, in theory, browser windows). */
export const ATTACHMENT_DRAG_MIME = 'application/x-fastnote-table-attachment';

interface TableCellContentProps {
  value: string;
  displayValue: string;
  /** When true, show `displayValue` (e.g. a number-formatted value) while the cell is not being edited. */
  formattedIdle?: boolean;
  isFormula: boolean;
  hasError?: boolean;
  attachments: NoteAttachment[];
  onChange: (value: string) => void;
  onFocus: () => void;
  onDownload: (id: string) => void;
  onEdit: (id: string, description: string) => void | Promise<void>;
  selected?: boolean;
  onCellMouseDown?: (e: MouseEvent) => void;
  onCellMouseEnter?: () => void;
  rowIdx?: number;
  colIdx?: number;
  rowId: string;
  colId: string;
  onMoveAttachment: (from: AttachmentDragPos, to: AttachmentDragPos) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Per-cell text formatting (bold / font size / color) applied to the text inputs. */
  textStyle?: CSSProperties;
  /** Reports how many characters are selected in the cell's text input (0 when none/blurred). */
  onTextSelect?: (count: number) => void;
}

function TableCellContent({
  value,
  displayValue,
  formattedIdle,
  isFormula,
  hasError,
  attachments,
  onChange,
  onFocus,
  onDownload,
  onEdit,
  selected,
  onCellMouseDown,
  onCellMouseEnter,
  rowIdx,
  colIdx,
  rowId,
  colId,
  onMoveAttachment,
  onKeyDown,
  textStyle,
  onTextSelect,
}: TableCellContentProps) {
  // `editing` tracks whether this cell's text input currently has focus, so a
  // formula cell can show the raw formula while typing and the computed
  // result otherwise. It's set on *every* focus/blur (not just while
  // isFormula is already true) so that typing a leading "=" mid-edit — which
  // flips isFormula from false to true on the very next render — doesn't
  // suddenly swap the displayed text out from under the user's cursor.
  const [editing, setEditing] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const segments = useMemo(() => splitTextWithAttachmentRefs(value), [value]);

  const wrapperClass = [
    'fn-table-cell',
    selected && 'fn-table-cell--selected',
    isFormula && 'fn-table-cell--formula',
    hasError && 'fn-table-cell--error',
  ]
    .filter(Boolean)
    .join(' ');

  const updateTextSegment = (index: number, text: string) => {
    const next = segments.map((seg, i) => (i === index && seg.type === 'text' ? { ...seg, text } : seg));
    onChange(segmentsToMarkdown(next));
  };

  const removeAttachmentAt = (index: number) => {
    onChange(segmentsToMarkdown(segments.filter((_, i) => i !== index)));
  };

  const lookup = (id: string) => attachments.find((a) => a.id === id);

  // Fallback drop target for the cell itself — lets an attachment be
  // dropped into a cell that has no existing attachment chips to land on
  // (e.g. plain text, or an empty cell), appending it at the end. Chip-level
  // handlers above call stopPropagation() so this doesn't double-handle
  // drops that already landed on a specific chip.
  const handleCellDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(ATTACHMENT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleCellDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(ATTACHMENT_DRAG_MIME);
    if (!raw) return;
    try {
      const from = JSON.parse(raw) as AttachmentDragPos;
      onMoveAttachment(from, { rowId, colId, index: segments.length });
    } catch {
      // Ignore malformed/foreign drag payloads.
    }
  };

  return (
    <div
      className={wrapperClass}
      onMouseDown={onCellMouseDown}
      onMouseEnter={onCellMouseEnter}
      onDragOver={handleCellDragOver}
      onDrop={handleCellDrop}
      data-row-idx={rowIdx}
      data-col-idx={colIdx}
    >
      {segments.map((seg, index) => {
        if (seg.type === 'attachment') {
          const att = lookup(seg.id);
          const label = att ? attachmentDisplayLabel(att) : seg.label;
          return (
            <EmbeddedAttachmentChip
              key={`${seg.id}-${index}`}
              attachmentId={seg.id}
              label={label}
              description={att?.description ?? ''}
              fileName={att?.fileName ?? seg.label}
              draggable
              dragOver={dragOverIndex === index}
              onDragStart={(e: DragEvent<HTMLSpanElement>) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(
                  ATTACHMENT_DRAG_MIME,
                  JSON.stringify({ rowId, colId, index } satisfies AttachmentDragPos),
                );
              }}
              onDragOver={(e: DragEvent<HTMLSpanElement>) => {
                if (!e.dataTransfer.types.includes(ATTACHMENT_DRAG_MIME)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                setDragOverIndex(index);
              }}
              onDragLeave={() => setDragOverIndex((cur) => (cur === index ? null : cur))}
              onDrop={(e: DragEvent<HTMLSpanElement>) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverIndex(null);
                const raw = e.dataTransfer.getData(ATTACHMENT_DRAG_MIME);
                if (!raw) return;
                try {
                  const from = JSON.parse(raw) as AttachmentDragPos;
                  onMoveAttachment(from, { rowId, colId, index });
                } catch {
                  // Ignore malformed/foreign drag payloads.
                }
              }}
              onDownload={onDownload}
              onEdit={onEdit}
              onRemove={() => removeAttachmentAt(index)}
            />
          );
        }
        const shown = (isFormula || formattedIdle) && !editing ? displayValue : seg.text;
        return (
          // A textarea (not an input) so Shift+Enter can insert in-cell line breaks; it grows
          // with the number of lines and otherwise behaves like the old single-line input.
          <textarea
            key={`text-${index}`}
            className={isFormula ? 'fn-table-cell__text fn-table-cell__formula-input' : 'fn-table-cell__text'}
            style={textStyle}
            rows={Math.max(1, shown.split('\n').length)}
            value={shown}
            onFocus={() => {
              setEditing(true);
              onFocus();
            }}
            onBlur={() => {
              setEditing(false);
              onTextSelect?.(0);
            }}
            onChange={(e) => updateTextSegment(index, e.target.value)}
            onSelect={(e) => {
              const el = e.target as HTMLTextAreaElement;
              onTextSelect?.(Math.abs((el.selectionEnd ?? 0) - (el.selectionStart ?? 0)));
            }}
            onKeyDown={onKeyDown}
            data-row-idx={rowIdx}
            data-col-idx={colIdx}
          />
        );
      })}
    </div>
  );
}

export { TableCellContent };
