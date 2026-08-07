import type { TableColumnFormat, TableDocument } from '@fastnote/shared';

export const FORMULA_PREFIX = '=';

/**
 * Parses a cell value as a number, accepting comma thousand separators ("1,234.56"). The comma
 * form is only accepted with strict 3-digit grouping so that genuinely textual values like
 * "1,2" or "a,b" don't silently become numbers.
 */
export function parseNumericValue(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const plain = Number(s);
  if (!Number.isNaN(plain)) return plain;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    return Number(s.replace(/,/g, ''));
  }
  return null;
}

/**
 * Resolves the display format that actually applies to a cell: the cell-level override (from
 * the cell/row/column style chain) beats the column format, and a cell-level kind 'none'
 * explicitly disables formatting even inside a formatted column.
 */
export function resolveCellFormat(
  cellFormat: TableColumnFormat | undefined,
  colFormat: TableColumnFormat | undefined,
): TableColumnFormat | undefined {
  const f = cellFormat ?? colFormat;
  return f && f.kind !== 'none' ? f : undefined;
}

/** Formats a numeric value according to a column's number format (thousand separators + fixed decimals). */
export function formatColumnNumber(n: number, format: TableColumnFormat): string {
  const decimals = Math.min(Math.max(format.decimals ?? 2, 0), 6);
  // Percent: 0.5 displays as 50% (Excel semantics — the raw value stays a plain ratio).
  // The ×100 result is snapped to 15 significant digits so binary float artifacts don't flip
  // the rounding (1.2345 → 123.44999… → would show 123.4% instead of 123.5%).
  const scaled = format.kind === 'percent' ? Number((n * 100).toPrecision(15)) : n;
  const formatted = scaled.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (format.kind === 'percent') return `${formatted}%`;
  return format.kind === 'currency' ? `${format.symbol ?? '$'}${formatted}` : formatted;
}

const SUPPORTED_FUNCTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX'] as const;
type FunctionName = (typeof SUPPORTED_FUNCTIONS)[number];

export function isFormulaValue(raw: string): boolean {
  return raw.trim().startsWith(FORMULA_PREFIX);
}

/** 0-based column index -> spreadsheet-style letter (0 -> 'A', 25 -> 'Z', 26 -> 'AA', ...). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Spreadsheet-style letters -> 0-based column index ('A' -> 0, 'Z' -> 25, 'AA' -> 26, ...). */
export function letterToColumnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

interface CellRef {
  col: number;
  row: number;
}

function parseCellRefToken(word: string): CellRef | null {
  const m = /^([A-Z]+)([0-9]+)$/.exec(word);
  if (!m) return null;
  return { col: letterToColumnIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

/** Pure-letter token (e.g. "C" in the whole-column range C:C) -> 0-based column index. */
function parseColOnlyToken(word: string): number | null {
  return /^[A-Z]+$/.test(word) ? letterToColumnIndex(word) : null;
}

// ---------------------------------------------------------------------------------------------
// Reference rewriting after structural edits (row/column insert & delete).
//
// References are rewritten as *units*: a lone cell ref (`C5`) or a whole range (`B1:B6`, `C:C`,
// `C1:C`) with both endpoints together, because ranges need boundary semantics a token-by-token
// shift can't express (a range must absorb a row inserted just below its last row, and shrink —
// or turn into #REF! — when a row inside it is deleted).

/** One endpoint of a reference: `row === null` for column-only endpoints (the C in C:C).
 *  `absCol`/`absRow` carry Excel-style `$` anchors ($B$1) through a rewrite. */
interface RefEndpoint {
  col: number;
  row: number | null;
  absCol?: boolean;
  absRow?: boolean;
}

type RefUnit =
  | { type: 'cell'; col: number; row: number; absCol?: boolean; absRow?: boolean }
  | { type: 'range'; a: RefEndpoint; b: RefEndpoint };

/** Sentinel returned by a unit rewriter when the referenced row/column was deleted. */
const REF_ERROR = '#REF!';

function formatEndpoint(e: RefEndpoint): string {
  return (
    (e.absCol ? '$' : '') +
    columnLetter(e.col) +
    (e.row === null ? '' : (e.absRow ? '$' : '') + String(e.row + 1))
  );
}

function formatUnit(unit: RefUnit): string {
  if (unit.type === 'cell') {
    return (unit.absCol ? '$' : '') + columnLetter(unit.col) + (unit.absRow ? '$' : '') + String(unit.row + 1);
  }
  return `${formatEndpoint(unit.a)}:${formatEndpoint(unit.b)}`;
}

/**
 * Scans a formula for reference units and pipes each through `rewrite`; the callback returns a
 * changed unit, the string `REF_ERROR`, or null to keep the original text. Function names
 * (letters followed by `(`) and stray words are left untouched. `$` anchors are parsed and
 * re-emitted, but don't change how structural edits shift a reference (Excel adjusts absolute
 * refs on insert/delete too — `$` only pins refs during fill/copy).
 */
function rewriteFormulaRefs(
  raw: string,
  rewrite: (unit: RefUnit) => RefUnit | typeof REF_ERROR | null,
): string {
  const re = /(\$?)([A-Za-z]+)(\$?)([0-9]*)/g;
  const tokens: Array<{
    start: number;
    end: number;
    letters: string;
    digits: string;
    absCol: boolean;
    absRow: boolean;
  }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    tokens.push({
      start: m.index,
      end: m.index + m[0].length,
      letters: m[2],
      digits: m[4],
      absCol: m[1] === '$',
      absRow: m[3] === '$' && m[4] !== '',
    });
  }
  const endpointOf = (tok: (typeof tokens)[number]): RefEndpoint => ({
    col: letterToColumnIndex(tok.letters.toUpperCase()),
    row: tok.digits ? parseInt(tok.digits, 10) - 1 : null,
    absCol: tok.absCol,
    absRow: tok.absRow,
  });
  let out = '';
  let last = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const next = tokens[i + 1];
    const isFnName = !tok.digits && /^\s*\(/.test(raw.slice(tok.end));
    // `A1:B6` / `C:C` / `C1:C` — the two tokens joined by a lone colon form one range unit.
    const joinsNext = next !== undefined && /^\s*:\s*$/.test(raw.slice(tok.end, next.start));
    let unit: RefUnit | null = null;
    let unitEnd = tok.end;
    if (!isFnName && joinsNext) {
      unit = { type: 'range', a: endpointOf(tok), b: endpointOf(next!) };
      unitEnd = next!.end;
      i++;
    } else if (tok.digits) {
      const e = endpointOf(tok);
      unit = { type: 'cell', col: e.col, row: e.row!, absCol: e.absCol, absRow: e.absRow };
    }
    if (!unit) continue;
    const result = rewrite(unit);
    if (result === null) continue;
    out += raw.slice(last, tok.start) + (result === REF_ERROR ? REF_ERROR : formatUnit(result));
    last = unitEnd;
  }
  return out + raw.slice(last);
}

/**
 * Rewrites references after a row/column insertion at `insertIndex` (0-based splice position).
 *
 * Lone cell refs shift when at/after the insertion point. Range endpoints use spreadsheet
 * "absorb" semantics on the row axis: the start only shifts when the insertion is strictly above
 * it, and the end also extends when the row is inserted directly below it — so `=SUM(B1:B6)`
 * becomes `=SUM(B1:B7)` whether the new row lands above B1, inside the range, or right after B6.
 * Column insertion uses the plain shift (a new column next to a range is a new data series, not
 * part of it). Non-formula values are returned unchanged.
 */
export function rewriteFormulaRefsForInsert(
  raw: string,
  kind: 'row' | 'col',
  insertIndex: number,
): string {
  if (!isFormulaValue(raw)) return raw;
  const i = insertIndex;
  return rewriteFormulaRefs(raw, (unit) => {
    if (unit.type === 'cell') {
      if (kind === 'col') return unit.col >= i ? { ...unit, col: unit.col + 1 } : null;
      return unit.row >= i ? { ...unit, row: unit.row + 1 } : null;
    }
    const a = { ...unit.a };
    const b = { ...unit.b };
    let changed = false;
    if (kind === 'col') {
      if (a.col >= i) (a.col += 1), (changed = true);
      if (b.col >= i) (b.col += 1), (changed = true);
    } else if (a.row !== null && b.row !== null) {
      const [lo, hi] = a.row <= b.row ? [a, b] : [b, a];
      if (i < lo.row!) (lo.row! += 1), (changed = true);
      if (i <= hi.row! + 1) (hi.row! += 1), (changed = true);
    } else {
      // Mixed form (C1:C): the bounded endpoint is the start; the open end always covers the
      // new row anyway (the evaluator treats these as whole-column).
      for (const e of [a, b]) {
        if (e.row !== null && i < e.row) (e.row += 1), (changed = true);
      }
    }
    return changed ? { type: 'range', a, b } : null;
  });
}

/**
 * Rewrites references after deleting the row/column at `deleteIndex`. Refs past the deleted
 * index shift back; a lone ref to the deleted row/column becomes `#REF!` (shown as the cell's
 * result, like spreadsheets do); ranges shrink when the deletion falls inside them and become
 * `#REF!` only when nothing is left. Non-formula values are returned unchanged.
 */
export function rewriteFormulaRefsForDelete(
  raw: string,
  kind: 'row' | 'col',
  deleteIndex: number,
): string {
  if (!isFormulaValue(raw)) return raw;
  const d = deleteIndex;
  return rewriteFormulaRefs(raw, (unit) => {
    if (unit.type === 'cell') {
      if (kind === 'col') {
        if (unit.col === d) return REF_ERROR;
        return unit.col > d ? { ...unit, col: unit.col - 1 } : null;
      }
      if (unit.row === d) return REF_ERROR;
      return unit.row > d ? { ...unit, row: unit.row - 1 } : null;
    }
    const a = { ...unit.a };
    const b = { ...unit.b };
    let changed = false;
    if (kind === 'col') {
      const [lo, hi] = a.col <= b.col ? [a, b] : [b, a];
      if (d < lo.col) {
        // Deleted column is left of the range: the whole range shifts.
        lo.col -= 1;
        hi.col -= 1;
        changed = true;
      } else if (d <= hi.col) {
        // Deleted column is inside the range: shrink — unless it was the only column.
        if (hi.col === lo.col) return REF_ERROR;
        hi.col -= 1;
        changed = true;
      }
    } else if (a.row !== null && b.row !== null) {
      const [lo, hi] = a.row <= b.row ? [a, b] : [b, a];
      if (d < lo.row!) {
        lo.row! -= 1;
        hi.row! -= 1;
        changed = true;
      } else if (d <= hi.row!) {
        if (hi.row === lo.row) return REF_ERROR;
        hi.row! -= 1;
        changed = true;
      }
    } else {
      // Mixed form (C1:C): shift the bounded start when a row above it was deleted.
      for (const e of [a, b]) {
        if (e.row !== null && d < e.row) (e.row -= 1), (changed = true);
      }
    }
    return changed ? { type: 'range', a, b } : null;
  });
}

/**
 * Rewrites references after two rows or two columns swap positions (Alt+Arrow reordering).
 * References follow the moved content — a reference to row/column `i` now points at `j` and
 * vice versa — so a formula's result never changes because of a swap. Range endpoints are
 * mapped the same way and re-normalized (so a swap entirely inside or entirely outside a
 * range leaves it untouched). Non-formula values are returned unchanged.
 */
export function rewriteFormulaRefsForSwap(
  raw: string,
  kind: 'row' | 'col',
  i: number,
  j: number,
): string {
  if (!isFormulaValue(raw) || i === j) return raw;
  const map = (v: number): number => (v === i ? j : v === j ? i : v);
  return rewriteFormulaRefs(raw, (unit) => {
    if (unit.type === 'cell') {
      const next =
        kind === 'col' ? { ...unit, col: map(unit.col) } : { ...unit, row: map(unit.row) };
      return next.col === unit.col && next.row === unit.row ? null : next;
    }
    const a = { ...unit.a };
    const b = { ...unit.b };
    if (kind === 'col') {
      a.col = map(a.col);
      b.col = map(b.col);
    } else {
      if (a.row !== null) a.row = map(a.row);
      if (b.row !== null) b.row = map(b.row);
    }
    // Re-normalize corner order (mixed forms like C1:C keep their endpoint roles); `$` anchors
    // travel with the value they pin.
    if (a.col > b.col) {
      const t = a.col;
      a.col = b.col;
      b.col = t;
      const tf = a.absCol;
      a.absCol = b.absCol;
      b.absCol = tf;
    }
    if (a.row !== null && b.row !== null && a.row > b.row) {
      const t = a.row;
      a.row = b.row;
      b.row = t;
      const tf = a.absRow;
      a.absRow = b.absRow;
      b.absRow = tf;
    }
    return a.col === unit.a.col && a.row === unit.a.row && b.col === unit.b.col && b.row === unit.b.row
      ? null
      : { type: 'range', a, b };
  });
}

/**
 * Rewrites references after two individual cells swap contents (single-cell Alt+Arrow):
 * a reference to exactly one of the two cells follows its content to the other position.
 * Ranges are left untouched — a single cell moving across a range boundary isn't expressible
 * as a range edit.
 */
export function rewriteFormulaRefsForCellSwap(
  raw: string,
  a: { row: number; col: number },
  b: { row: number; col: number },
): string {
  if (!isFormulaValue(raw) || (a.row === b.row && a.col === b.col)) return raw;
  return rewriteFormulaRefs(raw, (unit) => {
    if (unit.type !== 'cell') return null;
    if (unit.row === a.row && unit.col === a.col) return { ...unit, row: b.row, col: b.col };
    if (unit.row === b.row && unit.col === b.col) return { ...unit, row: a.row, col: a.col };
    return null;
  });
}

/**
 * Excel-style F4: cycles the `$` anchoring of the reference token at `caret` in a formula's
 * text. Cell refs walk A1 → $A$1 → A$1 → $A1 → A1; a column-only endpoint of a range (the C in
 * C:C) just toggles $C. Returns the new text plus a caret position (end of the rewritten
 * token), or null when the caret isn't on a reference. Letter case is preserved.
 */
export function cycleRefAnchorAtCaret(
  text: string,
  caret: number,
): { text: string; caret: number } | null {
  const re = /(\$?)([A-Za-z]+)(\$?)([0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (caret < start || caret > end) continue;
    const [, dCol, letters, dRow, digits] = m;
    if (digits) {
      // Cell ref: (rel,rel) → (abs,abs) → (rel col, abs row) → (abs col, rel row) → back.
      const absCol = dCol === '$';
      const absRow = dRow === '$';
      const [nextCol, nextRow] =
        !absCol && !absRow ? [true, true] : absCol && absRow ? [false, true] : !absCol && absRow ? [true, false] : [false, false];
      const token = `${nextCol ? '$' : ''}${letters}${nextRow ? '$' : ''}${digits}`;
      return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
    }
    // Letters-only tokens are references only as half of a whole-column range (C:C) — i.e.
    // when directly adjacent to a colon. Anything else (function names, stray words) is skipped.
    const touchesColon = text[end] === ':' || text[start - 1] === ':';
    if (!touchesColon) return null;
    const token = `${dCol === '$' ? '' : '$'}${letters}`;
    return { text: text.slice(0, start) + token + text.slice(end), caret: start + token.length };
  }
  return null;
}

export class FormulaEvalError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'word'; value: string }
  | { type: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const value = Number(src.slice(i, j));
      if (Number.isNaN(value)) throw new FormulaEvalError('#ERROR!');
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      tokens.push({ type: 'word', value: src.slice(i, j).toUpperCase() });
      i = j;
      continue;
    }
    if ('+-*/^(),:'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    // Left behind by rewriteFormulaRefsForDelete when a referenced row/column was removed.
    if (ch === '#' && src.slice(i).toUpperCase().startsWith('#REF!')) {
      throw new FormulaEvalError('#REF!');
    }
    throw new FormulaEvalError('#ERROR!');
  }
  return tokens;
}

interface RefMaps {
  colIdByIndex: string[];
  rowIdByIndex: string[];
}

function buildRefMaps(doc: TableDocument): RefMaps {
  return {
    colIdByIndex: doc.columns.map((c) => c.id),
    rowIdByIndex: doc.rows.map((r) => r.id),
  };
}

interface EvalContext {
  doc: TableDocument;
  refs: RefMaps;
  visiting: Set<string>;
  /**
   * `rowId:colId` key of the cell whose formula is currently being evaluated. Whole-column
   * ranges (C:C and mixed C1:C) skip this cell so `=SUM(B:B)` can live inside column B without
   * counting itself or tripping the circular check.
   */
  current?: string;
}

/** Resolves a cell to a number, recursively evaluating nested formulas. Returns null for blank/non-numeric cells. */
function resolveCellOrNull(ctx: EvalContext, col: number, row: number): number | null {
  const colId = ctx.refs.colIdByIndex[col];
  const rowId = ctx.refs.rowIdByIndex[row];
  if (colId === undefined || rowId === undefined) throw new FormulaEvalError('#REF!');
  const key = `${rowId}:${colId}`;
  if (ctx.visiting.has(key)) throw new FormulaEvalError('#CIRCULAR!');
  const rowObj = ctx.doc.rows.find((r) => r.id === rowId);
  const raw = rowObj?.cells[colId] ?? '';
  if (!raw.trim()) return null;
  if (isFormulaValue(raw)) {
    ctx.visiting.add(key);
    const prevCurrent = ctx.current;
    ctx.current = key;
    try {
      return evaluateExpression(raw.trim().slice(1), ctx);
    } finally {
      ctx.current = prevCurrent;
      ctx.visiting.delete(key);
    }
  }
  return parseNumericValue(raw);
}

function resolveCellStrict(ctx: EvalContext, col: number, row: number): number {
  const value = resolveCellOrNull(ctx, col, row);
  if (value === null) throw new FormulaEvalError('#VALUE!');
  return value;
}

function expandRange(ctx: EvalContext, a: CellRef, b: CellRef, skipSelf = false): number[] {
  const colStart = Math.min(a.col, b.col);
  const colEnd = Math.max(a.col, b.col);
  const rowStart = Math.min(a.row, b.row);
  const rowEnd = Math.max(a.row, b.row);
  const values: number[] = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
      if (skipSelf && ctx.current !== undefined) {
        const key = `${ctx.refs.rowIdByIndex[r]}:${ctx.refs.colIdByIndex[c]}`;
        if (key === ctx.current) continue;
      }
      const v = resolveCellOrNull(ctx, c, r);
      if (v !== null) values.push(v);
    }
  }
  return values;
}

function applyFunction(name: string, values: number[]): number {
  switch (name as FunctionName) {
    case 'SUM':
      return values.reduce((a, b) => a + b, 0);
    case 'AVERAGE':
      if (values.length === 0) throw new FormulaEvalError('#DIV/0!');
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'COUNT':
      return values.length;
    case 'MIN':
      return values.length ? Math.min(...values) : 0;
    case 'MAX':
      return values.length ? Math.max(...values) : 0;
    default:
      throw new FormulaEvalError('#NAME?');
  }
}

class Parser {
  pos = 0;
  constructor(
    private tokens: Token[],
    private ctx: EvalContext,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new FormulaEvalError('#ERROR!');
    this.pos++;
    return t;
  }

  private expectOp(op: string): void {
    const t = this.next();
    if (t.type !== 'op' || t.value !== op) throw new FormulaEvalError('#ERROR!');
  }

  parseExpression(): number {
    let value = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const rhs = this.parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.next();
        const rhs = this.parseFactor();
        if (t.value === '*') value *= rhs;
        else {
          if (rhs === 0) throw new FormulaEvalError('#DIV/0!');
          value /= rhs;
        }
      } else break;
    }
    return value;
  }

  private parseFactor(): number {
    const t = this.peek();
    if (t?.type === 'op' && (t.value === '-' || t.value === '+')) {
      this.next();
      const v = this.parseFactor();
      return t.value === '-' ? -v : v;
    }
    return this.parsePower();
  }

  private parsePower(): number {
    const base = this.parsePrimary();
    const t = this.peek();
    if (t?.type === 'op' && t.value === '^') {
      this.next();
      const exp = this.parseFactor();
      return Math.pow(base, exp);
    }
    return base;
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (!t) throw new FormulaEvalError('#ERROR!');
    if (t.type === 'num') {
      this.next();
      return t.value;
    }
    if (t.type === 'op' && t.value === '(') {
      this.next();
      const v = this.parseExpression();
      this.expectOp(')');
      return v;
    }
    if (t.type === 'word') {
      this.next();
      const nextTok = this.peek();
      if (nextTok?.type === 'op' && nextTok.value === '(') {
        return this.parseFunctionCall(t.value);
      }
      const ref = parseCellRefToken(t.value);
      if (!ref) throw new FormulaEvalError('#NAME?');
      return resolveCellStrict(this.ctx, ref.col, ref.row);
    }
    throw new FormulaEvalError('#ERROR!');
  }

  private parseFunctionCall(name: string): number {
    if (!(SUPPORTED_FUNCTIONS as readonly string[]).includes(name)) throw new FormulaEvalError('#NAME?');
    this.expectOp('(');
    const values: number[] = [];
    const closed = this.peek();
    if (!(closed?.type === 'op' && closed.value === ')')) {
      values.push(...this.parseArg());
      for (;;) {
        const t = this.peek();
        if (t?.type === 'op' && t.value === ',') {
          this.next();
          values.push(...this.parseArg());
        } else break;
      }
    }
    this.expectOp(')');
    return applyFunction(name, values);
  }

  private parseArg(): number[] {
    const t = this.peek();
    if (t?.type === 'word') {
      const maybeRef = parseCellRefToken(t.value);
      const maybeCol = parseColOnlyToken(t.value);
      if (maybeRef || maybeCol !== null) {
        const savedPos = this.pos;
        this.next();
        const colon = this.peek();
        if (colon?.type === 'op' && colon.value === ':') {
          this.next();
          const endTok = this.next();
          if (endTok.type !== 'word') throw new FormulaEvalError('#ERROR!');
          const endRef = parseCellRefToken(endTok.value);
          const endCol = parseColOnlyToken(endTok.value);
          if (!endRef && endCol === null) throw new FormulaEvalError('#ERROR!');
          if (maybeRef && endRef) return expandRange(this.ctx, maybeRef, endRef);
          // Whole-column semantics (C:C, A:C, and mixed forms like C1:C): the range covers
          // every row of the involved columns — except the formula's own cell, so a total like
          // =SUM(B:B) can sit inside column B without counting itself.
          const lastRow = this.ctx.doc.rows.length - 1;
          if (lastRow < 0) return [];
          const startCol = maybeRef ? maybeRef.col : maybeCol!;
          const endColIdx = endRef ? endRef.col : endCol!;
          return expandRange(this.ctx, { col: startCol, row: 0 }, { col: endColIdx, row: lastRow }, true);
        }
        this.pos = savedPos;
      }
    }
    return [this.parseExpression()];
  }
}

function evaluateExpression(src: string, ctx: EvalContext): number {
  // `$` anchors ($B$1) only matter for fill/copy shifting — evaluation ignores them.
  const trimmed = src.replace(/\$/g, '').trim();
  if (!trimmed) throw new FormulaEvalError('#ERROR!');
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) throw new FormulaEvalError('#ERROR!');
  const parser = new Parser(tokens, ctx);
  const value = parser.parseExpression();
  if (parser.pos !== tokens.length) throw new FormulaEvalError('#ERROR!');
  if (!Number.isFinite(value)) throw new FormulaEvalError('#NUM!');
  return value;
}

export function formatFormulaNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  const rounded = Math.round(n * 1e6) / 1e6;
  return String(rounded);
}

export interface FormulaResult {
  value: number | null;
  display: string;
  error?: string;
}

/** Evaluates the formula stored in a given cell (raw value must start with '='). */
export function evaluateCellFormula(doc: TableDocument, rowId: string, colId: string): FormulaResult {
  const refs = buildRefMaps(doc);
  const self = `${rowId}:${colId}`;
  const ctx: EvalContext = { doc, refs, visiting: new Set([self]), current: self };
  const rowObj = doc.rows.find((r) => r.id === rowId);
  const raw = rowObj?.cells[colId] ?? '';
  try {
    const value = evaluateExpression(raw.trim().slice(FORMULA_PREFIX.length), ctx);
    return { value, display: formatFormulaNumber(value) };
  } catch (err) {
    const code = err instanceof FormulaEvalError ? err.code : '#ERROR!';
    return { value: null, display: code, error: code };
  }
}

/** Resolves what should be displayed for a cell: computed formula result, or the raw value as-is. */
export function cellDisplayValue(doc: TableDocument, rowId: string, colId: string): string {
  const rowObj = doc.rows.find((r) => r.id === rowId);
  const raw = rowObj?.cells[colId] ?? '';
  if (!isFormulaValue(raw)) return raw;
  return evaluateCellFormula(doc, rowId, colId).display;
}

export interface RangeStats {
  count: number;
  sum: number;
  average: number | null;
}

/**
 * Aggregates cells for the selection stats bar. `count` counts every non-empty cell (text or
 * number alike, Excel COUNTA-style); `sum`/`average` only consider numeric values (formula
 * results included).
 */
export function computeRangeStats(
  doc: TableDocument,
  cells: Array<{ rowId: string; colId: string }>,
): RangeStats {
  const refs = buildRefMaps(doc);
  const rowById = new Map(doc.rows.map((r) => [r.id, r]));
  let sum = 0;
  let count = 0;
  let numericCount = 0;
  for (const { rowId, colId } of cells) {
    const raw = rowById.get(rowId)?.cells[colId] ?? '';
    if (raw.trim()) count++;
    const rowIdx = refs.rowIdByIndex.indexOf(rowId);
    const colIdx = refs.colIdByIndex.indexOf(colId);
    if (rowIdx < 0 || colIdx < 0) continue;
    const ctx: EvalContext = { doc, refs, visiting: new Set() };
    let value: number | null;
    try {
      value = resolveCellOrNull(ctx, colIdx, rowIdx);
    } catch {
      value = null;
    }
    if (value !== null) {
      sum += value;
      numericCount++;
    }
  }
  return { count, sum, average: numericCount > 0 ? sum / numericCount : null };
}
