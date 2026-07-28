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
  FORMULA_PREFIX,
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
  setAllRowHeights,
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
  /**
   * Registers a select-all action (select every cell), used by the app-level Ctrl/Cmd+A so
   * "select all" grabs the grid instead of the whole UI when focus is outside the table.
   */
  onRegisterSelectAll?: (fn: (() => void) | null) => void;
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
  onRegisterSelectAll,
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
  // Filter row visibility (app-wide preference). Collapsing clears active filters so no
  // rows can stay invisibly hidden behind a collapsed filter row.
  const [showFilters, setShowFilters] = useState(
    () => localStorage.getItem('fastnote_table_filters_visible') !== '0',
  );
  const toggleFilters = () => {
    setShowFilters((prev) => {
      const next = !prev;
      localStorage.setItem('fastnote_table_filters_visible', next ? '1' : '0');
      if (!next) setFilters({});
      return next;
    });
  };
  // Where "+column"/"+row" inserts relative to the selected cell (app-wide preference).
  const [insertDir, setInsertDir] = useState<'before' | 'after'>(() =>
    localStorage.getItem('fastnote_table_insert_dir') === 'after' ? 'after' : 'before',
  );
  const insertDirRef = useRef(insertDir);
  insertDirRef.current = insertDir;
  const changeInsertDir = (dir: 'before' | 'after') => {
    setInsertDir(dir);
    localStorage.setItem('fastnote_table_insert_dir', dir);
  };
  // Uniform row-height popover (applies one height to every row, or resets all to auto).
  const [showRowHeightPop, setShowRowHeightPop] = useState(false);
  const [rowHeightDraft, setRowHeightDraft] = useState('32');
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

  const onRegisterSelectAllRef = useRef(onRegisterSelectAll);
  onRegisterSelectAllRef.current = onRegisterSelectAll;
  useEffect(() => {
    if (!onRegisterSelectAllRef.current) return;
    onRegisterSelectAllRef.current(() => {
      const rows = displayRowsRef.current.length;
      const cols = docRef.current.columns.length;
      if (rows === 0 || cols === 0) return;
      // Focus the grid so the selection is visible and follow-up keys (Mod+C, Esc…) land here.
      containerRef.current?.focus();
      setSelAnchor({ rowIdx: 0, colIdx: 0 });
      setSelFocus({ rowIdx: rows - 1, colIdx: cols - 1 });
    });
    return () => onRegisterSelectAllRef.current?.(null);
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

  // ---- Formula cell-reference picking (spreadsheet-style) -----------------------------------
  // While a cell holding "=..." is being edited, clicking another cell inserts its reference
  // (A1) instead of moving focus; dragging widens it to a range (A1:B3); clicking a column
  // letter inserts a whole-column reference (C:C). Row numbers are document-order (matching
  // the visible row numbers), so references stay correct under sort/filter.

  interface FormulaPick {
    textarea: HTMLTextAreaElement;
    rowId: string;
    colId: string;
    /** Offset of the reference text inside the formula, and its current length/content. */
    start: number;
    length: number;
    text: string;
    /** Drag anchor in document coordinates (null for whole-column references). */
    anchor: { col: number; row: number } | null;
  }
  /** Active while the mouse button is down on a picked cell (drag extends the range). */
  const formulaPickRef = useRef<FormulaPick | null>(null);
  /** Last inserted reference; a follow-up click replaces it (Excel-style) instead of appending. */
  const lastFormulaRefRef = useRef<Omit<FormulaPick, 'anchor' | 'rowId' | 'colId'> | null>(null);
  /** Set on the column letter's mousedown to make the subsequent click skip selectColumn. */
  const suppressColSelectRef = useRef(false);

  /** The formula-cell textarea currently being edited, or null. */
  const activeFormulaEdit = () => {
    const el = document.activeElement;
    if (!(el instanceof HTMLTextAreaElement) || !tableWrapRef.current?.contains(el)) return null;
    if (!el.value.trimStart().startsWith(FORMULA_PREFIX)) return null;
    const rowIdx = Number(el.dataset.rowIdx);
    const colIdx = Number(el.dataset.colIdx);
    const row = displayRowsRef.current[rowIdx];
    const col = docRef.current.columns[colIdx];
    if (!row || !col) return null;
    return { textarea: el, rowId: row.id, colId: col.id, rowIdx, colIdx };
  };

  /** Display row index -> 1-based document row number used in references. */
  const docRowNumber = (displayRowIdx: number): number => {
    const row = displayRowsRef.current[displayRowIdx];
    const idx = row ? docRef.current.rows.findIndex((r) => r.id === row.id) : -1;
    return idx >= 0 ? idx + 1 : displayRowIdx + 1;
  };

  const rangeRefText = (a: { col: number; row: number }, b: { col: number; row: number }): string => {
    if (a.col === b.col && a.row === b.row) return `${columnLetter(a.col)}${a.row}`;
    const c1 = Math.min(a.col, b.col);
    const c2 = Math.max(a.col, b.col);
    const r1 = Math.min(a.row, b.row);
    const r2 = Math.max(a.row, b.row);
    return `${columnLetter(c1)}${r1}:${columnLetter(c2)}${r2}`;
  };

  /** Writes `refText` into the formula, replacing the last inserted reference when the caret
   *  hasn't moved off it (so consecutive clicks retarget instead of concatenating). */
  const writeFormulaRef = (
    fe: NonNullable<ReturnType<typeof activeFormulaEdit>>,
    refText: string,
    anchor: { col: number; row: number } | null,
    pushHistory: boolean,
  ) => {
    const el = fe.textarea;
    const value = el.value;
    let start = el.selectionStart ?? value.length;
    let removed = (el.selectionEnd ?? start) - start;
    const last = lastFormulaRefRef.current;
    if (
      last &&
      last.textarea === el &&
      value.slice(last.start, last.start + last.length) === last.text &&
      start === last.start + last.length &&
      removed === 0
    ) {
      start = last.start;
      removed = last.length;
    }
    const next = value.slice(0, start) + refText + value.slice(start + removed);
    const update = updateCell(docRef.current, fe.rowId, fe.colId, next);
    if (pushHistory) emitChange(update);
    else onChangeRef.current(update);
    lastFormulaRefRef.current = { textarea: el, start, length: refText.length, text: refText };
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + refText.length, start + refText.length);
    });
    return { start, length: refText.length, text: refText, anchor };
  };

  /** True when the given grid cell's textarea currently has focus (i.e. is being edited). */
  const isEditingCell = (rowIdx: number, colIdx: number): boolean => {
    const el = document.activeElement;
    return (
      el instanceof HTMLTextAreaElement &&
      Number(el.dataset.rowIdx) === rowIdx &&
      Number(el.dataset.colIdx) === colIdx
    );
  };

  // Main button only: a right-click must keep the current multi-cell selection (so the context
  // menu's Copy targets it) and must never arm drag-select — the context menu swallows the
  // matching mouseup, which would leave isSelecting stuck on until the next click drags out a
  // bogus selection.
  const handleCellMouseDown = (e: MouseEvent, rowIdx: number, colIdx: number) => {
    if (e.button !== 0) {
      // Right/middle click must not focus the cell's textarea — focusing is what enters edit
      // mode, which would swap the grid's context menu for the native text menu.
      if (!isEditingCell(rowIdx, colIdx)) e.preventDefault();
      return;
    }
    const fe = activeFormulaEdit();
    if (fe && (fe.rowIdx !== rowIdx || fe.colIdx !== colIdx)) {
      // Keep focus (and the caret) inside the formula cell; insert a reference instead.
      e.preventDefault();
      const anchor = { col: colIdx, row: docRowNumber(rowIdx) };
      const written = writeFormulaRef(fe, rangeRefText(anchor, anchor), anchor, true);
      formulaPickRef.current = { textarea: fe.textarea, rowId: fe.rowId, colId: fe.colId, ...written };
      return;
    }
    // Clicking inside the cell that's already being edited keeps native caret placement.
    if (isEditingCell(rowIdx, colIdx)) return;
    // Attachment chips keep their native interactions (click actions, HTML5 drag reordering).
    if ((e.target as HTMLElement).closest?.('.fn-embed-attach')) {
      setSelAnchor({ rowIdx, colIdx });
      setSelFocus({ rowIdx, colIdx });
      return;
    }
    // Excel-style: a single click only selects. Block the mousedown from focusing the cell's
    // textarea, commit any other cell's edit (blur), and keep keyboard focus on the grid so
    // arrows / Enter / Del / typing keep working.
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.dataset.rowIdx !== undefined) active.blur();
    containerRef.current?.focus();
    if (e.shiftKey && selAnchor) {
      // Shift+click extends the selection from the anchor, spreadsheet-style.
      setSelFocus({ rowIdx, colIdx });
      return;
    }
    setSelAnchor({ rowIdx, colIdx });
    setSelFocus({ rowIdx, colIdx });
    setIsSelecting(true);
  };

  /** Enters edit mode on a cell: selects it, focuses its textarea and places the caret. */
  const startEditCell = useCallback((rowIdx: number, colIdx: number, caret: 'end' | 'all' = 'end') => {
    setSelAnchor({ rowIdx, colIdx });
    setSelFocus({ rowIdx, colIdx });
    requestAnimationFrame(() => {
      const el = tableWrapRef.current?.querySelector<HTMLTextAreaElement>(
        `textarea[data-row-idx="${rowIdx}"][data-col-idx="${colIdx}"]`,
      );
      if (!el) return;
      el.focus();
      if (caret === 'all') el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const handleCellDoubleClick = (e: MouseEvent, rowIdx: number, colIdx: number) => {
    if (isEditingCell(rowIdx, colIdx)) return; // already editing: native word-select applies
    if ((e.target as HTMLElement).closest?.('.fn-embed-attach')) return; // chips: own actions
    startEditCell(rowIdx, colIdx, 'end');
  };

  const handleCellMouseEnter = (rowIdx: number, colIdx: number) => {
    const pick = formulaPickRef.current;
    if (pick?.anchor) {
      // Dragging across cells widens the picked reference into a range.
      const el = pick.textarea;
      const cur = { col: colIdx, row: docRowNumber(rowIdx) };
      const refText = rangeRefText(pick.anchor, cur);
      if (refText === pick.text) return;
      const value = el.value;
      const next = value.slice(0, pick.start) + refText + value.slice(pick.start + pick.length);
      const row = docRef.current.rows.find((r) => r.id === pick.rowId);
      if (row) onChangeRef.current(updateCell(docRef.current, pick.rowId, pick.colId, next));
      pick.length = refText.length;
      pick.text = refText;
      lastFormulaRefRef.current = { textarea: el, start: pick.start, length: refText.length, text: refText };
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pick.start + refText.length, pick.start + refText.length);
      });
      return;
    }
    if (isFilling) {
      setFillTargetRow(rowIdx);
      return;
    }
    if (!isSelecting) return;
    setSelFocus({ rowIdx, colIdx });
  };

  // The pick's drag phase ends on mouseup anywhere; the "replace on next click" memory
  // (lastFormulaRefRef) survives until the formula cell's value changes some other way.
  useEffect(() => {
    const clear = () => {
      formulaPickRef.current = null;
    };
    window.addEventListener('mouseup', clear);
    return () => window.removeEventListener('mouseup', clear);
  }, []);

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

  /**
   * Clears the target cells' text formatting (bold / font size / colors). When the
   * selection covers entire columns, those columns' number format is cleared too —
   * mirrors how the toolbar's number-format controls are column-scoped.
   */
  const clearFormatting = () => {
    if (formatTargets.length === 0) {
      alert(t('tableEditor.formatNeedTarget'));
      return;
    }
    let next = applyCellStyle(docRef.current, formatTargets, {
      bold: undefined,
      fontSize: undefined,
      color: undefined,
      fill: undefined,
      align: undefined,
      valign: undefined,
    });
    const wholeColumns =
      selectionRange !== null &&
      selectionRange.rowStart === 0 &&
      selectionRange.rowEnd >= displayRows.length - 1;
    if (wholeColumns) {
      for (const colId of formatColIds) next = setColumnFormat(next, colId, undefined);
    }
    emitChange(next);
  };

  /** Cell that toolbar insertions target: the selected cell (Excel-style single-click
   *  selection), falling back to the last edited cell. */
  const insertTargetCell = (): { rowId: string; colId: string } | null => {
    if (selFocus) {
      const row = displayRows[selFocus.rowIdx];
      const col = doc.columns[selFocus.colIdx];
      if (row && col) return { rowId: row.id, colId: col.id };
    }
    return focusCell;
  };

  const insertLocalTime = () => {
    const target = insertTargetCell();
    if (!target) {
      alert(t('tableEditor.selectCellFirst'));
      return;
    }
    const row = docRef.current.rows.find((r) => r.id === target.rowId);
    const cur = row?.cells[target.colId] ?? '';
    if (isFormulaValue(cur)) return;
    const now = formatLocalTime(new Date());
    const next = cur.trim() ? `${cur.trim()} ${now}` : now;
    emitChange(updateCell(docRef.current, target.rowId, target.colId, next));
  };

  const textStyleFor = (style: TableCellStyle | undefined): CSSProperties | undefined => {
    if (!style) return undefined;
    const out: CSSProperties = {};
    if (style.bold) out.fontWeight = 700;
    if (style.fontSize) out.fontSize = `${style.fontSize}px`;
    if (style.color) out.color = style.color;
    if (style.align) out.textAlign = style.align;
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
      // No movement means this was (half of) a double-click for auto-fit — don't pollute the
      // undo history with a no-op width commit.
      if (ev.clientX !== startX) emitChange(setColumnWidth(docRef.current, colId, startWidth + ev.clientX - startX));
      setLiveColWidth(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /**
   * Double-clicking a column's resize handle sizes it to fit the widest rendered content
   * (Excel/Sheets-style). Widths are measured with a canvas using each cell's effective font
   * (bold / per-cell font size respected); formula and number-formatted cells measure their
   * displayed value, multiline cells their longest line.
   */
  const autoFitColumn = (colId: string) => {
    const d = docRef.current;
    const col = d.columns.find((c) => c.id === colId);
    const measure = document.createElement('canvas').getContext('2d');
    if (!col || !measure) return;
    const baseFamily = tableWrapRef.current
      ? getComputedStyle(tableWrapRef.current).fontFamily
      : 'sans-serif';
    const baseSize = tableWrapRef.current
      ? parseFloat(getComputedStyle(tableWrapRef.current).fontSize) || 14.4
      : 14.4;
    // Header row: letter chip + name + rename/delete buttons need roughly 76px beside the name.
    measure.font = `600 ${baseSize}px ${baseFamily}`;
    let best = measure.measureText(col.name).width + 76;
    for (const row of d.rows) {
      const raw = row.cells[colId] ?? '';
      if (!raw.trim()) continue;
      const formula = isFormulaValue(raw);
      const result = formula ? evaluateCellFormula(d, row.id, colId) : null;
      const numeric = col.format && !result?.error ? (formula ? result!.value : parseNumericValue(raw)) : null;
      const shown =
        col.format && numeric !== null ? formatColumnNumber(numeric, col.format) : formula ? result!.display : raw;
      const style = row.styles?.[colId];
      measure.font = `${style?.bold ? '700' : '400'} ${style?.fontSize ?? baseSize}px ${baseFamily}`;
      for (const line of shown.split('\n')) {
        best = Math.max(best, measure.measureText(line).width);
      }
    }
    // Cell padding (0.35rem each side) + a little slack so text doesn't touch the border.
    emitChange(setColumnWidth(d, colId, Math.ceil(best) + 16));
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

  /** Writes a parsed grid into the table starting at (startRow, startCol), growing it as needed. */
  const applyGridAt = (startRow: number, startCol: number, grid: string[][]) => {
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

  // Multi-cell paste: parses tab/comma/whitespace-separated clipboard text into a grid anchored
  // at the target cell, growing the table as needed. While editing a cell, single values keep
  // the browser default (insert at caret); with only a selection, they replace the anchor cell.
  const handleGridPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (!isPlainView) return;
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement) return; // filter/rename/symbol inputs: native paste
    const text = e.clipboardData.getData('text/plain');
    const rowAttr = target.dataset?.rowIdx;
    const colAttr = target.dataset?.colIdx;
    if (rowAttr !== undefined && colAttr !== undefined) {
      const grid = parsePasteGrid(text, delims);
      if (!grid) return;
      e.preventDefault();
      applyGridAt(Number(rowAttr), Number(colAttr), grid);
      return;
    }
    // No cell being edited (grid container focused): paste replaces content at the selection.
    const range = selectionRangeRef.current;
    if (!range || !text) return;
    e.preventDefault();
    applyGridAt(range.rowStart, range.colStart, parsePasteGrid(text, delims) ?? [[text]]);
  };

  /** Context-menu Paste: replaces content starting at the selection's top-left cell. */
  const pasteIntoSelection = async () => {
    const range = selectionRangeRef.current;
    if (!range || !isPlainView) return;
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // Clipboard read denied (e.g. the desktop app) — fall back to the internal copy buffer.
    }
    if (!text) text = internalClipboardRef.current ?? '';
    if (!text) {
      alert(t('tableEditor.pasteUnavailable'));
      return;
    }
    applyGridAt(range.rowStart, range.colStart, parsePasteGrid(text, delims) ?? [[text]]);
  };

  /** Clears the values of every cell in the current selection (Del / context-menu Clear). */
  const clearSelectedCells = useCallback(() => {
    const range = selectionRangeRef.current;
    if (!range) return;
    let next = docRef.current;
    let changed = false;
    for (let r = range.rowStart; r <= range.rowEnd; r++) {
      const row = displayRowsRef.current[r];
      if (!row) continue;
      for (let c = range.colStart; c <= range.colEnd; c++) {
        const col = docRef.current.columns[c];
        if (!col) continue;
        if ((next.rows.find((x) => x.id === row.id)?.cells[col.id] ?? '') !== '') {
          next = updateCell(next, row.id, col.id, '');
          changed = true;
        }
      }
    }
    if (changed) emitChange(next);
  }, [emitChange]);

  // ---- Right-click context menu (copy / copy values / paste / clear) ------------------------

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    // The menu itself stops mousedown propagation so its buttons still receive their click.
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const handleCellContextMenu = (e: MouseEvent, rowIdx: number, colIdx: number) => {
    // While editing this cell, keep the native text menu (cut/copy/paste inside the textarea).
    if (isEditingCell(rowIdx, colIdx)) return;
    e.preventDefault();
    // Right-clicking outside the current selection retargets it to the clicked cell.
    if (!isCellSelected(rowIdx, colIdx)) {
      setSelAnchor({ rowIdx, colIdx });
      setSelFocus({ rowIdx, colIdx });
    }
    containerRef.current?.focus();
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // Multi-cell copy: a selection spanning more than one cell is copied as tab-separated values
  // (rows newline-separated) — pasteable into Excel/Sheets and back into this table
  // (handleGridPaste splits on tabs first). Formula cells copy their computed value.
  // Copying part of one cell's text still works naturally: clicking into a cell collapses the
  // range to that single cell, so buildRangeTsv() returns null and native copy takes over.
  /**
   * TSV of the current selection. `mode: 'values'` copies computed formula results (the
   * default, and what Ctrl+C does); `mode: 'raw'` copies formula source so formulas survive a
   * paste back into a table. Returns null for an empty selection, and — unless `allowSingle`
   * (context-menu copy) — for single-cell selections, where native copy takes over.
   */
  const buildRangeTsv = (mode: 'values' | 'raw' = 'values', allowSingle = false): string | null => {
    const range = selectionRange;
    if (!range) return null;
    if (!allowSingle && range.rowStart === range.rowEnd && range.colStart === range.colEnd) return null;
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
        const value =
          mode === 'values' && isFormulaValue(raw)
            ? evaluateCellFormula(doc, row.id, col.id).display
            : raw;
        // Quote cells containing line breaks/delimiters so they round-trip as one cell.
        cells.push(encodeCellForCopy(value, delimChar));
      }
      lines.push(cells.join(delimChar));
    }
    return lines.join('\n');
  };

  /**
   * Last text this grid copied. The context menu's Paste prefers the real clipboard, but the
   * renderer may be denied clipboard-read (the desktop app denies all clipboard permissions);
   * this buffer keeps copy → paste working within the app in that case.
   */
  const internalClipboardRef = useRef<string | null>(null);

  /** Copy-event path (Ctrl+C inside a cell input, or Copy from a context menu). */
  const handleGridCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    // Toolbar/filter/rename inputs keep their native copy behavior.
    if (document.activeElement instanceof HTMLInputElement) return;
    const tsv = buildRangeTsv();
    if (tsv !== null) {
      e.preventDefault();
      e.clipboardData.setData('text/plain', tsv);
      internalClipboardRef.current = tsv;
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

  /** Writes text to the clipboard through a hidden textarea + execCommand('copy') — the app's
   *  permissionless clipboard-write path (works despite denied clipboard permissions). */
  const copyTextToClipboard = (text: string) => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    prevFocus?.focus();
    internalClipboardRef.current = text;
  };

  /**
   * Keydown fallback for when no cell input is focused (a selected-but-not-editing cell, a
   * whole row/column selected via its header, or the grid itself holding focus) — pressing
   * Mod+C then fires no copy event at all. Copies computed values, single cells included
   * (Excel-style selection means a lone selected cell has no text focus to copy natively).
   */
  const copyRangeViaExecCommand = (): boolean => {
    const tsv = buildRangeTsv('values', true);
    if (tsv === null) return false;
    copyTextToClipboard(tsv);
    return true;
  };

  const selectColumn = (colIdx: number) => {
    if (displayRows.length === 0) return;
    // Move keyboard focus to the grid so arrows / Del / copy shortcuts act on the selection.
    containerRef.current?.focus();
    setSelAnchor({ rowIdx: 0, colIdx });
    setSelFocus({ rowIdx: displayRows.length - 1, colIdx });
  };

  const selectRow = (rowIdx: number) => {
    if (doc.columns.length === 0) return;
    containerRef.current?.focus();
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

  /** Value a cell held when its edit began (textarea focus) — what Esc reverts to. */
  const editStartValueRef = useRef<{ rowId: string; colId: string; value: string } | null>(null);
  /** Set by the Esc-revert path so the following blur doesn't re-finalize the reverted formula. */
  const skipFinalizeRef = useRef(false);

  /**
   * Tidies a formula when the edit ends (Enter / focus moved away): strips thousand-separator
   * commas typed inside numbers (`=1,000+5` → `=1000+5`; grouping must be strict 3-digit so
   * argument commas like `SUM(A1,B2)` are untouched) and appends any missing closing parens.
   * This only rewrites the stored source — column number formatting is a separate display layer.
   */
  const finalizeFormulaParens = useCallback(
    (rowId: string, colId: string) => {
      const raw = docRef.current.rows.find((r) => r.id === rowId)?.cells[colId] ?? '';
      if (!isFormulaValue(raw)) return;
      let next = raw.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, (m) => m.replace(/,/g, ''));
      const missing = (next.match(/\(/g) ?? []).length - (next.match(/\)/g) ?? []).length;
      if (missing > 0) next += ')'.repeat(missing);
      if (next !== raw) emitChange(updateCell(docRef.current, rowId, colId, next));
    },
    [emitChange],
  );

  const handleEditBlur = useCallback(
    (rowId: string, colId: string) => {
      if (skipFinalizeRef.current) {
        skipFinalizeRef.current = false;
        return;
      }
      finalizeFormulaParens(rowId, colId);
    },
    [finalizeFormulaParens],
  );

  const handleCellKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>, rowIdx: number, colIdx: number) => {
      const cellIds = () => {
        const row = displayRowsRef.current[rowIdx];
        const col = docRef.current.columns[colIdx];
        return row && col ? { rowId: row.id, colId: col.id } : null;
      };

      // Esc cancels the current edit: the cell reverts to its value from when editing began,
      // and the grid returns to a no-selection state.
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const ids = cellIds();
        const start = editStartValueRef.current;
        if (
          ids &&
          start &&
          start.rowId === ids.rowId &&
          start.colId === ids.colId &&
          (docRef.current.rows.find((r) => r.id === ids.rowId)?.cells[ids.colId] ?? '') !== start.value
        ) {
          emitChange(updateCell(docRef.current, ids.rowId, ids.colId, start.value));
        }
        skipFinalizeRef.current = true;
        (e.target as HTMLTextAreaElement).blur();
        // Keep keyboard focus on the grid so shortcuts (Mod+A, F4, …) still land here.
        containerRef.current?.focus();
        setSelAnchor(null);
        setSelFocus(null);
        setFocusCell(null);
        return;
      }

      // Shift+Arrow moves the selected cell and starts editing it; the current cell's edits
      // are kept (they're already committed per keystroke) and formulas get closed parens.
      if (
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
      ) {
        const targetRow =
          e.key === 'ArrowUp' ? rowIdx - 1 : e.key === 'ArrowDown' ? rowIdx + 1 : rowIdx;
        const targetCol =
          e.key === 'ArrowLeft' ? colIdx - 1 : e.key === 'ArrowRight' ? colIdx + 1 : colIdx;
        if (
          targetRow < 0 ||
          targetRow >= displayRowsRef.current.length ||
          targetCol < 0 ||
          targetCol >= docRef.current.columns.length
        )
          return;
        e.preventDefault();
        const ids = cellIds();
        if (ids) finalizeFormulaParens(ids.rowId, ids.colId);
        setSelAnchor({ rowIdx: targetRow, colIdx: targetCol });
        setSelFocus({ rowIdx: targetRow, colIdx: targetCol });
        focusCellInput(targetRow, targetCol);
        return;
      }

      if (e.key !== 'Enter') return;
      // Shift+Enter inserts an in-cell line break (the textarea's default behavior).
      if (e.shiftKey) return;
      e.preventDefault();
      const ids = cellIds();
      if (ids) finalizeFormulaParens(ids.rowId, ids.colId);
      // Excel-style: Enter commits the edit and moves the *selection* down one row without
      // opening the next cell for editing (press Enter again — or type — to edit it). Keyboard
      // focus returns to the grid so arrows / Del / typing keep working.
      (e.target as HTMLTextAreaElement).blur();
      containerRef.current?.focus();
      if (rowIdx + 1 < displayRows.length) {
        setSelAnchor({ rowIdx: rowIdx + 1, colIdx });
        setSelFocus({ rowIdx: rowIdx + 1, colIdx });
      } else {
        setSelAnchor({ rowIdx, colIdx });
        setSelFocus({ rowIdx, colIdx });
      }
    },
    [displayRows.length, focusCellInput, emitChange, finalizeFormulaParens],
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
      let target: { rowId: string; colId: string } | null = null;
      if (selFocus) {
        const row = displayRows[selFocus.rowIdx];
        const col = doc.columns[selFocus.colIdx];
        if (row && col) target = { rowId: row.id, colId: col.id };
      }
      if (!target) target = focusCell;
      if (!target) {
        alert(t('tableEditor.selectCellFirst'));
        return;
      }
      const row = doc.rows.find((r) => r.id === target.rowId);
      const cur = row?.cells[target.colId] ?? '';
      if (isFormulaValue(cur)) return;
      const next = cur.trim() ? `${cur.trim()} ${ref}` : ref;
      emitChange(updateCell(doc, target.rowId, target.colId, next));
    },
    [doc, focusCell, selFocus, displayRows, emitChange, t],
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

  // With a cell selected, "+column"/"+row" inserts next to that cell's column/row — before
  // (above/left) or after (below/right) per the toolbar's insert-direction preference; with no
  // selection it appends at the end. The selection is shifted so the same cells stay selected.
  const handleAddColumn = useCallback(() => {
    lastActionRef.current = { type: 'addColumn' };
    const range = selectionRangeRef.current;
    const at = range ? (insertDirRef.current === 'before' ? range.colStart : range.colEnd + 1) : undefined;
    emitChange(addColumn(docRef.current, locale, at));
    if (range && at !== undefined) {
      setSelAnchor((p) => (p && p.colIdx >= at ? { ...p, colIdx: p.colIdx + 1 } : p));
      setSelFocus((p) => (p && p.colIdx >= at ? { ...p, colIdx: p.colIdx + 1 } : p));
    }
  }, [locale, emitChange]);

  const handleAddRow = useCallback(() => {
    lastActionRef.current = { type: 'addRow' };
    const range = selectionRangeRef.current;
    // The selection's row index is a display index; map it to the underlying document row.
    const edgeRow = range
      ? displayRowsRef.current[insertDirRef.current === 'before' ? range.rowStart : range.rowEnd]
      : undefined;
    const edgeDocIdx = edgeRow ? docRef.current.rows.findIndex((r) => r.id === edgeRow.id) : -1;
    const docIdx = edgeDocIdx >= 0 ? (insertDirRef.current === 'before' ? edgeDocIdx : edgeDocIdx + 1) : undefined;
    emitChange(addRow(docRef.current, docIdx));
    if (range && insertDirRef.current === 'before' && docIdx !== undefined) {
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
      // Whether the swap started from inside the cell's editor (vs. a mere selection) decides
      // if the moved cell should stay in edit mode afterwards.
      const wasEditing = isEditingCell(range.rowStart, range.colStart);
      emitChange(
        swapCells(
          docRef.current,
          { rowId: fromRow.id, colId: fromCol.id },
          { rowId: toRow.id, colId: toCol.id },
        ),
      );
      setSelAnchor({ rowIdx: targetRow, colIdx: targetCol });
      setSelFocus({ rowIdx: targetRow, colIdx: targetCol });
      if (wasEditing) requestAnimationFrame(() => focusCellInput(targetRow, targetCol));
      return true;
    }
    return false;
  };

  const handleContainerKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys that drive the grid (arrows / Enter / Del / typing) only apply when the key wasn't
    // pressed inside an interactive element — while editing a cell (or using a filter input /
    // toolbar select or button) they keep their native behavior. This checks the event target
    // (the element focused when the key was pressed), not document.activeElement: the cell-level
    // Enter handler blurs the cell and refocuses the grid *before* the event bubbles up here,
    // so activeElement would wrongly report "grid" and re-open the just-committed cell.
    const targetEl = e.target;
    const inTextField =
      targetEl instanceof HTMLInputElement ||
      targetEl instanceof HTMLTextAreaElement ||
      targetEl instanceof HTMLSelectElement ||
      targetEl instanceof HTMLButtonElement;
    const arrowKey =
      e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const clampPos = (rowIdx: number, colIdx: number): CellPos => ({
      rowIdx: Math.min(Math.max(rowIdx, 0), displayRows.length - 1),
      colIdx: Math.min(Math.max(colIdx, 0), doc.columns.length - 1),
    });
    const arrowDelta = (key: string) => ({
      dr: key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0,
      dc: key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0,
    });

    // Esc with a selection but no cell being edited (e.g. a row/column selected via its
    // header): drop the selection entirely. The editing case is handled in handleCellKeyDown,
    // which stops propagation.
    if (e.key === 'Escape' && (selAnchor || selFocus || focusCell)) {
      e.preventDefault();
      setSelAnchor(null);
      setSelFocus(null);
      setFocusCell(null);
      return;
    }
    // Excel-style keyboard selection (only when the grid itself holds focus):
    // plain arrows move the selected cell, Shift+Arrow extends the selection from the anchor.
    if (arrowKey && !e.ctrlKey && !e.metaKey && !e.altKey && selFocus && !inTextField) {
      e.preventDefault();
      const { dr, dc } = arrowDelta(e.key);
      const target = clampPos(selFocus.rowIdx + dr, selFocus.colIdx + dc);
      if (e.shiftKey) {
        setSelFocus(target);
      } else {
        setSelAnchor(target);
        setSelFocus(target);
      }
      return;
    }
    // Enter with a selected cell starts editing it (caret at the end, Excel F2-style).
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && selFocus && !inTextField) {
      e.preventDefault();
      startEditCell(selFocus.rowIdx, selFocus.colIdx, 'end');
      return;
    }
    // Del (Backspace on mac keyboards) clears the contents of the selected cells.
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectionRange && !inTextField) {
      e.preventDefault();
      clearSelectedCells();
      return;
    }
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
      return;
    }
    // Excel-style type-to-edit: with a cell selected (grid focused), typing a printable
    // character replaces the cell's content and starts editing. (IME input can't start on the
    // non-editable grid — double-click or press Enter first for composed input.)
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && selFocus && !inTextField) {
      const row = displayRowsRef.current[selFocus.rowIdx];
      const col = docRef.current.columns[selFocus.colIdx];
      if (!row || !col) return;
      e.preventDefault();
      const prev = docRef.current.rows.find((r) => r.id === row.id)?.cells[col.id] ?? '';
      const pos = { rowIdx: selFocus.rowIdx, colIdx: selFocus.colIdx };
      emitChange(updateCell(docRef.current, row.id, col.id, e.key));
      startEditCell(pos.rowIdx, pos.colIdx, 'end');
      // startEditCell's focus handler snapshots the *typed* char as the Esc-revert value;
      // restore the true pre-edit value afterwards (rAFs run in registration order).
      requestAnimationFrame(() => {
        editStartValueRef.current = { rowId: row.id, colId: col.id, value: prev };
      });
    }
  };

  return (
    <div
      className="fn-table-editor"
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleContainerKeyDown}
      // On the container (not the table wrap) so copy/paste also fire when the grid itself
      // holds focus (Excel-style selection without an editing cell).
      onPaste={handleGridPaste}
      onCopy={handleGridCopy}
    >
      <div className="fn-table-editor__tools">
        <button type="button" onClick={handleAddColumn}>
          {t('tableEditor.addColumn')}
        </button>
        <button type="button" onClick={handleAddRow}>
          {t('tableEditor.addRow')}
        </button>
        <select
          className="fn-table-fmt__size"
          title={t('tableEditor.insertDirTitle')}
          value={insertDir}
          onChange={(e) => changeInsertDir(e.target.value as 'before' | 'after')}
        >
          <option value="before">{t('tableEditor.insertBefore')}</option>
          <option value="after">{t('tableEditor.insertAfter')}</option>
        </select>
        <div className="fn-table-palette-wrap">
          <button
            type="button"
            className={showRowHeightPop ? 'active' : ''}
            title={t('tableEditor.uniformRowHeight')}
            onClick={() => setShowRowHeightPop((v) => !v)}
          >
            ↕
          </button>
          {showRowHeightPop && (
            <div className="fn-table-palette fn-table-rowheight-pop">
              <label className="fn-table-rowheight-pop__row">
                <span>{t('tableEditor.uniformRowHeightLabel')}</span>
                <input
                  type="number"
                  min={MIN_ROW_HEIGHT}
                  max={MAX_ROW_HEIGHT}
                  value={rowHeightDraft}
                  onChange={(e) => setRowHeightDraft(e.target.value)}
                />
              </label>
              <div className="fn-table-rowheight-pop__actions">
                <button
                  type="button"
                  onClick={() => {
                    const h = Math.round(Number(rowHeightDraft));
                    if (!Number.isFinite(h)) return;
                    emitChange(setAllRowHeights(docRef.current, h));
                    setShowRowHeightPop(false);
                  }}
                >
                  {t('tableEditor.uniformRowHeightApply')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    emitChange(setAllRowHeights(docRef.current, undefined));
                    setShowRowHeightPop(false);
                  }}
                >
                  {t('tableEditor.uniformRowHeightAuto')}
                </button>
              </div>
            </div>
          )}
        </div>
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
        <select
          className="fn-table-fmt__size"
          title={t('tableEditor.alignH')}
          value={anchorStyle.align ?? ''}
          onChange={(e) =>
            applyStyle({ align: (e.target.value || undefined) as TableCellStyle['align'] })
          }
        >
          <option value="">{t('tableEditor.alignHDefault')}</option>
          <option value="left">{t('tableEditor.alignLeft')}</option>
          <option value="center">{t('tableEditor.alignCenter')}</option>
          <option value="right">{t('tableEditor.alignRight')}</option>
        </select>
        <select
          className="fn-table-fmt__size"
          title={t('tableEditor.alignV')}
          value={anchorStyle.valign ?? ''}
          onChange={(e) =>
            applyStyle({ valign: (e.target.value || undefined) as TableCellStyle['valign'] })
          }
        >
          <option value="">{t('tableEditor.alignVDefault')}</option>
          <option value="top">{t('tableEditor.alignTop')}</option>
          <option value="middle">{t('tableEditor.alignMiddle')}</option>
          <option value="bottom">{t('tableEditor.alignBottom')}</option>
        </select>
        <button type="button" title={t('tableEditor.clearFormatting')} onClick={clearFormatting}>
          <span className="fn-table-fmt__clear">T</span>
        </button>
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
          className={showFilters ? 'active' : ''}
          title={showFilters ? t('tableEditor.hideFilters') : t('tableEditor.showFilters')}
          onClick={toggleFilters}
        >
          ▽
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
            const kind = e.target.value as '' | 'number' | 'currency' | 'percent';
            applyColumnFormat((cur) =>
              kind === '' ? undefined : { kind, decimals: cur?.decimals ?? 2, symbol: cur?.symbol ?? '$' },
            );
          }}
        >
          <option value="">{t('tableEditor.numberFormatNone')}</option>
          <option value="number">{t('tableEditor.numberFormatNumber')}</option>
          <option value="currency">{t('tableEditor.numberFormatCurrency')}</option>
          <option value="percent">{t('tableEditor.numberFormatPercent')}</option>
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
              <p>{t('tableEditor.helpExcel')}</p>
              <p>{t('tableEditor.formulaHint')}</p>
              <p>{t('tableEditor.helpFormulaRef')}</p>
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
        {/* Row count lives here (not in a footer line) so the area below the table stays free. */}
        <span>{t('tableEditor.stats.rows', { shown: String(displayRows.length), total: String(doc.rows.length) })}</span>
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
      </div>
      <div className="fn-table-wrap" ref={tableWrapRef}>
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
                        onMouseDown={(e) => {
                          // While editing a formula, clicking the column letter inserts a
                          // whole-column reference (C:C) instead of selecting the column.
                          if (e.button !== 0) return;
                          const fe = activeFormulaEdit();
                          if (!fe) return;
                          e.preventDefault();
                          const letter = columnLetter(colIdx);
                          writeFormulaRef(fe, `${letter}:${letter}`, null, true);
                          suppressColSelectRef.current = true;
                        }}
                        onClick={() => {
                          if (suppressColSelectRef.current) {
                            suppressColSelectRef.current = false;
                            return;
                          }
                          selectColumn(colIdx);
                        }}
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
                    {showFilters && (
                      <input
                        className="fn-table__filter"
                        placeholder={t('tableEditor.filterPlaceholder')}
                        value={filters[col.id] ?? ''}
                        onChange={(e) => setFilters((f) => ({ ...f, [col.id]: e.target.value }))}
                      />
                    )}
                    <span
                      className="fn-table__col-resize"
                      title={t('tableEditor.colResizeTitle')}
                      onMouseDown={(e) => handleColResizeStart(e, col.id)}
                      onDoubleClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        autoFitColumn(col.id);
                      }}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIdx) => {
              const fixedHeight = rowHeightFor(row.id, row.height);
              return (
              <tr
                key={row.id}
                // The class + CSS var let cells actually clip to small heights: a bare CSS-table
                // row height is only a *minimum*, so without capping the cell content, rows
                // could never shrink below their natural content height.
                className={fixedHeight ? 'fn-table__row--fixed' : undefined}
                style={
                  fixedHeight
                    ? ({ height: fixedHeight, '--fn-row-h': `${fixedHeight}px` } as CSSProperties)
                    : undefined
                }
              >
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
                  const tdStyle: CSSProperties | undefined =
                    cellStyle?.fill || cellStyle?.valign
                      ? {
                          ...(cellStyle?.fill ? { background: cellStyle.fill } : {}),
                          ...(cellStyle?.valign ? { verticalAlign: cellStyle.valign } : {}),
                        }
                      : undefined;
                  return (
                    <td
                      key={col.id}
                      className={tdClass}
                      style={tdStyle}
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
                        onFocus={() => {
                          setFocusCell({ rowId: row.id, colId: col.id });
                          // Snapshot for Esc: reverts the cell to this value if editing is canceled.
                          editStartValueRef.current = {
                            rowId: row.id,
                            colId: col.id,
                            value: docRef.current.rows.find((r) => r.id === row.id)?.cells[col.id] ?? '',
                          };
                        }}
                        onEditBlur={() => handleEditBlur(row.id, col.id)}
                        onDownload={(id) => onAttachmentDownload?.(id)}
                        onEdit={(id, desc) => onAttachmentEdit?.(id, desc)}
                        selected={isCellSelected(rowIdx, colIdx)}
                        onCellMouseDown={(e) => handleCellMouseDown(e, rowIdx, colIdx)}
                        onCellMouseEnter={() => handleCellMouseEnter(rowIdx, colIdx)}
                        onCellDoubleClick={(e) => handleCellDoubleClick(e, rowIdx, colIdx)}
                        onCellContextMenu={(e) => handleCellContextMenu(e, rowIdx, colIdx)}
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
              );
            })}
          </tbody>
        </table>
      </div>
      {ctxMenu && (
        <div
          className="fn-table__ctx-menu"
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          // Keep the window-level dismiss listener from eating the buttons' clicks.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              const text = buildRangeTsv('raw', true);
              if (text !== null) copyTextToClipboard(text);
              setCtxMenu(null);
            }}
          >
            {t('tableEditor.ctxCopy')}
          </button>
          <button
            type="button"
            onClick={() => {
              const text = buildRangeTsv('values', true);
              if (text !== null) copyTextToClipboard(text);
              setCtxMenu(null);
            }}
          >
            {t('tableEditor.ctxCopyValues')}
          </button>
          <button
            type="button"
            disabled={!isPlainView}
            onClick={() => {
              setCtxMenu(null);
              void pasteIntoSelection();
            }}
          >
            {t('tableEditor.ctxPaste')}
          </button>
          <button
            type="button"
            onClick={() => {
              clearSelectedCells();
              setCtxMenu(null);
            }}
          >
            {t('tableEditor.ctxClear')}
          </button>
        </div>
      )}
    </div>
  );
}
