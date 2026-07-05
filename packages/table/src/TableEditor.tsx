import { useMemo, useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import type { NoteAttachment, ShortcutBinding, TableDocument } from '@fastnote/shared';
import {
  attachmentDisplayLabel,
  buildAttachmentMarkdownRef,
  formatShortcutBinding,
  matchesShortcut,
  segmentsToMarkdown,
  splitTextWithAttachmentRefs,
} from '@fastnote/shared';
import { useLocale, useT } from '@fastnote/i18n';
import { TableCellContent, type AttachmentDragPos } from './TableCellContent';
import {
  columnLetter,
  computeRangeStats,
  evaluateCellFormula,
  formatFormulaNumber,
  isFormulaValue,
} from './formula';
import {
  addColumn,
  addRow,
  filterRows,
  removeColumn,
  removeRow,
  renameColumn,
  sortRows,
  updateCell,
} from './utils';

export interface TableEditorProps {
  document: TableDocument;
  onChange: (doc: TableDocument) => void;
  attachments?: NoteAttachment[];
  onRegisterInsert?: (insert: (text: string) => void) => void;
  onAttachmentDownload?: (id: string) => void;
  onAttachmentEdit?: (id: string, description: string) => void | Promise<void>;
  /** Keybinding that repeats the last structural action (add/remove row/column), Excel-F4 style. */
  repeatActionShortcut?: ShortcutBinding;
}

type SortDir = 'asc' | 'desc' | null;

interface CellPos {
  rowIdx: number;
  colIdx: number;
}

type LastAction =
  | { type: 'addRow' }
  | { type: 'addColumn' }
  | { type: 'removeRow'; rowIdx: number }
  | { type: 'removeColumn'; colIdx: number };

export function TableEditor({
  document: doc,
  onChange,
  attachments = [],
  onRegisterInsert,
  onAttachmentDownload,
  onAttachmentEdit,
  repeatActionShortcut,
}: TableEditorProps) {
  const t = useT();
  const locale = useLocale();
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [focusCell, setFocusCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [selAnchor, setSelAnchor] = useState<CellPos | null>(null);
  const [selFocus, setSelFocus] = useState<CellPos | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const lastActionRef = useRef<LastAction | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const displayRows = useMemo(() => {
    const filtered = filterRows(doc, doc.rows, filters);
    return sortRows(doc, filtered, sortCol, sortDir);
  }, [doc, filters, sortCol, sortDir]);

  const rowNumberById = useMemo(() => {
    const map = new Map<string, number>();
    doc.rows.forEach((r, i) => map.set(r.id, i + 1));
    return map;
  }, [doc.rows]);

  useEffect(() => {
    if (!isSelecting) return;
    const stop = () => setIsSelecting(false);
    window.addEventListener('mouseup', stop);
    return () => window.removeEventListener('mouseup', stop);
  }, [isSelecting]);

  const toggleSort = (colId: string) => {
    if (sortCol !== colId) {
      setSortCol(colId);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  };

  const selectionRange = useMemo(() => {
    if (!selAnchor || !selFocus) return null;
    return {
      rowStart: Math.min(selAnchor.rowIdx, selFocus.rowIdx),
      rowEnd: Math.max(selAnchor.rowIdx, selFocus.rowIdx),
      colStart: Math.min(selAnchor.colIdx, selFocus.colIdx),
      colEnd: Math.max(selAnchor.colIdx, selFocus.colIdx),
    };
  }, [selAnchor, selFocus]);

  const isCellSelected = useCallback(
    (rowIdx: number, colIdx: number) => {
      if (!selectionRange) return false;
      return (
        rowIdx >= selectionRange.rowStart &&
        rowIdx <= selectionRange.rowEnd &&
        colIdx >= selectionRange.colStart &&
        colIdx <= selectionRange.colEnd
      );
    },
    [selectionRange],
  );

  const handleCellMouseDown = (rowIdx: number, colIdx: number) => {
    setSelAnchor({ rowIdx, colIdx });
    setSelFocus({ rowIdx, colIdx });
    setIsSelecting(true);
  };

  const handleCellMouseEnter = (rowIdx: number, colIdx: number) => {
    if (!isSelecting) return;
    setSelFocus({ rowIdx, colIdx });
  };

  const selectColumn = (colIdx: number) => {
    if (displayRows.length === 0) return;
    setSelAnchor({ rowIdx: 0, colIdx });
    setSelFocus({ rowIdx: displayRows.length - 1, colIdx });
  };

  const selectRow = (rowIdx: number) => {
    if (doc.columns.length === 0) return;
    setSelAnchor({ rowIdx, colIdx: 0 });
    setSelFocus({ rowIdx, colIdx: doc.columns.length - 1 });
  };

  const focusCellInput = useCallback((rowIdx: number, colIdx: number) => {
    const el = tableWrapRef.current?.querySelector<HTMLInputElement>(
      `input[data-row-idx="${rowIdx}"][data-col-idx="${colIdx}"]`,
    );
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const handleCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>, rowIdx: number, colIdx: number) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Move to the same column on the next visible row, spreadsheet-style.
      if (rowIdx + 1 < displayRows.length) {
        focusCellInput(rowIdx + 1, colIdx);
      } else {
        (e.target as HTMLInputElement).blur();
      }
    },
    [displayRows.length, focusCellInput],
  );

  const selectionStats = useMemo(() => {
    if (!selectionRange) return null;
    const cells: Array<{ rowId: string; colId: string }> = [];
    for (let r = selectionRange.rowStart; r <= selectionRange.rowEnd; r++) {
      const row = displayRows[r];
      if (!row) continue;
      for (let c = selectionRange.colStart; c <= selectionRange.colEnd; c++) {
        const col = doc.columns[c];
        if (!col) continue;
        cells.push({ rowId: row.id, colId: col.id });
      }
    }
    if (cells.length === 0) return null;
    return computeRangeStats(doc, cells);
  }, [selectionRange, displayRows, doc]);

  const insertAttachmentText = useCallback(
    (ref: string) => {
      if (!focusCell) {
        alert(t('tableEditor.selectCellFirst'));
        return;
      }
      const row = doc.rows.find((r) => r.id === focusCell.rowId);
      const cur = row?.cells[focusCell.colId] ?? '';
      if (isFormulaValue(cur)) return;
      const next = cur.trim() ? `${cur.trim()} ${ref}` : ref;
      onChange(updateCell(doc, focusCell.rowId, focusCell.colId, next));
    },
    [doc, focusCell, onChange, t],
  );

  const insertAttachment = (att: NoteAttachment) => {
    insertAttachmentText(buildAttachmentMarkdownRef(att));
  };

  // Reorders an attachment chip within a cell, or moves it into a different
  // cell entirely — the drag payload always carries the *original* row/col
  // ids + segment index (see TableCellContent), so this works regardless of
  // which cell the drop lands on.
  const handleMoveAttachment = useCallback(
    (from: AttachmentDragPos, to: AttachmentDragPos) => {
      const sourceRow = doc.rows.find((r) => r.id === from.rowId);
      if (!sourceRow) return;
      const sourceRaw = sourceRow.cells[from.colId] ?? '';
      const sourceSegments = splitTextWithAttachmentRefs(sourceRaw);
      const moved = sourceSegments[from.index];
      if (!moved || moved.type !== 'attachment') return;

      if (from.rowId === to.rowId && from.colId === to.colId) {
        if (from.index === to.index) return;
        const next = sourceSegments.filter((_, i) => i !== from.index);
        const insertAt = to.index;
        next.splice(insertAt, 0, moved);
        onChange(updateCell(doc, from.rowId, from.colId, segmentsToMarkdown(next)));
        return;
      }

      const nextSource = sourceSegments.filter((_, i) => i !== from.index);
      let nextDoc = updateCell(doc, from.rowId, from.colId, segmentsToMarkdown(nextSource));

      const targetRow = nextDoc.rows.find((r) => r.id === to.rowId);
      const targetRaw = targetRow?.cells[to.colId] ?? '';
      const targetSegments = splitTextWithAttachmentRefs(targetRaw);
      const insertAt = Math.min(to.index, targetSegments.length);
      const nextTarget = [...targetSegments];
      nextTarget.splice(insertAt, 0, moved);
      nextDoc = updateCell(nextDoc, to.rowId, to.colId, segmentsToMarkdown(nextTarget));

      onChange(nextDoc);
    },
    [doc, onChange],
  );

  useEffect(() => {
    onRegisterInsert?.(insertAttachmentText);
  }, [onRegisterInsert, insertAttachmentText]);

  const handleAddColumn = useCallback(() => {
    lastActionRef.current = { type: 'addColumn' };
    onChangeRef.current(addColumn(docRef.current, locale));
  }, [locale]);

  const handleAddRow = useCallback(() => {
    lastActionRef.current = { type: 'addRow' };
    onChangeRef.current(addRow(docRef.current));
  }, []);

  const handleRemoveColumn = useCallback((colIdx: number, colId: string) => {
    lastActionRef.current = { type: 'removeColumn', colIdx };
    onChangeRef.current(removeColumn(docRef.current, colId));
  }, []);

  const handleRemoveRow = useCallback((rowIdx: number, rowId: string) => {
    lastActionRef.current = { type: 'removeRow', rowIdx };
    onChangeRef.current(removeRow(docRef.current, rowId));
  }, []);

  const repeatLastAction = useCallback(() => {
    const action = lastActionRef.current;
    if (!action) return;
    const current = docRef.current;
    if (action.type === 'addRow') {
      handleAddRow();
    } else if (action.type === 'addColumn') {
      handleAddColumn();
    } else if (action.type === 'removeRow') {
      const row = current.rows[action.rowIdx];
      if (row) handleRemoveRow(action.rowIdx, row.id);
    } else if (action.type === 'removeColumn') {
      const col = current.columns[action.colIdx];
      if (col) handleRemoveColumn(action.colIdx, col.id);
    }
  }, [handleAddRow, handleAddColumn, handleRemoveRow, handleRemoveColumn]);

  const handleContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (repeatActionShortcut && matchesShortcut(e, repeatActionShortcut)) {
      e.preventDefault();
      repeatLastAction();
    }
  };

  return (
    <div className="fn-table-editor" onKeyDown={handleContainerKeyDown}>
      <div className="fn-table-editor__tools">
        <button type="button" onClick={handleAddColumn}>
          {t('tableEditor.addColumn')}
        </button>
        <button type="button" onClick={handleAddRow}>
          {t('tableEditor.addRow')}
        </button>
        <span className="fn-table-editor__formula-hint">{t('tableEditor.formulaHint')}</span>
        {repeatActionShortcut && (
          <span className="fn-table-editor__formula-hint">
            {t('tableEditor.repeatActionHint', { key: formatShortcutBinding(repeatActionShortcut) })}
          </span>
        )}
        {attachments.length > 0 && (
          <select
            className="fn-table-editor__attach-select"
            defaultValue=""
            onChange={(e) => {
              const att = attachments.find((a) => a.id === e.target.value);
              if (att) insertAttachment(att);
              e.target.value = '';
            }}
          >
            <option value="" disabled>
              {focusCell ? t('tableEditor.insertAttachmentIntoCell') : t('tableEditor.insertAttachmentSelectCell')}
            </option>
            {attachments.map((a) => (
              <option key={a.id} value={a.id}>
                📎 {attachmentDisplayLabel(a)}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="fn-table-wrap" ref={tableWrapRef}>
        <table className="fn-table">
          <thead>
            <tr>
              <th className="fn-table__rownum-col" title={t('tableEditor.rowNumberTooltip')}>
                #
              </th>
              {doc.columns.map((col, colIdx) => (
                <th key={col.id}>
                  <div className="fn-table__col-head-row">
                    <button
                      type="button"
                      className="fn-table__col-letter"
                      title={t('tableEditor.columnLetterTooltip', { letter: columnLetter(colIdx) })}
                      onClick={() => selectColumn(colIdx)}
                    >
                      {columnLetter(colIdx)}
                    </button>
                    <button type="button" className="fn-table__sort" onClick={() => toggleSort(col.id)}>
                      {col.name}
                      {sortCol === col.id ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                    <button
                      type="button"
                      className="fn-table__col-del"
                      title={t('tableEditor.deleteColumn')}
                      onClick={() => handleRemoveColumn(colIdx, col.id)}
                    >
                      ×
                    </button>
                  </div>
                  <input
                    className="fn-table__filter"
                    placeholder={t('tableEditor.filterPlaceholder')}
                    value={filters[col.id] ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, [col.id]: e.target.value }))}
                  />
                </th>
              ))}
              <th className="fn-table__actions-col" />
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIdx) => (
              <tr key={row.id}>
                <td
                  className="fn-table__rownum-col"
                  onMouseDown={() => selectRow(rowIdx)}
                  title={t('tableEditor.selectRowTooltip')}
                >
                  {rowNumberById.get(row.id) ?? rowIdx + 1}
                </td>
                {doc.columns.map((col, colIdx) => {
                  const raw = row.cells[col.id] ?? '';
                  const formula = isFormulaValue(raw);
                  const result = formula ? evaluateCellFormula(doc, row.id, col.id) : null;
                  return (
                    <td key={col.id}>
                      <TableCellContent
                        value={raw}
                        displayValue={formula ? result!.display : raw}
                        isFormula={formula}
                        hasError={!!result?.error}
                        attachments={attachments}
                        onChange={(next) => onChange(updateCell(doc, row.id, col.id, next))}
                        onFocus={() => setFocusCell({ rowId: row.id, colId: col.id })}
                        onDownload={(id) => onAttachmentDownload?.(id)}
                        onEdit={(id, desc) => onAttachmentEdit?.(id, desc)}
                        selected={isCellSelected(rowIdx, colIdx)}
                        onCellMouseDown={() => handleCellMouseDown(rowIdx, colIdx)}
                        onCellMouseEnter={() => handleCellMouseEnter(rowIdx, colIdx)}
                        rowIdx={rowIdx}
                        colIdx={colIdx}
                        rowId={row.id}
                        colId={col.id}
                        onMoveAttachment={handleMoveAttachment}
                        onKeyDown={(e) => handleCellKeyDown(e, rowIdx, colIdx)}
                      />
                    </td>
                  );
                })}
                <td>
                  <button
                    type="button"
                    onClick={() => handleRemoveRow(doc.rows.findIndex((r) => r.id === row.id), row.id)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selectionStats && (
        <div className="fn-table-editor__stats">
          <span>{t('tableEditor.stats.count', { count: selectionStats.count })}</span>
          <span>{t('tableEditor.stats.sum', { sum: formatFormulaNumber(selectionStats.sum) })}</span>
          <span>
            {t('tableEditor.stats.average', {
              average: selectionStats.average === null ? '—' : formatFormulaNumber(selectionStats.average),
            })}
          </span>
        </div>
      )}
      <div className="fn-table-editor__hint">
        {t('tableEditor.footerHint', { shown: displayRows.length, total: doc.rows.length })}
        {doc.columns.map((col) => (
          <button
            key={col.id}
            type="button"
            className="fn-table__rename"
            onClick={() => {
              const name = prompt(t('tableEditor.renameColumnPrompt'), col.name);
              if (name?.trim()) onChange(renameColumn(doc, col.id, name.trim()));
            }}
          >
            {t('tableEditor.renameColumnBtn', { name: col.name })}
          </button>
        ))}
      </div>
    </div>
  );
}
