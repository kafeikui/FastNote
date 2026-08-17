import type { TableCellStyle, TableColumn, TableColumnFormat, TableDocument, TableRow } from '@fastnote/shared';
import { TABLE_FILE_MAGIC, TABLE_FILE_VERSION, expandAttachmentRefsForExport } from '@fastnote/shared';
import {
  decryptString,
  encryptString,
  packEncrypted,
  unpackEncrypted,
  type EncryptedPayload,
} from '@fastnote/crypto';
import { translate, type Locale } from '@fastnote/i18n';
import {
  cellDisplayValue,
  isFormulaValue,
  rewriteFormulaRefsForCellSwap,
  rewriteFormulaRefsForDelete,
  rewriteFormulaRefsForInsert,
  rewriteFormulaRefsForSwap,
} from './formula';

/** Applies a formula-reference rewriter to every formula cell of the document. */
function rewriteDocFormulas(doc: TableDocument, rewriteOne: (raw: string) => string): TableDocument {
  let anyChanged = false;
  const rows = doc.rows.map((r) => {
    let changed = false;
    const cells = { ...r.cells };
    for (const key of Object.keys(cells)) {
      const v = cells[key];
      if (v && isFormulaValue(v)) {
        const nv = rewriteOne(v);
        if (nv !== v) {
          cells[key] = nv;
          changed = true;
        }
      }
    }
    if (!changed) return r;
    anyChanged = true;
    return { ...r, cells };
  });
  return anyChanged ? { ...doc, rows } : doc;
}

/** Shifts formula references in every cell after a row/column insertion at `insertIndex`. */
function rewriteDocFormulasForInsert(
  doc: TableDocument,
  kind: 'row' | 'col',
  insertIndex: number,
): TableDocument {
  return rewriteDocFormulas(doc, (raw) => rewriteFormulaRefsForInsert(raw, kind, insertIndex));
}

/** Adjusts formula references in every cell after deleting the row/column at `deleteIndex`. */
function rewriteDocFormulasForDelete(
  doc: TableDocument,
  kind: 'row' | 'col',
  deleteIndex: number,
): TableDocument {
  return rewriteDocFormulas(doc, (raw) => rewriteFormulaRefsForDelete(raw, kind, deleteIndex));
}

export function createEmptyTable(locale: Locale = 'zh'): TableDocument {
  const colA: TableColumn = { id: crypto.randomUUID(), name: translate(locale, 'tableUtils.defaultColumnA') };
  const colB: TableColumn = { id: crypto.randomUUID(), name: translate(locale, 'tableUtils.defaultColumnB') };
  return {
    version: 1,
    columns: [colA, colB],
    rows: [
      { id: crypto.randomUUID(), cells: { [colA.id]: '', [colB.id]: '' } },
      { id: crypto.randomUUID(), cells: { [colA.id]: '', [colB.id]: '' } },
    ],
  };
}

export function parseTableDocument(raw: string, locale: Locale = 'zh'): TableDocument {
  if (!raw.trim()) return createEmptyTable(locale);
  try {
    const doc = JSON.parse(raw) as TableDocument;
    if (doc.version === 1 && Array.isArray(doc.columns) && Array.isArray(doc.rows)) {
      return doc;
    }
  } catch {
    /* fall through */
  }
  return createEmptyTable(locale);
}

export function serializeTable(doc: TableDocument): string {
  return JSON.stringify(doc);
}

export function tableToSearchText(doc: TableDocument): string {
  const parts: string[] = [];
  for (const col of doc.columns) parts.push(col.name);
  for (const row of doc.rows) {
    for (const col of doc.columns) parts.push(row.cells[col.id] ?? '');
  }
  return parts.join(' ');
}

type SortDir = 'asc' | 'desc' | null;

/**
 * Sorts/filters compare the *computed* value of formula cells (via `cellDisplayValue`)
 * rather than the raw `=...` string, so a column of formulas sorts/filters numerically
 * like any other column. `doc` must be the full (unfiltered/unsorted) document so cross-row
 * formula references resolve correctly regardless of the current view.
 */
export function sortRows(
  doc: TableDocument,
  rows: TableRow[],
  columnId: string | null,
  direction: SortDir,
): TableRow[] {
  if (!columnId || !direction) return rows;
  return [...rows].sort((a, b) => {
    const av = cellDisplayValue(doc, a.id, columnId);
    const bv = cellDisplayValue(doc, b.id, columnId);
    const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? cmp : -cmp;
  });
}

export function filterRows(
  doc: TableDocument,
  rows: TableRow[],
  filters: Record<string, string>,
): TableRow[] {
  const active = Object.entries(filters).filter(([, v]) => v.trim());
  if (active.length === 0) return rows;
  return rows.filter((row) =>
    active.every(([colId, q]) => cellDisplayValue(doc, row.id, colId).toLowerCase().includes(q.toLowerCase())),
  );
}

function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

export function importTableCsv(text: string, locale: Locale = 'zh'): TableDocument {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error(translate(locale, 'tableUtils.csvEmpty'));

  let headerIdx = 0;
  if (lines.length >= 2) {
    const first = parseCsvRow(lines[0]);
    const second = parseCsvRow(lines[1]);
    if (first.length === 1 && second.length > 1) {
      headerIdx = 1;
    }
  }

  const headers = parseCsvRow(lines[headerIdx]);
  if (headers.length === 0) throw new Error(translate(locale, 'tableUtils.csvNoHeader'));

  const columns: TableColumn[] = headers.map((name, i) => ({
    id: crypto.randomUUID(),
    name: name.trim() || translate(locale, 'tableUtils.defaultColumnN', { index: i + 1 }),
  }));

  const dataLines = lines.slice(headerIdx + 1);
  const rows: TableRow[] =
    dataLines.length > 0
      ? dataLines.map((line) => {
          const values = parseCsvRow(line);
          const cells: Record<string, string> = {};
          columns.forEach((col, i) => {
            cells[col.id] = values[i] ?? '';
          });
          return { id: crypto.randomUUID(), cells };
        })
      : [{ id: crypto.randomUUID(), cells: Object.fromEntries(columns.map((c) => [c.id, ''])) }];

  return { version: 1, columns, rows };
}

export async function importCsvFile(file: File, locale: Locale = 'zh'): Promise<TableDocument> {
  const text = await file.text();
  return importTableCsv(text, locale);
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function exportTableCsv(
  title: string,
  doc: TableDocument,
  resolveAttachment?: (id: string) => { description: string; fileName: string } | undefined,
): string {
  const header = doc.columns.map((c) => escapeCsv(c.name)).join(',');
  const lines = doc.rows.map((row) =>
    doc.columns
      .map((c) => {
        const raw = row.cells[c.id] ?? '';
        const exported = resolveAttachment ? expandAttachmentRefsForExport(raw, resolveAttachment) : raw;
        return escapeCsv(exported);
      })
      .join(','),
  );
  return `\uFEFF${escapeCsv(title)}\n${header}\n${lines.join('\n')}`;
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadBinaryFile(filename: string, bytes: Uint8Array, mime: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface EncryptedTableFile {
  format: 'fastnote-table-v1';
  title: string;
  exported_at: string;
  payload: string;
}

export function exportEncryptedTableFile(
  title: string,
  doc: TableDocument,
  notesKey: Uint8Array,
): EncryptedTableFile {
  const enc = encryptString(notesKey, serializeTable(doc));
  return {
    format: 'fastnote-table-v1',
    title,
    exported_at: new Date().toISOString(),
    payload: packEncrypted(enc),
  };
}

export function buildFnxtBytes(file: EncryptedTableFile): Uint8Array {
  const json = JSON.stringify(file);
  const body = new TextEncoder().encode(json);
  const magic = new TextEncoder().encode(TABLE_FILE_MAGIC);
  const out = new Uint8Array(magic.length + 1 + body.length);
  out.set(magic, 0);
  out[magic.length] = TABLE_FILE_VERSION;
  out.set(body, magic.length + 1);
  return out;
}

export function importEncryptedTableFile(
  file: EncryptedTableFile,
  notesKey: Uint8Array,
  locale: Locale = 'zh',
): TableDocument {
  if (file.format !== 'fastnote-table-v1') throw new Error(translate(locale, 'tableUtils.unsupportedTableFormat'));
  const plain = decryptString(notesKey, unpackEncrypted(file.payload));
  return parseTableDocument(plain, locale);
}

export async function importFnxtFile(
  file: File,
  notesKey: Uint8Array,
  locale: Locale = 'zh',
): Promise<{ title: string; doc: TableDocument }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const magic = new TextDecoder().decode(buf.slice(0, 4));
  if (magic !== TABLE_FILE_MAGIC) throw new Error(translate(locale, 'tableUtils.invalidFnxtFile'));
  const json = new TextDecoder().decode(buf.slice(5));
  const parsed = JSON.parse(json) as EncryptedTableFile;
  return { title: parsed.title, doc: importEncryptedTableFile(parsed, notesKey, locale) };
}

/** Appends a column, or inserts it at `index` (before the column currently there) when given. */
export function addColumn(doc: TableDocument, locale: Locale = 'zh', index?: number): TableDocument {
  const col: TableColumn = {
    id: crypto.randomUUID(),
    name: translate(locale, 'tableUtils.defaultColumnN', { index: doc.columns.length + 1 }),
  };
  const columns = [...doc.columns];
  const at = index === undefined ? columns.length : Math.max(0, Math.min(index, columns.length));
  columns.splice(at, 0, col);
  const next = {
    ...doc,
    columns,
    rows: doc.rows.map((r) => ({ ...r, cells: { ...r.cells, [col.id]: '' } })),
  };
  // References to columns at/after the insertion point shift one letter to the right.
  return rewriteDocFormulasForInsert(next, 'col', at);
}

/** Appends a row, or inserts it at `index` (before the row currently there) when given. */
export function addRow(doc: TableDocument, index?: number): TableDocument {
  const cells: Record<string, string> = {};
  for (const c of doc.columns) cells[c.id] = '';
  const rows = [...doc.rows];
  const at = index === undefined ? rows.length : Math.max(0, Math.min(index, rows.length));
  rows.splice(at, 0, { id: crypto.randomUUID(), cells });
  // References to rows at/after the insertion point shift one row down.
  return rewriteDocFormulasForInsert({ ...doc, rows }, 'row', at);
}

export function removeColumn(doc: TableDocument, columnId: string): TableDocument {
  if (doc.columns.length <= 1) return doc;
  const removedIndex = doc.columns.findIndex((c) => c.id === columnId);
  if (removedIndex < 0) return doc;
  const next: TableDocument = {
    ...doc,
    columns: doc.columns.filter((c) => c.id !== columnId),
    rows: doc.rows.map((r) => {
      const cells = { ...r.cells };
      delete cells[columnId];
      const nextRow: TableRow = { ...r, cells };
      if (r.styles && columnId in r.styles) {
        const styles = { ...r.styles };
        delete styles[columnId];
        if (Object.keys(styles).length === 0) delete nextRow.styles;
        else nextRow.styles = styles;
      }
      return nextRow;
    }),
  };
  return rewriteDocFormulasForDelete(next, 'col', removedIndex);
}

export function removeRow(doc: TableDocument, rowId: string): TableDocument {
  if (doc.rows.length <= 1) return doc;
  const removedIndex = doc.rows.findIndex((r) => r.id === rowId);
  if (removedIndex < 0) return doc;
  const next = { ...doc, rows: doc.rows.filter((r) => r.id !== rowId) };
  return rewriteDocFormulasForDelete(next, 'row', removedIndex);
}

export function updateCell(
  doc: TableDocument,
  rowId: string,
  columnId: string,
  value: string,
): TableDocument {
  return {
    ...doc,
    rows: doc.rows.map((r) =>
      r.id === rowId ? { ...r, cells: { ...r.cells, [columnId]: value } } : r,
    ),
  };
}

export function renameColumn(doc: TableDocument, columnId: string, name: string): TableDocument {
  return {
    ...doc,
    columns: doc.columns.map((c) => (c.id === columnId ? { ...c, name } : c)),
  };
}

/** Merges a patch into a style object; `undefined` values delete keys, empty result → undefined. */
function mergeStylePatch(
  base: TableCellStyle | undefined,
  patch: Partial<TableCellStyle>,
): TableCellStyle | undefined {
  const merged: TableCellStyle = { ...(base ?? {}) };
  for (const key of Object.keys(patch) as Array<keyof TableCellStyle>) {
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else (merged as Record<string, unknown>)[key] = value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merges a style patch into the header name cell of every listed column. Keys explicitly set to
 * `undefined` are removed (back to default); a header style that ends up empty drops entirely.
 */
export function setHeaderStyle(
  doc: TableDocument,
  columnIds: string[],
  patch: Partial<TableCellStyle>,
): TableDocument {
  if (columnIds.length === 0) return doc;
  const idSet = new Set(columnIds);
  return {
    ...doc,
    columns: doc.columns.map((c) => {
      if (!idSet.has(c.id)) return c;
      const merged: TableCellStyle = { ...(c.headerStyle ?? {}) };
      for (const key of Object.keys(patch) as Array<keyof TableCellStyle>) {
        const value = patch[key];
        if (value === undefined) delete merged[key];
        else (merged as Record<string, unknown>)[key] = value;
      }
      if (Object.keys(merged).length === 0) {
        const { headerStyle: _drop, ...rest } = c;
        return rest;
      }
      return { ...c, headerStyle: merged };
    }),
  };
}

/**
 * Excel-style "use first row as header": renames every column to the first row's cell content
 * (columns whose cell is empty keep their name), carries the row's cell alignment over to the
 * header style, and removes that row from the data. If it was the only row, an empty one is
 * added so the table never ends up rowless. Formula references shift up one row (same as
 * deleting the top row; references to the promoted row become #REF!).
 */
export function promoteFirstRowToHeader(doc: TableDocument): TableDocument {
  const first = doc.rows[0];
  if (!first) return doc;
  const columns = doc.columns.map((c) => {
    const v = (first.cells[c.id] ?? '').trim();
    const cellStyle = first.styles?.[c.id];
    const headerStyle = mergeStylePatch(c.headerStyle, {
      ...(cellStyle?.align ? { align: cellStyle.align } : {}),
      ...(cellStyle?.valign ? { valign: cellStyle.valign } : {}),
    });
    const next = { ...c };
    if (v) next.name = v;
    if (headerStyle) next.headerStyle = headerStyle;
    return next;
  });
  let rows = doc.rows.slice(1);
  if (rows.length === 0) {
    const cells: Record<string, string> = {};
    for (const c of columns) cells[c.id] = '';
    rows = [{ id: crypto.randomUUID(), cells }];
  }
  return rewriteDocFormulasForDelete({ ...doc, columns, rows }, 'row', 0);
}

/**
 * Inverse of `promoteFirstRowToHeader`: inserts the column names as a new first data row (header
 * alignment becomes the new cells' style), blanks the header names, and shifts formula
 * references down one row (same as inserting a row at the top).
 */
export function demoteHeaderToFirstRow(doc: TableDocument): TableDocument {
  const cells: Record<string, string> = {};
  const styles: Record<string, TableCellStyle> = {};
  for (const c of doc.columns) {
    cells[c.id] = c.name;
    if (c.headerStyle && Object.keys(c.headerStyle).length > 0) styles[c.id] = { ...c.headerStyle };
  }
  const row: TableRow = {
    id: crypto.randomUUID(),
    cells,
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
  };
  const columns = doc.columns.map((c) => {
    const { headerStyle: _drop, ...rest } = c;
    return { ...rest, name: '' };
  });
  return rewriteDocFormulasForInsert({ ...doc, columns, rows: [row, ...doc.rows] }, 'row', 0);
}

/** Swaps the positions of two columns (by id); references follow the moved content. */
export function swapColumns(doc: TableDocument, colIdA: string, colIdB: string): TableDocument {
  const a = doc.columns.findIndex((c) => c.id === colIdA);
  const b = doc.columns.findIndex((c) => c.id === colIdB);
  if (a === -1 || b === -1 || a === b) return doc;
  const columns = [...doc.columns];
  [columns[a], columns[b]] = [columns[b], columns[a]];
  return rewriteDocFormulas({ ...doc, columns }, (raw) =>
    rewriteFormulaRefsForSwap(raw, 'col', a, b),
  );
}

/** Swaps the positions of two rows (by id); references follow the moved content. */
export function swapRows(doc: TableDocument, rowIdA: string, rowIdB: string): TableDocument {
  const a = doc.rows.findIndex((r) => r.id === rowIdA);
  const b = doc.rows.findIndex((r) => r.id === rowIdB);
  if (a === -1 || b === -1 || a === b) return doc;
  const rows = [...doc.rows];
  [rows[a], rows[b]] = [rows[b], rows[a]];
  return rewriteDocFormulas({ ...doc, rows }, (raw) => rewriteFormulaRefsForSwap(raw, 'row', a, b));
}

/** Swaps two cells' content and per-cell style (the cells may live in different rows/columns). */
export function swapCells(
  doc: TableDocument,
  a: { rowId: string; colId: string },
  b: { rowId: string; colId: string },
): TableDocument {
  const rowA = doc.rows.find((r) => r.id === a.rowId);
  const rowB = doc.rows.find((r) => r.id === b.rowId);
  if (!rowA || !rowB) return doc;
  const valueA = rowA.cells[a.colId] ?? '';
  const valueB = rowB.cells[b.colId] ?? '';
  const styleA = rowA.styles?.[a.colId];
  const styleB = rowB.styles?.[b.colId];
  const applyToRow = (row: TableRow): TableRow => {
    let next = row;
    const patch = (colId: string, value: string, style: TableCellStyle | undefined) => {
      const styles = { ...(next.styles ?? {}) };
      if (style) styles[colId] = style;
      else delete styles[colId];
      next = {
        ...next,
        cells: { ...next.cells, [colId]: value },
        ...(Object.keys(styles).length > 0 ? { styles } : {}),
      };
      if (Object.keys(styles).length === 0) delete next.styles;
    };
    if (row.id === a.rowId) patch(a.colId, valueB, styleB);
    if (row.id === b.rowId) patch(b.colId, valueA, styleA);
    return next;
  };
  const swapped = {
    ...doc,
    rows: doc.rows.map((r) => (r.id === a.rowId || r.id === b.rowId ? applyToRow(r) : r)),
  };
  // References to exactly one of the two cells follow their content to the other position.
  const posA = {
    row: doc.rows.findIndex((r) => r.id === a.rowId),
    col: doc.columns.findIndex((c) => c.id === a.colId),
  };
  const posB = {
    row: doc.rows.findIndex((r) => r.id === b.rowId),
    col: doc.columns.findIndex((c) => c.id === b.colId),
  };
  if (posA.col === -1 || posB.col === -1) return swapped;
  return rewriteDocFormulas(swapped, (raw) => rewriteFormulaRefsForCellSwap(raw, posA, posB));
}

export const MIN_COL_WIDTH = 48;
export const MAX_COL_WIDTH = 1200;
// Just enough to keep the row number and the resize handle visible/clickable.
export const MIN_ROW_HEIGHT = 12;
export const MAX_ROW_HEIGHT = 600;

/** Sets (or clears with undefined) a column's numeric display format. */
export function setColumnFormat(
  doc: TableDocument,
  columnId: string,
  format: TableColumnFormat | undefined,
): TableDocument {
  return {
    ...doc,
    columns: doc.columns.map((c) => {
      if (c.id !== columnId) return c;
      if (!format) {
        const { format: _omit, ...rest } = c;
        return rest;
      }
      return { ...c, format };
    }),
  };
}

export function setColumnWidth(doc: TableDocument, columnId: string, width: number): TableDocument {
  const clamped = Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, width)));
  return {
    ...doc,
    columns: doc.columns.map((c) => (c.id === columnId ? { ...c, width: clamped } : c)),
  };
}

export function setRowHeight(doc: TableDocument, rowId: string, height: number): TableDocument {
  const clamped = Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height)));
  return {
    ...doc,
    rows: doc.rows.map((r) => (r.id === rowId ? { ...r, height: clamped } : r)),
  };
}

/** Sets one height on the listed rows only (or clears their explicit heights with undefined). */
export function setRowHeights(
  doc: TableDocument,
  rowIds: string[],
  height: number | undefined,
): TableDocument {
  const ids = new Set(rowIds);
  if (height === undefined) {
    return {
      ...doc,
      rows: doc.rows.map((r) => {
        if (!ids.has(r.id) || r.height === undefined) return r;
        const { height: _drop, ...rest } = r;
        return rest;
      }),
    };
  }
  const clamped = Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height)));
  return {
    ...doc,
    rows: doc.rows.map((r) => (ids.has(r.id) ? { ...r, height: clamped } : r)),
  };
}

/** Sets every row to the same height, or clears all explicit heights (auto) with undefined. */
export function setAllRowHeights(doc: TableDocument, height: number | undefined): TableDocument {
  if (height === undefined) {
    return {
      ...doc,
      rows: doc.rows.map((r) => {
        if (r.height === undefined) return r;
        const { height: _drop, ...rest } = r;
        return rest;
      }),
    };
  }
  const clamped = Math.round(Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, height)));
  return { ...doc, rows: doc.rows.map((r) => ({ ...r, height: clamped })) };
}

/**
 * Merges a style patch into every listed cell. Keys explicitly set to `undefined` in the patch
 * are removed (back to default); cells whose style ends up empty drop the entry entirely.
 */
export function applyCellStyle(
  doc: TableDocument,
  cells: Array<{ rowId: string; colId: string }>,
  patch: Partial<TableCellStyle>,
): TableDocument {
  if (cells.length === 0) return doc;
  const byRow = new Map<string, string[]>();
  for (const c of cells) {
    const list = byRow.get(c.rowId) ?? [];
    list.push(c.colId);
    byRow.set(c.rowId, list);
  }
  return {
    ...doc,
    rows: doc.rows.map((row) => {
      const colIds = byRow.get(row.id);
      if (!colIds) return row;
      const styles = { ...(row.styles ?? {}) };
      for (const colId of colIds) {
        const merged: TableCellStyle = { ...(styles[colId] ?? {}) };
        for (const key of Object.keys(patch) as Array<keyof TableCellStyle>) {
          const value = patch[key];
          if (value === undefined) delete merged[key];
          else (merged as Record<string, unknown>)[key] = value;
        }
        if (Object.keys(merged).length === 0) delete styles[colId];
        else styles[colId] = merged;
      }
      if (Object.keys(styles).length === 0) {
        const { styles: _drop, ...rest } = row;
        return rest;
      }
      return { ...row, styles };
    }),
  };
}

/**
 * Whole-column styling: merges the patch into each column's default cell style and removes the
 * patched keys from every per-cell override in those columns, so the new default is what every
 * cell (including rows added later) actually shows.
 */
export function applyColumnCellStyle(
  doc: TableDocument,
  columnIds: string[],
  patch: Partial<TableCellStyle>,
): TableDocument {
  if (columnIds.length === 0) return doc;
  const idSet = new Set(columnIds);
  const clearPatch = Object.fromEntries(
    Object.keys(patch).map((k) => [k, undefined]),
  ) as Partial<TableCellStyle>;
  const cells: Array<{ rowId: string; colId: string }> = [];
  for (const row of doc.rows) for (const colId of columnIds) cells.push({ rowId: row.id, colId });
  const next = applyCellStyle(doc, cells, clearPatch);
  return {
    ...next,
    columns: next.columns.map((c) => {
      if (!idSet.has(c.id)) return c;
      const cellStyle = mergeStylePatch(c.cellStyle, patch);
      if (!cellStyle) {
        const { cellStyle: _drop, ...rest } = c;
        return rest;
      }
      return { ...c, cellStyle };
    }),
  };
}

/**
 * Whole-row styling: merges the patch into each row's default cell style and removes the patched
 * keys from that row's per-cell overrides. Row defaults beat column defaults when both are set.
 */
export function applyRowCellStyle(
  doc: TableDocument,
  rowIds: string[],
  patch: Partial<TableCellStyle>,
): TableDocument {
  if (rowIds.length === 0) return doc;
  const idSet = new Set(rowIds);
  const clearPatch = Object.fromEntries(
    Object.keys(patch).map((k) => [k, undefined]),
  ) as Partial<TableCellStyle>;
  const cells: Array<{ rowId: string; colId: string }> = [];
  for (const rowId of rowIds) for (const col of doc.columns) cells.push({ rowId, colId: col.id });
  const next = applyCellStyle(doc, cells, clearPatch);
  return {
    ...next,
    rows: next.rows.map((r) => {
      if (!idSet.has(r.id)) return r;
      const style = mergeStylePatch(r.style, patch);
      if (!style) {
        const { style: _drop, ...rest } = r;
        return rest;
      }
      return { ...r, style };
    }),
  };
}
