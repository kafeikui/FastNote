import type { TableDocument } from '@fastnote/shared';
import { columnLetter, isFormulaValue, letterToColumnIndex } from './formula';

/**
 * Excel-style drag-fill and paste-grid helpers. Both operate on row/column *indices* of the
 * unsorted, unfiltered document (the editor only enables these interactions in that view).
 */

// Case-insensitive so drag-fill also shifts lowercase references (=sum(b1:b6)); the letters are
// written back exactly as typed. Function names never end in digits, so they can't match.
// The optional `$` groups capture Excel-style absolute anchors ($B$1) — an anchored axis is
// pinned during fill instead of shifted.
const CELL_REF = /(\$?)([A-Za-z]+)(\$?)(\d+)/g;

// Whole-column reference halves (`C:C` / `$C:$C`, or the open end of `C1:C`): letters directly
// adjacent to a range colon with no row digits (a trailing `$digits` marks a cell ref, not a
// column). Function names never touch a colon, so they can't match.
const COL_ONLY_REF = /(\$?)([A-Za-z]+)(?=:)|(?<=:)(\$?)([A-Za-z]+)(?![A-Za-z]*\$?\d)/g;

/** Shifts the row part of every A1-style cell reference in a formula by `offset` rows.
 *  `$`-anchored rows ($1) stay pinned. */
export function shiftFormulaRows(formula: string, offset: number): string {
  if (offset === 0) return formula;
  return formula.replace(CELL_REF, (m, dCol: string, col: string, dRow: string, row: string) => {
    if (dRow) return m;
    const next = parseInt(row, 10) + offset;
    return next >= 1 ? `${dCol}${col}${next}` : m;
  });
}

/** Shifts the column part of every cell/column reference in a formula by `offset` columns.
 *  `$`-anchored columns ($B) stay pinned. */
export function shiftFormulaCols(formula: string, offset: number): string {
  if (offset === 0) return formula;
  const shiftLetters = (letters: string): string => {
    const idx = letterToColumnIndex(letters.toUpperCase()) + offset;
    if (idx < 0) return letters;
    const out = columnLetter(idx);
    // Preserve the case style the user typed (=sum(b1) stays lowercase).
    return letters === letters.toLowerCase() ? out.toLowerCase() : out;
  };
  return formula
    .replace(CELL_REF, (m, dCol: string, col: string, dRow: string, row: string) =>
      dCol ? m : `${shiftLetters(col)}${dRow}${row}`,
    )
    .replace(COL_ONLY_REF, (m, d1: string | undefined, l1: string | undefined, d2: string | undefined, l2: string | undefined) => {
      const anchored = (d1 ?? d2) === '$';
      const letters = l1 ?? l2 ?? '';
      return anchored ? m : shiftLetters(letters);
    });
}

function isNumeric(raw: string): boolean {
  return raw.trim() !== '' && !Number.isNaN(Number(raw));
}

// --- date sequences ------------------------------------------------------------------------

interface ParsedDate {
  y: number;
  m: number;
  d: number;
  /** '-', '/', '.' — or 'cn' for the 2026年8月3日 form. */
  sep: string;
  /** Whether month/day were zero-padded in the source (preserved when formatting). */
  padM: boolean;
  padD: boolean;
}

const DATE_SEP_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const DATE_CN_RE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

/** Parses a plain date value (YYYY-MM-DD, YYYY/M/D, YYYY.M.D or YYYY年M月D日); null otherwise. */
export function parseDateValue(raw: string): ParsedDate | null {
  const s = raw.trim();
  const m = DATE_SEP_RE.exec(s) ?? DATE_CN_RE.exec(s);
  if (!m) return null;
  const sep = m.length === 5 ? m[2] : 'cn';
  const [y, mo, d] =
    sep === 'cn'
      ? [Number(m[1]), Number(m[2]), Number(m[3])]
      : [Number(m[1]), Number(m[3]), Number(m[4])];
  // Reject impossible dates (2026-02-30) via a UTC round-trip.
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const moStr = sep === 'cn' ? m[2] : m[3];
  const dStr = sep === 'cn' ? m[3] : m[4];
  return { y, m: mo, d, sep, padM: moStr.length === 2, padD: dStr.length === 2 };
}

/** Days since the epoch (UTC — immune to DST because only Y/M/D are ever involved). */
function dateToSerial(p: ParsedDate): number {
  return Date.UTC(p.y, p.m - 1, p.d) / 86400000;
}

/** Formats a day serial back into the source date's style (separator + zero padding). */
function formatDateLike(style: ParsedDate, serial: number): string {
  const dt = new Date(serial * 86400000);
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(style.padM ? 2 : 1, '0');
  const d = String(dt.getUTCDate()).padStart(style.padD ? 2 : 1, '0');
  if (style.sep === 'cn') return `${y}年${mo}月${d}日`;
  return `${y}${style.sep}${mo}${style.sep}${d}`;
}

function formatFillNumber(n: number): string {
  const rounded = Math.round(n * 1e9) / 1e9;
  return String(rounded);
}

const TRAILING_INT = /^(.*?)(\d+)$/;

/**
 * Computes the fill value for one target cell of one column.
 *
 * - all-numeric source: continues the arithmetic sequence (single value is copied)
 * - all-date source (YYYY-MM-DD / YYYY/M/D / YYYY.M.D / YYYY年M月D日): continues the day
 *   sequence — a single date advances one day per cell, two or more continue their day delta
 * - formula source: repeats the pattern with row (vertical fill) or column (horizontal fill)
 *   references shifted, like Excel relative refs
 * - single text value ending in a number: increments the trailing number ("Item 1" -> "Item 2")
 * - anything else: repeats the source pattern cyclically
 */
export function fillValueAt(
  sourceValues: string[],
  step: number,
  direction: 1 | -1 = 1,
  axis: 'row' | 'col' = 'row',
): string {
  const n = sourceValues.length;
  // step is the 1-based distance past the end of the source pattern.
  const cycle = (step - 1) % n;
  const repeat = Math.floor((step - 1) / n) + 1;
  const base = sourceValues[cycle];

  const dates = sourceValues.map(parseDateValue);
  if (dates.every((d): d is NonNullable<typeof d> => d !== null)) {
    const serials = dates.map(dateToSerial);
    if (n === 1) {
      return formatDateLike(dates[0], serials[0] + direction * step);
    }
    // Like numbers: the caller passes the source reversed when filling up/left, so the derived
    // delta already points in the right direction.
    const delta = (serials[n - 1] - serials[0]) / (n - 1);
    return formatDateLike(dates[0], Math.round(serials[0] + delta * (n + step - 1)));
  }

  if (sourceValues.every((v) => isNumeric(v))) {
    if (n === 1) {
      return formatFillNumber(Number(sourceValues[0]) + direction * step);
    }
    // n >= 2: the caller passes the source reversed when filling upwards, so the derived delta
    // already points in the right direction.
    const first = Number(sourceValues[0]);
    const last = Number(sourceValues[n - 1]);
    const delta = (last - first) / (n - 1);
    return formatFillNumber(first + delta * (n + step - 1));
  }

  if (isFormulaValue(base)) {
    const offset = direction * repeat * n;
    return axis === 'col' ? shiftFormulaCols(base, offset) : shiftFormulaRows(base, offset);
  }

  if (n === 1) {
    const m = TRAILING_INT.exec(base);
    if (m) {
      const width = m[2].length;
      const nextNum = parseInt(m[2], 10) + direction * step;
      if (nextNum >= 0) {
        return `${m[1]}${String(nextNum).padStart(width, '0')}`;
      }
    }
  }

  return base;
}

export interface FillRange {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
}

/**
 * Extends the selected range vertically to `targetRowEnd` (below) or `targetRowStart` above the
 * selection when dragging upwards. Row indices refer to `doc.rows`.
 */
export function applyVerticalFill(
  doc: TableDocument,
  selection: FillRange,
  targetRow: number,
): TableDocument {
  const { rowStart, rowEnd, colStart, colEnd } = selection;
  if (targetRow >= rowStart && targetRow <= rowEnd) return doc;
  const downward = targetRow > rowEnd;
  const targets: number[] = [];
  if (downward) {
    for (let r = rowEnd + 1; r <= targetRow && r < doc.rows.length; r++) targets.push(r);
  } else {
    for (let r = rowStart - 1; r >= targetRow && r >= 0; r--) targets.push(r);
  }
  if (targets.length === 0) return doc;

  const rows = doc.rows.map((r) => ({ ...r, cells: { ...r.cells } }));
  for (let c = colStart; c <= colEnd; c++) {
    const col = doc.columns[c];
    if (!col) continue;
    const source: string[] = [];
    for (let r = rowStart; r <= rowEnd; r++) source.push(doc.rows[r]?.cells[col.id] ?? '');
    const reversed = [...source].reverse();
    targets.forEach((rowIdx, i) => {
      const value = downward
        ? fillValueAt(source, i + 1, 1)
        : fillValueAt(reversed, i + 1, -1);
      rows[rowIdx].cells[col.id] = value;
    });
  }
  return { ...doc, rows };
}

/**
 * Extends the selected range horizontally to `targetCol` (right of the selection) or leftwards
 * when dragging left. Column indices refer to `doc.columns`; formulas shift column references.
 */
export function applyHorizontalFill(
  doc: TableDocument,
  selection: FillRange,
  targetCol: number,
): TableDocument {
  const { rowStart, rowEnd, colStart, colEnd } = selection;
  if (targetCol >= colStart && targetCol <= colEnd) return doc;
  const rightward = targetCol > colEnd;
  const targets: number[] = [];
  if (rightward) {
    for (let c = colEnd + 1; c <= targetCol && c < doc.columns.length; c++) targets.push(c);
  } else {
    for (let c = colStart - 1; c >= targetCol && c >= 0; c--) targets.push(c);
  }
  if (targets.length === 0) return doc;

  const rows = doc.rows.map((r) => ({ ...r, cells: { ...r.cells } }));
  for (let r = rowStart; r <= rowEnd; r++) {
    const srcRow = doc.rows[r];
    if (!srcRow) continue;
    const source: string[] = [];
    for (let c = colStart; c <= colEnd; c++) source.push(srcRow.cells[doc.columns[c]?.id ?? ''] ?? '');
    const reversed = [...source].reverse();
    targets.forEach((colIdx, i) => {
      const colId = doc.columns[colIdx]?.id;
      if (!colId) return;
      rows[r].cells[colId] = rightward
        ? fillValueAt(source, i + 1, 1, 'col')
        : fillValueAt(reversed, i + 1, -1, 'col');
    });
  }
  return { ...doc, rows };
}

/**
 * User-selectable cell delimiters for paste parsing and multi-cell copy. Checked in the
 * DELIMITER_PRIORITY order: tab wins over semicolon/comma (structured exports), whitespace last
 * (it matches almost anything). Comma is OFF by default — real-world values ("1,234.56",
 * "Hello, world") contain it far too often, so comma-splitting mangles pastes more than it helps.
 */
export type TableDelimiter = 'tab' | 'semicolon' | 'comma' | 'space';

export const DELIMITER_PRIORITY: TableDelimiter[] = ['tab', 'semicolon', 'comma', 'space'];
export const DEFAULT_DELIMITERS: TableDelimiter[] = ['tab', 'space'];

/** The character used when *writing* (multi-cell copy) with this delimiter. */
export const DELIMITER_CHAR: Record<TableDelimiter, string> = {
  tab: '\t',
  semicolon: ';',
  comma: ',',
  space: ' ',
};

const DELIMITERS_STORAGE_KEY = 'fastnote_table_delimiters';

export function loadTableDelimiters(): TableDelimiter[] {
  try {
    const raw = localStorage.getItem(DELIMITERS_STORAGE_KEY);
    if (!raw) return DEFAULT_DELIMITERS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_DELIMITERS;
    return DELIMITER_PRIORITY.filter((d) => parsed.includes(d));
  } catch {
    return DEFAULT_DELIMITERS;
  }
}

export function saveTableDelimiters(delims: TableDelimiter[]): void {
  try {
    localStorage.setItem(DELIMITERS_STORAGE_KEY, JSON.stringify(delims));
  } catch {
    /* storage unavailable — setting just won't persist */
  }
}

/** The delimiter char multi-cell copy should join with (highest-priority active one; tab when
 * nothing is active, since copied output needs *some* separator to round-trip). */
export function copyDelimiterChar(active: TableDelimiter[]): string {
  const first = DELIMITER_PRIORITY.find((d) => active.includes(d));
  return DELIMITER_CHAR[first ?? 'tab'];
}

/**
 * Excel-style quoting for one copied cell: values containing a line break, the delimiter, or a
 * quote are wrapped in double quotes (inner quotes doubled), so an in-cell Shift+Enter line
 * break survives a copy → paste round-trip instead of being parsed as a row separator.
 */
export function encodeCellForCopy(value: string, delimChar: string): string {
  if (!value.includes('\n') && !value.includes('"') && !value.includes(delimChar)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Splits clipboard text into rows/cells honoring Excel-style double-quoted fields: inside a
 * quoted field (quote at field start), delimiters and newlines are literal content and `""` is
 * an escaped quote. `delim` is a single char, 'space' (any run of blanks, collapsed, edges
 * trimmed — the legacy whitespace mode), or null (rows only).
 */
function splitQuoteAware(text: string, delim: string | 'space' | null): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let curQuoted = false;
  const isDelim = (ch: string) =>
    delim === 'space' ? ch === ' ' || ch === '\t' : delim !== null && ch === delim;
  const pushCell = () => {
    // Space mode collapses delimiter runs, so empty unquoted fragments between blanks vanish.
    if (delim === 'space' && cur === '' && !curQuoted) return;
    row.push(curQuoted ? cur : cur.trim());
    cur = '';
    curQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && cur.trim() === '' && !curQuoted) {
      // Potential quoted field. Only treat it as one if a closing quote exists; otherwise the
      // quote is literal text (e.g. `"unbalanced).
      let j = i + 1;
      let val = '';
      let closed = false;
      while (j < text.length) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            val += '"';
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        val += text[j];
        j++;
      }
      if (closed) {
        cur = val;
        curQuoted = true;
        i = j - 1;
        continue;
      }
    }
    if (ch === '\n') {
      pushCell();
      if (delim === 'space' && row.length === 0) row.push('');
      rows.push(row);
      row = [];
      continue;
    }
    if (isDelim(ch)) {
      pushCell();
      continue;
    }
    // Lenient: stray text after a closing quote (rare, malformed) is appended as-is.
    cur += ch;
  }
  pushCell();
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * Parses clipboard text into a 2D grid using the active delimiters. Rows split on newlines and
 * cells on the highest-priority active delimiter that actually appears in the text (so a
 * tab-separated Excel paste is never mangled by a comma inside a value when both are active) —
 * except inside double-quoted fields, which keep delimiters *and newlines* literally (this is
 * how a multi-line cell copied from this table or Excel survives the round-trip). With no
 * active delimiters, each line stays a single cell (multi-line pastes still fill a column).
 * Returns null when the text is a single plain value (caller keeps the default paste behavior);
 * a single *quoted* value still parses, so its quotes never land in the cell literally.
 */
export function parsePasteGrid(
  text: string,
  active: TableDelimiter[] = DEFAULT_DELIMITERS,
): string[][] | null {
  if (!text) return null;
  const normalized = text.replace(/\r\n?/g, '\n');

  let delim: string | 'space' | null = null;
  for (const d of DELIMITER_PRIORITY) {
    if (!active.includes(d)) continue;
    if (d === 'space') {
      if (/[^\S\n]/.test(normalized.trim())) {
        delim = 'space';
        break;
      }
    } else if (normalized.includes(DELIMITER_CHAR[d])) {
      delim = DELIMITER_CHAR[d];
      break;
    }
  }

  const rows = splitQuoteAware(normalized, delim);
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  if (rows.length === 0) return null;
  if (rows.length === 1 && rows[0].length <= 1) {
    const only = rows[0]?.[0] ?? '';
    // A plain single value → let the native paste insert at the caret. A transformed value
    // (it was quoted) must go through the grid path or the quotes would paste literally.
    if (only === normalized.trim()) return null;
    return [[only]];
  }
  return rows;
}
