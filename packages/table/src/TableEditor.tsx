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
  FindReplaceController,
  FindReplaceStatus,
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
  swapCells,
  swapColumns,
  swapRows,
  updateCell,
} from './utils';
import {
  DELIMITER_PRIORITY,
  applyVerticalFill,
  copyDelimiterChar,
  encodeCellForCopy,
  loadTableDelimiters,
  parsePasteGrid,
  saveTableDelimiters,
  type TableDelimiter,
} from './fill';

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
  /** Registers the find/replace driver for this table (searches cell contents). */
  onRegisterFindReplace?: (controller: FindReplaceController | null) => void;
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
  onRegisterFindReplace,
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
  const [showDelims, setShowDelims] = useState(false);
  // Active cell delimiters (paste parsing + multi-cell copy); persisted app-wide in localStorage.
  const [delims, setDelims] = useState<TableDelimiter[]>(loadTableDelimiters);
  const toggleDelimiter = (d: TableDelimiter) => {
    setDelims((prev) => {
      const next = prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d];
      saveTableDelimiters(next);
      return next;
    });
  };
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
  const displayRowsRef = useRef(displayRows);
  displayRowsRef.current = displayRows;

  // Active find query for render-time highlighting: every cell whose raw value contains the
  // query gets a tint, the current match gets an outline (text-level marks are impossible
  // inside a textarea, so highlighting is cell-level).
  const [findMark, setFindMark] = useState<{
    query: string;
    current: { rowIdx: number; colIdx: number } | null;
  } | null>(null);

  // Find & replace over cell contents, driven by the shared FindReplaceBar. Matches are
  // occurrence-level across the visible (sorted/filtered) rows in display order; formula cells
  // match on their raw source. The current match is shown via the cell-selection highlight.
  const onRegisterFindReplaceRef = useRef(onRegisterFindReplace);
  onRegisterFindReplaceRef.current = onRegisterFindReplace;
  useEffect(() => {
    if (!onRegisterFindReplaceRef.current) return;
    interface TableFindMatch {
      rowIdx: number;
      colIdx: number;
      offset: number;
    }
    const state = { query: '', index: 0 };

    // Values are read from the given doc by row id (displayRowsRef can hold pre-edit row
    // snapshots right after a replace, before the next render lands).
    const cellValue = (d: TableDocument, rowId: string, colId: string) =>
      d.rows.find((r) => r.id === rowId)?.cells[colId] ?? '';

    const computeMatches = (d: TableDocument): TableFindMatch[] => {
      const q = state.query.toLowerCase();
      if (!q) return [];
      const matches: TableFindMatch[] = [];
      displayRowsRef.current.forEach((dr, rowIdx) => {
        d.columns.forEach((col, colIdx) => {
          const lower = cellValue(d, dr.id, col.id).toLowerCase();
          let i = lower.indexOf(q);
          while (i !== -1) {
            matches.push({ rowIdx, colIdx, offset: i });
            i = lower.indexOf(q, i + q.length);
          }
        });
      });
      return matches;
    };

    const statusOf = (matches: TableFindMatch[]): FindReplaceStatus => ({
      total: matches.length,
      current: matches.length > 0 ? Math.min(state.index, matches.length - 1) + 1 : 0,
    });

    const highlight = (m: TableFindMatch | undefined) => {
      setFindMark(
        state.query
          ? { query: state.query, current: m ? { rowIdx: m.rowIdx, colIdx: m.colIdx } : null }
          : null,
      );
      if (!m) return;
      setSelAnchor({ rowIdx: m.rowIdx, colIdx: m.colIdx });
      setSelFocus({ rowIdx: m.rowIdx, colIdx: m.colIdx });
      requestAnimationFrame(() => {
        tableWrapRef.current
          ?.querySelector(`textarea[data-row-idx="${m.rowIdx}"][data-col-idx="${m.colIdx}"]`)
          ?.scrollIntoView({ block: 'center', inline: 'nearest' });
      });
    };

    const step = (dir: 1 | -1): FindReplaceStatus => {
      const matches = computeMatches(docRef.current);
      if (matches.length === 0) return statusOf(matches);
      state.index = (Math.min(state.index, matches.length - 1) + dir + matches.length) % matches.length;
      highlight(matches[state.index]);
      return statusOf(matches);
    };

    onRegisterFindReplaceRef.current({
      search: (query) => {
        state.query = query;
        state.index = 0;
        const matches = computeMatches(docRef.current);
        highlight(matches[0]);
        return statusOf(matches);
      },
      next: () => step(1),
      prev: () => step(-1),
      replace: (replacement) => {
        const matches = computeMatches(docRef.current);
        const m = matches[Math.min(state.index, matches.length - 1)];
        if (!m) return statusOf(matches);
        const row = displayRowsRef.current[m.rowIdx];
        const col = docRef.current.columns[m.colIdx];
        if (!row || !col) return statusOf(matches);
        const raw = cellValue(docRef.current, row.id, col.id);
        const next = updateCell(
          docRef.current,
          row.id,
          col.id,
          raw.slice(0, m.offset) + replacement + raw.slice(m.offset + state.query.length),
        );
        emitChange(next);
        // docRef only refreshes on the next render — compute the post-replace status directly.
        const after = computeMatches(next);
        if (after.length > 0) {
          state.index = Math.min(state.index, after.length - 1);
          highlight(after[state.index]);
        }
        return statusOf(after);
      },
      replaceAll: (replacement) => {
        const matches = computeMatches(docRef.current);
        if (matches.length === 0) return 0;
        const q = state.query.toLowerCase();
        let next = docRef.current;
        const seen = new Set<string>();
        for (const m of matches) {
          const row = displayRowsRef.current[m.rowIdx];
          const col = next.columns[m.colIdx];
          if (!row || !col) continue;
          const key = `${row.id}:${col.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // Case-insensitive replace of every occurrence in this cell, done in one pass.
          const raw = cellValue(next, row.id, col.id);
          const lower = raw.toLowerCase();
          let out = '';
          let pos = 0;
          let i = lower.indexOf(q);
          while (i !== -1) {
            out += raw.slice(pos, i) + replacement;
            pos = i + q.length;
            i = lower.indexOf(q, pos);
          }
          out += raw.slice(pos);
          next = updateCell(next, row.id, col.id, out);
        }
        emitChange(next);
        return matches.length;
      },
      close: () => {
        state.query = '';
        state.index = 0;
        setFindMark(null);
      },
    });
    return () => onRegisterFindReplaceRef.current?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- all lookups go through refs
  }, []);

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

  // Main button only: a right-click must keep the current multi-cell selection (so the context
  // menu's Copy targets it) and must never arm drag-select — the context menu swallows the
  // matching mouseup, which would leave isSelecting stuck on until the next click drags out a
  // bogus selection.
  const handleCellMouseDown = (e: MouseEvent, rowIdx: number, colIdx: number) => {
    if (e.button !== 0) return;
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
    const grid = parsePasteGrid(e.clipboardData.getData('text/plain'), delims);
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
    const delimChar = copyDelimiterChar(delims);
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
        const value = isFormulaValue(raw) ? evaluateCellFormula(doc, row.id, col.id).display : raw;
        // Quote cells containing line breaks/delimiters so they round-trip as one cell.
        cells.push(encodeCellForCopy(value, delimChar));
      }
      lines.push(cells.join(delimChar));
    }
    return lines.join('\n');
  };

  /** Copy-event path (Ctrl+C inside a cell input, or Copy from a context menu). */
  const handleGridCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    const tsv = buildRangeTsv();
    if (tsv !== null) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', tsv);
      return;
    }
    // Single cell: when the whole multi-line value is selected (focusing a cell selects all),
    // copy it quoted so pasting into another cell keeps it one cell instead of fanning out
    // into multiple rows. Partial selections keep the native copy (plain text fragment).
    const el = document.activeElement;
    if (
      el instanceof HTMLTextAreaElement &&
      el.dataset.rowIdx !== undefined &&
      el.value.includes('\n') &&
      (el.selectionStart ?? 0) === 0 &&
      (el.selectionEnd ?? 0) === el.value.length
    ) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', encodeCellForCopy(el.value, copyDelimiterChar(delims)));
    }
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
    const el = tableWrapRef.current?.querySelector<HTMLTextAreaElement>(
      `textarea[data-row-idx="${rowIdx}"][data-col-idx="${colIdx}"]`,
    );
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const handleCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>, rowIdx: number, colIdx: number) => {
      if (e.key !== 'Enter') return;
      // Shift+Enter inserts an in-cell line break (the textarea's default behavior).
      if (e.shiftKey) return;
      e.preventDefault();
      // Move to the same column on the next visible row, spreadsheet-style. The selection
      // outline follows along — focusCellInput alone only moves the text caret.
      if (rowIdx + 1 < displayRows.length) {
        setSelAnchor({ rowIdx: rowIdx + 1, colIdx });
        setSelFocus({ rowIdx: rowIdx + 1, colIdx });
        focusCellInput(rowIdx + 1, colIdx);
      } else {
        (e.target as HTMLTextAreaElement).blur();
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

  // With a cell selected, "+column"/"+row" inserts before that cell's column/row (Excel-style);
  // with no selection it appends at the end. The selection is shifted so the same cells stay
  // selected after the insert.
  const handleAddColumn = useCallback(() => {
    lastActionRef.current = { type: 'addColumn' };
    const range = selectionRangeRef.current;
    emitChange(addColumn(docRef.current, locale, range?.colStart));
    if (range) {
      setSelAnchor((p) => (p && p.colIdx >= range.colStart ? { ...p, colIdx: p.colIdx + 1 } : p));
      setSelFocus((p) => (p && p.colIdx >= range.colStart ? { ...p, colIdx: p.colIdx + 1 } : p));
    }
  }, [locale, emitChange]);

  const handleAddRow = useCallback(() => {
    lastActionRef.current = { type: 'addRow' };
    const range = selectionRangeRef.current;
    // The selection's row index is a display index; map it to the underlying document row.
    const anchorRow = range ? displayRowsRef.current[range.rowStart] : undefined;
    const docIdx = anchorRow ? docRef.current.rows.findIndex((r) => r.id === anchorRow.id) : -1;
    emitChange(addRow(docRef.current, docIdx >= 0 ? docIdx : undefined));
    if (range && docIdx >= 0) {
      setSelAnchor((p) => (p && p.rowIdx >= range.rowStart ? { ...p, rowIdx: p.rowIdx + 1 } : p));
      setSelFocus((p) => (p && p.rowIdx >= range.rowStart ? { ...p, rowIdx: p.rowIdx + 1 } : p));
    }
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

  /**
   * Alt+Arrow reordering. What moves depends on the selection shape:
   * - a whole row selected (via its row number): Alt+Up/Down swaps it with the neighbouring row;
   * - a whole column selected (via its letter): Alt+Left/Right swaps it with the neighbour;
   * - a single cell: Alt+Arrow swaps its content (and per-cell style) with the adjacent cell.
   * Returns false when the selection/direction doesn't fit any of these, so the key keeps its
   * default behaviour (e.g. Alt+Left = word jump inside a cell input with no selection).
   * Row swaps reorder the underlying document, so with an active sort the display order (and the
   * selection) won't visibly change — expected, same as dragging would be.
   */
  const handleAltArrowMove = (key: string): boolean => {
    const range = selectionRange;
    if (!range) return false;
    const delta = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    const singleRow = range.rowStart === range.rowEnd;
    const singleCol = range.colStart === range.colEnd;
    const wholeRow =
      singleRow && range.colStart === 0 && range.colEnd === doc.columns.length - 1 && doc.columns.length > 1;
    const wholeCol =
      singleCol && range.rowStart === 0 && range.rowEnd === displayRows.length - 1 && displayRows.length > 1;

    if (wholeRow && vertical) {
      const target = range.rowStart + delta;
      const from = displayRows[range.rowStart];
      const to = displayRows[target];
      if (!from || !to) return false;
      emitChange(swapRows(docRef.current, from.id, to.id));
      setSelAnchor({ rowIdx: target, colIdx: 0 });
      setSelFocus({ rowIdx: target, colIdx: doc.columns.length - 1 });
      return true;
    }
    if (wholeCol && !vertical) {
      const target = range.colStart + delta;
      const from = doc.columns[range.colStart];
      const to = doc.columns[target];
      if (!from || !to) return false;
      emitChange(swapColumns(docRef.current, from.id, to.id));
      setSelAnchor({ rowIdx: 0, colIdx: target });
      setSelFocus({ rowIdx: displayRows.length - 1, colIdx: target });
      return true;
    }
    if (singleRow && singleCol) {
      const targetRow = range.rowStart + (vertical ? delta : 0);
      const targetCol = range.colStart + (vertical ? 0 : delta);
      const fromRow = displayRows[range.rowStart];
      const toRow = displayRows[targetRow];
      const fromCol = doc.columns[range.colStart];
      const toCol = doc.columns[targetCol];
      if (!fromRow || !toRow || !fromCol || !toCol) return false;
      emitChange(
        swapCells(
          docRef.current,
          { rowId: fromRow.id, colId: fromCol.id },
          { rowId: toRow.id, colId: toCol.id },
        ),
      );
      setSelAnchor({ rowIdx: targetRow, colIdx: targetCol });
      setSelFocus({ rowIdx: targetRow, colIdx: targetCol });
      requestAnimationFrame(() => focusCellInput(targetRow, targetCol));
      return true;
    }
    return false;
  };

  const handleContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (
      e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      if (handleAltArrowMove(e.key)) {
        e.preventDefault();
        return;
      }
    }
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
    // Mod+A selects the whole grid, spreadsheet-style two-stage behavior: while editing a cell
    // whose text isn't fully selected yet, the first press keeps the native select-all-in-cell;
    // pressing again (or when nothing is being edited) selects every cell.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement && el.dataset.rowIdx !== undefined) {
        const fullySelected =
          (el.selectionStart ?? 0) === 0 && (el.selectionEnd ?? 0) === el.value.length;
        if (!fullySelected && el.value.length > 0) return;
      }
      e.preventDefault();
      if (displayRows.length === 0 || doc.columns.length === 0) return;
      setSelAnchor({ rowIdx: 0, colIdx: 0 });
      setSelFocus({ rowIdx: displayRows.length - 1, colIdx: doc.columns.length - 1 });
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
            className={showDelims ? 'active' : ''}
            title={t('tableEditor.delimiters')}
            onClick={() => setShowDelims((v) => !v)}
          >
            ⌗
          </button>
          {showDelims && (
            <div className="fn-table-palette fn-table-delims-pop">
              <p className="fn-table-delims-pop__hint">{t('tableEditor.delimitersHint')}</p>
              {DELIMITER_PRIORITY.map((d) => (
                <label key={d} className="fn-table-delims-pop__item">
                  <input type="checkbox" checked={delims.includes(d)} onChange={() => toggleDelimiter(d)} />
                  <span>{t(`tableEditor.delimiter_${d}`)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
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
              <p>{t('tableEditor.helpMove')}</p>
              <p>{t('tableEditor.helpSelectAll')}</p>
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
                  onMouseDown={(e) => {
                    if (e.button === 0) selectRow(rowIdx);
                  }}
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
                  const findHit =
                    !!findMark && raw.toLowerCase().includes(findMark.query.toLowerCase());
                  const findCurrent =
                    !!findMark?.current &&
                    findMark.current.rowIdx === rowIdx &&
                    findMark.current.colIdx === colIdx;
                  const tdClass = [
                    'fn-table__cell',
                    isFillPreviewCell(rowIdx, colIdx) && 'fn-table__cell--fill-preview',
                    doc.freezeFirstColumn && colIdx === 0 && 'fn-table__col--frozen',
                    findHit && 'fn-table__cell--find',
                    findCurrent && 'fn-table__cell--find-current',
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
                        onCellMouseDown={(e) => handleCellMouseDown(e, rowIdx, colIdx)}
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
