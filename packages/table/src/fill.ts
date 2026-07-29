import type { TableDocument } from '@fastnote/shared';
import { isFormulaValue } from './formula';

/**
 * Excel-style drag-fill and paste-grid helpers. Both operate on row/column *indices* of the
 * unsorted, unfiltered document (the editor only enables these interactions in that view).
 */

// Case-insensitive so drag-fill also shifts lowercase references (=sum(b1:b6)); the letters are
// written back exactly as typed. Function names never end in digits, so they can't match.
const CELL_REF = /([A-Za-z]+)(\d+)/g;

/** Shifts the row part of every A1-style cell reference in a formula by `offset` rows. */
export function shiftFormulaRows(formula: string, offset: number): string {
  if (offset === 0) return formula;
  return formula.replace(CELL_REF, (_m, col: string, row: string) => {
    const next = parseInt(row, 10) + offset;
    return next >= 1 ? `${col}${next}` : `${col}${row}`;
  });
}

function isNumeric(raw: string): boolean {
  return raw.trim() !== '' && !Number.isNaN(Number(raw));
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
 * - formula source: repeats the pattern with row references shifted, like Excel relative refs
 * - single text value ending in a number: increments the trailing number ("Item 1" -> "Item 2")
 * - anything else: repeats the source pattern cyclically
 */
export function fillValueAt(sourceValues: string[], step: number, direction: 1 | -1 = 1): string {
  const n = sourceValues.length;
  // step is the 1-based distance past the end of the source pattern.
  const cycle = (step - 1) % n;
  const repeat = Math.floor((step - 1) / n) + 1;
  const base = sourceValues[cycle];

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
    return shiftFormulaRows(base, direction * repeat * n);
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
