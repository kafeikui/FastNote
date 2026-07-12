import type { TableDocument } from '@fastnote/shared';
import { isFormulaValue } from './formula';

/**
 * Excel-style drag-fill and paste-grid helpers. Both operate on row/column *indices* of the
 * unsorted, unfiltered document (the editor only enables these interactions in that view).
 */

const CELL_REF = /([A-Z]+)(\d+)/g;

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
 * Parses clipboard text into a 2D grid using the active delimiters. Rows always split on
 * newlines; cells split on the highest-priority active delimiter that actually appears in the
 * text (so a tab-separated Excel paste is never mangled by a comma inside a value when both are
 * active). With no active delimiters, each line stays a single cell (multi-line pastes still
 * fill a column). Returns null when the text is effectively a single value (caller keeps the
 * default paste behavior).
 */
export function parsePasteGrid(
  text: string,
  active: TableDelimiter[] = DEFAULT_DELIMITERS,
): string[][] | null {
  if (!text) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return null;

  let splitLine: (line: string) => string[] = (l) => [l];
  for (const d of DELIMITER_PRIORITY) {
    if (!active.includes(d)) continue;
    if (d === 'space') {
      if (lines.some((l) => /\s/.test(l.trim()))) {
        splitLine = (l) => (l.trim() === '' ? [''] : l.trim().split(/\s+/));
        break;
      }
    } else {
      const ch = DELIMITER_CHAR[d];
      if (lines.some((l) => l.includes(ch))) {
        splitLine = (l) => l.split(ch);
        break;
      }
    }
  }

  const grid = lines.map((l) => splitLine(l).map((v) => v.trim()));
  if (grid.length === 1 && grid[0].length <= 1) return null;
  return grid;
}
