import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type {
  NoteAttachment,
  ShortcutBinding,
  TableCellStyle,
  TableColumnFormat,
  TableDocument,
} from '@fastnote/shared';
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
  formatColumnNumber,
  formatFormulaNumber,
  isFormulaValue,
  parseNumericValue,
} from './formula';
import {
  MAX_COL_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COL_WIDTH,
  MIN_ROW_HEIGHT,
  addColumn,
  addRow,
  applyCellStyle,
  filterRows,
  promoteFirstRowToHeader,
  removeColumn,
  removeRow,
  renameColumn,
  setColumnFormat,
  setColumnWidth,
  setRowHeight,
  sortRows,
  updateCell,
} from './utils';
import { applyVerticalFill, parsePasteGrid } from './fill';

export interface TableEditorProps {
  document: TableDocument;
  onChange: (doc: TableDocument) => void;
  attachments?: NoteAttachment[];
  onRegisterInsert?: (insert: (text: string) => void) => void;
  onAttachmentDownload?: (id: string) => void;
  onAttachmentEdit?: (id: string, description: string) => void | Promise<void>;
  /** Keybinding that repeats the last structural action (add/remove row/column), Excel-F4 style. */
  repeatActionShortcut?: ShortcutBinding;
  undoShortcut?: ShortcutBinding;
  redoShortcut?: ShortcutBinding;
}

/** Curated palettes: single-click swatches avoid flooding the undo history the way a live color picker would. */
const TEXT_COLORS = ['#1f2937', '#d92d20', '#e04f16', '#b54708', '#027a48', '#175cd3', '#6938ef', '#dd2590'];
const FILL_COLORS = ['#fee4e2', '#ffead5', '#fef0c7', '#d1fadf', '#d1e9ff', '#ebe9fe', '#fce7f6', '#f2f4f7'];
const FONT_SIZES = [12, 13, 14, 16, 18, 20, 24, 28];

/**
 * Width used for columns the user hasn't resized. Every column having an explicit width lets the
 * table lay out at max-content and overflow into a horizontal scrollbar instead of squeezing
 * columns to fit (the wrap stretches narrow tables back to full width via min-width: 100%).
 */
const DEFAULT_COL_WIDTH = 180;

/** Formats a Date as a local "YYYY-MM-DD HH:mm:ss" string for the insert-time toolbar button. */
function formatLocalTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  undoShortcut,
  redoShortcut,
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
  /** Row the fill-handle drag currently points at (Excel-style autofill), null when not filling. */
  const [fillTargetRow, setFillTargetRow] = useState<number | null>(null);
  const [isFilling, setIsFilling] = useState(false);
  /** Live values while dragging a resize handle; committed to the document (and history) on mouseup. */
  const [liveColWidth, setLiveColWidth] = useState<{ colId: string; width: number } | null>(null);
  const [liveRowHeight, setLiveRowHeight] = useState<{ rowId: string; height: number } | null>(null);
  const [openPalette, setOpenPalette] = useState<'color' | 'fill' | null>(null);
  /** Inline column rename (window.prompt is unavailable in the Electron renderer). */
  const [renamingCol, setRenamingCol] = useState<{ colId: string; draft: string } | null>(null);
  /** Characters selected inside the cell input currently being edited (0 = none). */
  const [cellSelChars, setCellSelChars] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastActionRef = useRef<LastAction | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Whole-table undo/redo history. Every emitted change snapshots the previous document; the
  // component is keyed by note id at the call site, so the stacks reset when switching tables.
  const undoStackRef = useRef<TableDocument[]>([]);
  const redoStackRef = useRef<TableDocument[]>([]);
  const [, setHistVersion] = useState(0);

  const emitChange = useCallback((next: TableDocument) => {
    undoStackRef.current.push(docRef.current);
    if (undoStackRef.current.length > 200) undoStackRef.current.shift();
    redoStackRef.current = [];
    setHistVersion((v) => v + 1);
    onChangeRef.current(next);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    redoStackRef.current.push(docRef.current);
    setHistVersion((v) => v + 1);
    onChangeRef.current(prev);
  }, []);

  const redo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(docRef.current);
    setHistVersion((v) => v + 1);
    onChangeRef.current(next);
  }, []);

  const displayRows = useMemo(() => {
    const filtered = filterRows(doc, doc.rows, filters);
    return sortRows(doc, filtered, sortCol, sortDir);
  }, [doc, filters, sortCol, sortDir]);

  // Autofill and grid-paste act on row indices, which only line up with the underlying document
  // when no sort/filter is active.
  const isPlainView = !sortCol && !Object.values(filters).some((v) => v.trim());

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
    if (isFilling) {
      setFillTargetRow(rowIdx);
      return;
    }
    if (!isSelecting) return;
    setSelFocus({ rowIdx, colIdx });
  };

  const selectionRangeRef = useRef<typeof selectionRange>(null);
  selectionRangeRef.current = selectionRange;
  const fillTargetRowRef = useRef<number | null>(null);
  fillTargetRowRef.current = fillTargetRow;

  const handleFillHandleMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsFilling(true);
    setFillTargetRow(null);
  };

  useEffect(() => {
    if (!isFilling) return;
    const finish = () => {
      const range = selectionRangeRef.current;
      const target = fillTargetRowRef.current;
      if (range && target !== null) {
        emitChange(applyVerticalFill(docRef.current, range, target));
      }
      setIsFilling(false);
      setFillTargetRow(null);
    };
    window.addEventListener('mouseup', finish);
    return () => window.removeEventListener('mouseup', finish);
  }, [isFilling, emitChange]);

  const isFillPreviewCell = (rowIdx: number, colIdx: number): boolean => {
    if (!isFilling || fillTargetRow === null || !selectionRange) return false;
    if (colIdx < selectionRange.colStart || colIdx > selectionRange.colEnd) return false;
    if (fillTargetRow > selectionRange.rowEnd) {
      return rowIdx > selectionRange.rowEnd && rowIdx <= fillTargetRow;
    }
    return rowIdx < selectionRange.rowStart && rowIdx >= fillTargetRow;
  };

  // ---- Cell formatting (bold / font size / colors) ----------------------------------------

  /** Cells the format toolbar acts on: the selection range if any, otherwise the focused cell. */
  const formatTargets = useMemo((): Array<{ rowId: string; colId: string }> => {
    if (selectionRange) {
      const cells: Array<{ rowId: string; colId: string }> = [];
      for (let r = selectionRange.rowStart; r <= selectionRange.rowEnd; r++) {
        const row = displayRows[r];
        if (!row) continue;
        for (let c = selectionRange.colStart; c <= selectionRange.colEnd; c++) {
          const col = doc.columns[c];
          if (col) cells.push({ rowId: row.id, colId: col.id });
        }
      }
      return cells;
    }
    if (focusCell) return [{ rowId: focusCell.rowId, colId: focusCell.colId }];
    return [];
  }, [selectionRange, displayRows, doc.columns, focusCell]);

  /** Style of the first target cell — drives the toolbar's active/current indicators. */
  const anchorStyle: TableCellStyle = useMemo(() => {
    const first = formatTargets[0];
    if (!first) return {};
    return doc.rows.find((r) => r.id === first.rowId)?.styles?.[first.colId] ?? {};
  }, [formatTargets, doc.rows]);

  const applyStyle = (patch: Partial<TableCellStyle>) => {
    if (formatTargets.length === 0) {
      alert(t('tableEditor.formatNeedTarget'));
      return;
    }
    emitChange(applyCellStyle(docRef.current, formatTargets, patch));
  };

  // ---- Column number format -----------------------------------------------------------------

  /** Columns the number-format controls act on (derived from the same targets as cell styles). */
  const formatColIds = useMemo(() => {
    const ids: string[] = [];
    for (const cell of formatTargets) {
      if (!ids.includes(cell.colId)) ids.push(cell.colId);
    }
    return ids;
  }, [formatTargets]);

  /** Format of the first target column — drives the toolbar's current-value indicators. */
  const anchorColFormat: TableColumnFormat | undefined = useMemo(() => {
    const first = formatColIds[0];
    return first ? doc.columns.find((c) => c.id === first)?.format : undefined;
  }, [formatColIds, doc.columns]);

  const applyColumnFormat = (
    mutate: (cur: TableColumnFormat | undefined) => TableColumnFormat | undefined,
  ) => {
    if (formatColIds.length === 0) {
      alert(t('tableEditor.formatNeedTarget'));
      return;
    }
    let next = docRef.current;
    for (const colId of formatColIds) {
      const cur = next.columns.find((c) => c.id === colId)?.format;
      next = setColumnFormat(next, colId, mutate(cur));
    }
    emitChange(next);
  };

  const insertLocalTime = () => {
    if (!focusCell) {
      alert(t('tableEditor.selectCellFirst'));
      return;
    }
    const row = docRef.current.rows.find((r) => r.id === focusCell.rowId);
    const cur = row?.cells[focusCell.colId] ?? '';
    if (isFormulaValue(cur)) return;
    const now = formatLocalTime(new Date());
    const next = cur.trim() ? `${cur.trim()} ${now}` : now;
    emitChange(updateCell(docRef.current, focusCell.rowId, focusCell.colId, next));
  };

  const textStyleFor = (style: TableCellStyle | undefined): CSSProperties | undefined => {
    if (!style) return undefined;
    const out: CSSProperties = {};
    if (style.bold) out.fontWeight = 700;
    if (style.fontSize) out.fontSize = `${style.fontSize}px`;
    if (style.color) out.color = style.color;
    return Object.keys(out).length > 0 ? out : undefined;
  };

  // ---- Column width / row height dragging --------------------------------------------------

  const commitRename = () => {
    const cur = renamingCol;
    setRenamingCol(null);
    if (!cur) return;
    const name = cur.draft.trim();
    const col = docRef.current.columns.find((c) => c.id === cur.colId);
    if (name && col && name !== col.name) {
      emitChange(renameColumn(docRef.current, cur.colId, name));
    }
  };

  const clampWidth = (w: number) => Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, w));
  const clampHeight = (h: number) => Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, h));

  const handleColResizeStart = (e: MouseEvent, colId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th');
    const startWidth = th ? th.getBoundingClientRect().width : 120;
    const startX = e.clientX;
    setLiveColWidth({ colId, width: clampWidth(startWidth) });
    const onMove = (ev: globalThis.MouseEvent) => {
      setLiveColWidth({ colId, width: clampWidth(startWidth + ev.clientX - startX) });
    };
    const onUp = (ev: globalThis.MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      emitChange(setColumnWidth(docRef.current, colId, startWidth + ev.clientX - startX));
      setLiveColWidth(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleRowResizeStart = (e: MouseEvent, rowId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const tr = (e.currentTarget as HTMLElement).closest('tr');
    const startHeight = tr ? tr.getBoundingClientRect().height : 32;
    const startY = e.clientY;
    setLiveRowHeight({ rowId, height: clampHeight(startHeight) });
    const onMove = (ev: globalThis.MouseEvent) => {
      setLiveRowHeight({ rowId, height: clampHeight(startHeight + ev.clientY - startY) });
    };
    const onUp = (ev: globalThis.MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      emitChange(setRowHeight(docRef.current, rowId, startHeight + ev.clientY - startY));
      setLiveRowHeight(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const colWidthFor = (colId: string, docWidth?: number): number | undefined =>
    liveColWidth?.colId === colId ? liveColWidth.width : docWidth;

  const rowHeightFor = (rowId: string, docHeight?: number): number | undefined =>
    liveRowHeight?.rowId === rowId ? liveRowHeight.height : docHeight;

  // Multi-cell paste: parses tab/comma/whitespace-separated clipboard text into a grid anchored
  // at the focused cell, growing the table as needed. Single values keep the browser default.
  const handleGridPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!isPlainView) return;
    const target = e.target as HTMLElement;
    const rowAttr = target.dataset?.rowIdx;
    const colAttr = target.dataset?.colIdx;
    if (rowAttr === undefined || colAttr === undefined) return;
    const grid = parsePasteGrid(e.clipboardData.getData('text/plain'));
    if (!grid) return;
    e.preventDefault();
    const startRow = Number(rowAttr);
    const startCol = Number(colAttr);
    const width = Math.max(...grid.map((r) => r.length));
    let next = docRef.current;
    while (startCol + width > next.columns.length) next = addColumn(next, locale);
    while (startRow + grid.length > next.rows.length) next = addRow(next);
    const rows = next.rows.map((r) => ({ ...r, cells: { ...r.cells } }));
    grid.forEach((rowVals, r) => {
      const row = rows[startRow + r];
      if (!row) return;
      rowVals.forEach((val, c) => {
        const col = next.columns[startCol + c];
        if (col) row.cells[col.id] = val;
      });
    });
    emitChange({ ...next, rows });
  };

  // Multi-cell copy: a selection spanning more than one cell is copied as tab-separated values
  // (rows newline-separated) — pasteable into Excel/Sheets and back into this table
  // (handleGridPaste splits on tabs first). Formula cells copy their computed value.
  // Copying part of one cell's text still works naturally: clicking into a cell collapses the
  // range to that single cell, so buildRangeTsv() returns null and native copy takes over.
  /** TSV of the current multi-cell selection, or null when the selection is a single cell/empty. */
  const buildRangeTsv = (): string | null => {
    const range = selectionRange;
    if (!range) return null;
    if (range.rowStart === range.rowEnd && range.colStart === range.colEnd) return null;
    const lines: string[] = [];
    for (let r = range.rowStart; r <= range.rowEnd; r++) {
      const row = displayRows[r];
      if (!row) continue;
      const cells: string[] = [];
      for (let c = range.colStart; c <= range.colEnd; c++) {
        const col = doc.columns[c];
        if (!col) {
          cells.push('');
          continue;
        }
        const raw = row.cells[col.id] ?? '';
        cells.push(isFormulaValue(raw) ? evaluateCellFormula(doc, row.id, col.id).display : raw);
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  };

  /** Copy-event path (Ctrl+C inside a cell input, or Copy from a context menu). */
  const handleGridCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    const tsv = buildRangeTsv();
    if (tsv === null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', tsv);
  };

  /**
   * Keydown fallback for when no cell input is focused (e.g. a whole row/column was selected via
   * its header) — pressing Mod+C then fires no copy event at all, so we copy through a hidden
   * textarea + execCommand('copy') (the app's permissionless clipboard-write path).
   */
  const copyRangeViaExecCommand = (): boolean => {
    const tsv = buildRangeTsv();
    if (tsv === null) return false;
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement('textarea');
    ta.value = tsv;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    prevFocus?.focus();
    return true;
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
      emitChange(updateCell(doc, focusCell.rowId, focusCell.colId, next));
    },
    [doc, focusCell, emitChange, t],
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
        emitChange(updateCell(doc, from.rowId, from.colId, segmentsToMarkdown(next)));
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

      emitChange(nextDoc);
    },
    [doc, emitChange],
  );

  useEffect(() => {
    onRegisterInsert?.(insertAttachmentText);
  }, [onRegisterInsert, insertAttachmentText]);

  const handleAddColumn = useCallback(() => {
    lastActionRef.current = { type: 'addColumn' };
    emitChange(addColumn(docRef.current, locale));
  }, [locale, emitChange]);

  const handleAddRow = useCallback(() => {
    lastActionRef.current = { type: 'addRow' };
    emitChange(addRow(docRef.current));
  }, [emitChange]);

  // The × buttons unmount themselves on click, dropping keyboard focus to <body>; refocusing the
  // container keeps the F4 repeat-action (and undo) shortcuts working for consecutive deletes.
  const handleRemoveColumn = useCallback(
    (colIdx: number, colId: string) => {
      lastActionRef.current = { type: 'removeColumn', colIdx };
      emitChange(removeColumn(docRef.current, colId));
      containerRef.current?.focus();
    },
    [emitChange],
  );

  const handleRemoveRow = useCallback(
    (rowIdx: number, rowId: string) => {
      lastActionRef.current = { type: 'removeRow', rowIdx };
      emitChange(removeRow(docRef.current, rowId));
      containerRef.current?.focus();
    },
    [emitChange],
  );

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
      return;
    }
    // preventDefault also suppresses the focused input's native text undo, so the whole-table
    // history is the single source of truth. Bindings are user-configurable in settings.
    if (undoShortcut && matchesShortcut(e, undoShortcut)) {
      e.preventDefault();
      undo();
      return;
    }
    if (redoShortcut && matchesShortcut(e, redoShortcut)) {
      e.preventDefault();
      redo();
      return;
    }
    // Mod+C with focus outside any text field (row/column selected via header) never produces a
    // copy event, so handle it here. When a cell input is focused, handleGridCopy takes over.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === 'c' &&
      !(document.activeElement instanceof HTMLInputElement) &&
      !(document.activeElement instanceof HTMLTextAreaElement)
    ) {
      if (copyRangeViaExecCommand()) e.preventDefault();
    }
  };

  return (
    <div className="fn-table-editor" ref={containerRef} tabIndex={-1} onKeyDown={handleContainerKeyDown}>
      <div className="fn-table-editor__tools">
        <button type="button" onClick={handleAddColumn}>
          {t('tableEditor.addColumn')}
        </button>
        <button type="button" onClick={handleAddRow}>
          {t('tableEditor.addRow')}
        </button>
        <button
          type="button"
          onClick={undo}
          disabled={undoStackRef.current.length === 0}
          title={`${t('tableEditor.undo')}${undoShortcut ? ` (${formatShortcutBinding(undoShortcut)})` : ''}`}
        >
          ↺
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={redoStackRef.current.length === 0}
          title={`${t('tableEditor.redo')}${redoShortcut ? ` (${formatShortcutBinding(redoShortcut)})` : ''}`}
        >
          ↻
        </button>
        <button
          type="button"
          className={`fn-table-fmt__bold${anchorStyle.bold ? ' active' : ''}`}
          title={t('tableEditor.bold')}
          onClick={() => applyStyle({ bold: anchorStyle.bold ? undefined : true })}
        >
          B
        </button>
        <select
          className="fn-table-fmt__size"
          title={t('tableEditor.fontSize')}
          value={anchorStyle.fontSize ?? ''}
          onChange={(e) => applyStyle({ fontSize: e.target.value ? Number(e.target.value) : undefined })}
        >
          <option value="">{t('tableEditor.fontSizeDefault')}</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}px
            </option>
          ))}
        </select>
        <div className="fn-table-palette-wrap">
          <button
            type="button"
            title={t('tableEditor.textColor')}
            onClick={() => setOpenPalette((p) => (p === 'color' ? null : 'color'))}
          >
            <span style={anchorStyle.color ? { color: anchorStyle.color } : undefined}>A</span>
          </button>
          {openPalette === 'color' && (
            <div className="fn-table-palette">
              <button
                type="button"
                className="fn-table-palette__default"
                onClick={() => {
                  applyStyle({ color: undefined });
                  setOpenPalette(null);
                }}
              >
                {t('tableEditor.defaultColor')}
              </button>
              <div className="fn-table-palette__swatches">
                {TEXT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="fn-table-palette__swatch"
                    style={{ background: c }}
                    onClick={() => {
                      applyStyle({ color: c });
                      setOpenPalette(null);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="fn-table-palette-wrap">
          <button
            type="button"
            title={t('tableEditor.fillColor')}
            onClick={() => setOpenPalette((p) => (p === 'fill' ? null : 'fill'))}
          >
            <span
              className="fn-table-fmt__fill-swatch"
              style={anchorStyle.fill ? { background: anchorStyle.fill } : undefined}
            />
          </button>
          {openPalette === 'fill' && (
            <div className="fn-table-palette">
              <button
                type="button"
                className="fn-table-palette__default"
                onClick={() => {
                  applyStyle({ fill: undefined });
                  setOpenPalette(null);
                }}
              >
                {t('tableEditor.defaultColor')}
              </button>
              <div className="fn-table-palette__swatches">
                {FILL_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="fn-table-palette__swatch"
                    style={{ background: c }}
                    onClick={() => {
                      applyStyle({ fill: c });
                      setOpenPalette(null);
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className={doc.freezeFirstColumn ? 'active' : ''}
          title={t('tableEditor.freezeFirstCol')}
          onClick={() => emitChange({ ...docRef.current, freezeFirstColumn: !docRef.current.freezeFirstColumn })}
        >
          📌
        </button>
        <button
          type="button"
          disabled={!isPlainView}
          title={t('tableEditor.useFirstRowAsHeaderHint')}
          onClick={() => emitChange(promoteFirstRowToHeader(docRef.current))}
        >
          {t('tableEditor.useFirstRowAsHeader')}
        </button>
        <button type="button" title={t('tableEditor.insertNow')} onClick={insertLocalTime}>
          🕒
        </button>
        <select
          className="fn-table-fmt__numfmt"
          title={t('tableEditor.numberFormat')}
          value={anchorColFormat?.kind ?? ''}
          onChange={(e) => {
            const kind = e.target.value as '' | 'number' | 'currency';
            applyColumnFormat((cur) =>
              kind === '' ? undefined : { kind, decimals: cur?.decimals ?? 2, symbol: cur?.symbol ?? '$' },
            );
          }}
        >
          <option value="">{t('tableEditor.numberFormatNone')}</option>
          <option value="number">{t('tableEditor.numberFormatNumber')}</option>
          <option value="currency">{t('tableEditor.numberFormatCurrency')}</option>
        </select>
        {anchorColFormat && (
          <select
            className="fn-table-fmt__decimals"
            title={t('tableEditor.decimals')}
            value={anchorColFormat.decimals}
            onChange={(e) =>
              applyColumnFormat((cur) => (cur ? { ...cur, decimals: Number(e.target.value) } : cur))
            }
          >
            {[0, 1, 2, 3, 4, 5, 6].map((d) => (
              <option key={d} value={d}>
                {t('tableEditor.decimalsOption', { n: String(d) })}
              </option>
            ))}
          </select>
        )}
        {anchorColFormat?.kind === 'currency' && (
          <input
            className="fn-table-fmt__symbol"
            title={t('tableEditor.currencySymbol')}
            value={anchorColFormat.symbol ?? '$'}
            maxLength={4}
            onChange={(e) => applyColumnFormat((cur) => (cur ? { ...cur, symbol: e.target.value } : cur))}
          />
        )}
        <div className="fn-table-palette-wrap">
          <button
            type="button"
            className={showHelp ? 'active' : ''}
            title={t('tableEditor.help')}
            onClick={() => setShowHelp((v) => !v)}
          >
            ?
          </button>
          {showHelp && (
            <div className="fn-table-palette fn-table-help-pop">
              <p>{t('tableEditor.formulaHint')}</p>
              {repeatActionShortcut && (
                <p>{t('tableEditor.repeatActionHint', { key: formatShortcutBinding(repeatActionShortcut) })}</p>
              )}
              <p>{t('tableEditor.fillHandleTooltip')}</p>
              <p>{t('tableEditor.helpCopy')}</p>
              <p>{t('tableEditor.helpPaste')}</p>
            </div>
          )}
        </div>
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
      {/* Always rendered (placeholder when idle) so its appearance never shifts the table wrap —
          otherwise the always-visible horizontal scrollbar would jump when a selection is made. */}
      <div className="fn-table-editor__stats">
        {cellSelChars > 0 && <span>{t('vaultApp.selectedChars', { count: String(cellSelChars) })}</span>}
        {selectionStats && (
          <>
            <span>{t('tableEditor.stats.count', { count: selectionStats.count })}</span>
            <span>{t('tableEditor.stats.sum', { sum: formatFormulaNumber(selectionStats.sum) })}</span>
            <span>
              {t('tableEditor.stats.average', {
                average: selectionStats.average === null ? '—' : formatFormulaNumber(selectionStats.average),
              })}
            </span>
          </>
        )}
        {!selectionStats && cellSelChars === 0 && (
          <span className="fn-table-editor__stats-placeholder">{t('tableEditor.stats.placeholder')}</span>
        )}
      </div>
      <div className="fn-table-wrap" ref={tableWrapRef} onPaste={handleGridPaste} onCopy={handleGridCopy}>
        <table className="fn-table">
          <thead>
            <tr>
              <th className="fn-table__rowdel-col" />
              <th className="fn-table__rownum-col" title={t('tableEditor.rowNumberTooltip')}>
                #
              </th>
              {doc.columns.map((col, colIdx) => {
                const width = colWidthFor(col.id, col.width) ?? DEFAULT_COL_WIDTH;
                return (
                  <th
                    key={col.id}
                    className={doc.freezeFirstColumn && colIdx === 0 ? 'fn-table__col--frozen' : undefined}
                    style={{ width, minWidth: width, maxWidth: width }}
                  >
                    <div className="fn-table__col-head-row">
                      <button
                        type="button"
                        className="fn-table__col-letter"
                        title={t('tableEditor.columnLetterTooltip', { letter: columnLetter(colIdx) })}
                        onClick={() => selectColumn(colIdx)}
                      >
                        {columnLetter(colIdx)}
                      </button>
                      {renamingCol?.colId === col.id ? (
                        <input
                          className="fn-table__rename-input"
                          value={renamingCol.draft}
                          autoFocus
                          placeholder={t('tableEditor.renameColumnPrompt')}
                          onChange={(e) => setRenamingCol({ colId: col.id, draft: e.target.value })}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            else if (e.key === 'Escape') setRenamingCol(null);
                          }}
                        />
                      ) : (
                        <button type="button" className="fn-table__sort" onClick={() => toggleSort(col.id)}>
                          {col.name}
                          {sortCol === col.id ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </button>
                      )}
                      <button
                        type="button"
                        className="fn-table__col-rename"
                        title={t('tableEditor.renameColumn')}
                        onClick={() => setRenamingCol({ colId: col.id, draft: col.name })}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className="fn-table__col-del"
                        title={t('tableEditor.deleteColumn')}
                        onClick={() => {
                          // F4 repeat (repeatLastAction) intentionally skips this confirmation.
                          if (!confirm(t('tableEditor.confirmDeleteColumn', { name: col.name }))) return;
                          handleRemoveColumn(colIdx, col.id);
                        }}
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
                    <span
                      className="fn-table__col-resize"
                      title={t('tableEditor.colResizeTitle')}
                      onMouseDown={(e) => handleColResizeStart(e, col.id)}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIdx) => (
              <tr key={row.id} style={rowHeightFor(row.id, row.height) ? { height: rowHeightFor(row.id, row.height) } : undefined}>
                <td className="fn-table__rowdel-col">
                  <button
                    type="button"
                    className="fn-table__row-del"
                    title={t('tableEditor.deleteRow')}
                    onClick={() => {
                      // F4 repeat (repeatLastAction) intentionally skips this confirmation.
                      const num = rowNumberById.get(row.id) ?? rowIdx + 1;
                      if (!confirm(t('tableEditor.confirmDeleteRow', { num: String(num) }))) return;
                      handleRemoveRow(doc.rows.findIndex((r) => r.id === row.id), row.id);
                    }}
                  >
                    ×
                  </button>
                </td>
                <td
                  className="fn-table__rownum-col"
                  onMouseDown={() => selectRow(rowIdx)}
                  title={t('tableEditor.selectRowTooltip')}
                >
                  {rowNumberById.get(row.id) ?? rowIdx + 1}
                  <span
                    className="fn-table__row-resize"
                    title={t('tableEditor.rowResizeTitle')}
                    onMouseDown={(e) => handleRowResizeStart(e, row.id)}
                  />
                </td>
                {doc.columns.map((col, colIdx) => {
                  const raw = row.cells[col.id] ?? '';
                  const formula = isFormulaValue(raw);
                  const result = formula ? evaluateCellFormula(doc, row.id, col.id) : null;
                  // Column number format: applies to numeric raw values and formula results alike.
                  const numericForFormat =
                    col.format && !result?.error ? (formula ? result!.value : parseNumericValue(raw)) : null;
                  const displayValue =
                    col.format && numericForFormat !== null
                      ? formatColumnNumber(numericForFormat, col.format)
                      : formula
                        ? result!.display
                        : raw;
                  const cellStyle = row.styles?.[col.id];
                  const isFillOrigin =
                    isPlainView &&
                    !!selectionRange &&
                    rowIdx === selectionRange.rowEnd &&
                    colIdx === selectionRange.colEnd;
                  const tdClass = [
                    'fn-table__cell',
                    isFillPreviewCell(rowIdx, colIdx) && 'fn-table__cell--fill-preview',
                    doc.freezeFirstColumn && colIdx === 0 && 'fn-table__col--frozen',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <td
                      key={col.id}
                      className={tdClass}
                      style={cellStyle?.fill ? { background: cellStyle.fill } : undefined}
                      onMouseEnter={() => handleCellMouseEnter(rowIdx, colIdx)}
                    >
                      <TableCellContent
                        value={raw}
                        displayValue={displayValue}
                        formattedIdle={!formula && col.format !== undefined && numericForFormat !== null}
                        isFormula={formula}
                        hasError={!!result?.error}
                        attachments={attachments}
                        onChange={(next) => emitChange(updateCell(doc, row.id, col.id, next))}
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
                        textStyle={textStyleFor(cellStyle)}
                        onTextSelect={setCellSelChars}
                      />
                      {isFillOrigin && (
                        <span
                          className="fn-table__fill-handle"
                          title={t('tableEditor.fillHandleTooltip')}
                          onMouseDown={handleFillHandleMouseDown}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fn-table-editor__hint">
        {t('tableEditor.footerHint', { shown: displayRows.length, total: doc.rows.length })}
      </div>
    </div>
  );
}
