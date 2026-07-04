import type { TableDocument } from '@fastnote/shared';

export const FORMULA_PREFIX = '=';

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

function letterToColumnIndex(letters: string): number {
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
    try {
      return evaluateExpression(raw.trim().slice(1), ctx);
    } finally {
      ctx.visiting.delete(key);
    }
  }
  const num = Number(raw);
  return Number.isNaN(num) ? null : num;
}

function resolveCellStrict(ctx: EvalContext, col: number, row: number): number {
  const value = resolveCellOrNull(ctx, col, row);
  if (value === null) throw new FormulaEvalError('#VALUE!');
  return value;
}

function expandRange(ctx: EvalContext, a: CellRef, b: CellRef): number[] {
  const colStart = Math.min(a.col, b.col);
  const colEnd = Math.max(a.col, b.col);
  const rowStart = Math.min(a.row, b.row);
  const rowEnd = Math.max(a.row, b.row);
  const values: number[] = [];
  for (let r = rowStart; r <= rowEnd; r++) {
    for (let c = colStart; c <= colEnd; c++) {
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
      if (maybeRef) {
        const savedPos = this.pos;
        this.next();
        const colon = this.peek();
        if (colon?.type === 'op' && colon.value === ':') {
          this.next();
          const endTok = this.next();
          if (endTok.type !== 'word') throw new FormulaEvalError('#ERROR!');
          const endRef = parseCellRefToken(endTok.value);
          if (!endRef) throw new FormulaEvalError('#ERROR!');
          return expandRange(this.ctx, maybeRef, endRef);
        }
        this.pos = savedPos;
      }
    }
    return [this.parseExpression()];
  }
}

function evaluateExpression(src: string, ctx: EvalContext): number {
  const trimmed = src.trim();
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
  const ctx: EvalContext = { doc, refs, visiting: new Set([`${rowId}:${colId}`]) };
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

/** Aggregates numeric values (formula results included) across an arbitrary set of cells for the selection stats bar. */
export function computeRangeStats(
  doc: TableDocument,
  cells: Array<{ rowId: string; colId: string }>,
): RangeStats {
  const refs = buildRefMaps(doc);
  let sum = 0;
  let count = 0;
  for (const { rowId, colId } of cells) {
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
      count++;
    }
  }
  return { count, sum, average: count > 0 ? sum / count : null };
}
