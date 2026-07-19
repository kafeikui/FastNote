import MiniSearch from 'minisearch';
import type { NoteNode } from '@fastnote/shared';

export interface SearchResult {
  id: string;
  title: string;
  score: number;
  snippet: string;
}

export function stripMarkdownForSearch(text: string): string {
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, ' $1 ')
    .replace(/`([^`\n]+)`/g, ' $1 ')
    .replace(/\[📎[^\]]*\]\(fnattach:[^)]+\)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*|__|\*|_|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSearchableNode(note: NoteNode): boolean {
  return (note.nodeType === 'note' || note.nodeType === 'table') && !note.deleted;
}

/** Tokenize mixed Chinese / English text for MiniSearch. */
export function tokenizeForSearch(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const tokens: string[] = [];
  const re = /[\u4e00-\u9fff]+|[a-z0-9_]+(?:[.-][a-z0-9_]+)*/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const seg = match[0];
    if (/^[\u4e00-\u9fff]+$/u.test(seg)) {
      for (let i = 0; i < seg.length; i++) {
        tokens.push(seg[i]!);
        if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
      }
    } else {
      tokens.push(seg);
    }
  }
  return tokens;
}

function makeSnippet(content: string, query: string, maxLen = 96): string {
  const plain = content.replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  // Prefer a snippet around the full exact query; fall back to individual tokens.
  const full = query.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  const tokens = full ? [full, ...tokenizeForSearch(query)] : tokenizeForSearch(query);
  for (const token of tokens) {
    const idx = plain.toLowerCase().indexOf(token);
    if (idx >= 0) {
      const start = Math.max(0, idx - 24);
      const end = Math.min(plain.length, idx + token.length + 48);
      let snippet = plain.slice(start, end).trim();
      if (start > 0) snippet = `…${snippet}`;
      if (end < plain.length) snippet = `${snippet}…`;
      return snippet.slice(0, maxLen);
    }
  }
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}…` : plain;
}

const MINI_SEARCH_OPTIONS = {
  fields: ['title', 'content'] as ('title' | 'content')[],
  storeFields: ['title', 'content'] as ('title' | 'content')[],
  tokenize: tokenizeForSearch,
  // AND + no fuzziness: every query token must match. The final exact-substring filter in
  // `search()` is what actually guarantees "results contain the query verbatim" — these options
  // just keep the candidate set tight.
  searchOptions: {
    boost: { title: 1.5, content: 1 },
    prefix: true,
    fuzzy: false as const,
    combineWith: 'AND' as const,
  },
};

export class NoteSearchIndex {
  private index: MiniSearch<{ id: string; title: string; content: string }>;

  constructor() {
    this.index = new MiniSearch(MINI_SEARCH_OPTIONS);
  }

  private toDoc(note: NoteNode): { id: string; title: string; content: string } {
    const content = stripMarkdownForSearch(note.contentMd);
    return { id: note.id, title: note.title, content };
  }

  rebuild(notes: NoteNode[]): void {
    this.index.removeAll();
    const docs = notes.filter(isSearchableNode).map((n) => this.toDoc(n));
    if (docs.length) this.index.addAll(docs);
  }

  upsert(note: NoteNode): void {
    if (!isSearchableNode(note)) {
      if (this.index.has(note.id)) this.index.discard(note.id);
      return;
    }
    const doc = this.toDoc(note);
    if (this.index.has(note.id)) {
      this.index.replace(doc);
    } else {
      this.index.add(doc);
    }
  }

  remove(id: string): void {
    if (this.index.has(id)) this.index.discard(id);
  }

  search(query: string, limit = 20): SearchResult[] {
    const q = query.trim();
    if (!q) return [];
    // Exact matching: the query must appear verbatim (case-insensitive) in the title or body.
    // MiniSearch only produces ranked candidates; whitespace in the query is normalized because
    // the indexed body already collapsed runs of whitespace.
    const needle = q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
    const containsExact = (text: string) =>
      text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').includes(needle);
    return this.index
      .search(q, MINI_SEARCH_OPTIONS.searchOptions)
      .filter((r) => containsExact((r.title as string) ?? '') || containsExact((r.content as string) ?? ''))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: (r.title as string) ?? '',
        score: r.score,
        snippet: makeSnippet((r.content as string) ?? '', q),
      }));
  }

  serialize(): string {
    return JSON.stringify(this.index.toJSON());
  }

  static fromSerialized(json: string): NoteSearchIndex {
    const inst = new NoteSearchIndex();
    inst.index = MiniSearch.loadJSON(json, MINI_SEARCH_OPTIONS);
    return inst;
  }

  /**
   * Chunked, non-blocking variant of `fromSerialized`. The snapshot of a large vault is tens of
   * MB (storeFields keeps the full note bodies), and the synchronous loader freezes the main
   * thread for the whole parse+rebuild.
   */
  static async fromSerializedAsync(json: string): Promise<NoteSearchIndex> {
    const inst = new NoteSearchIndex();
    inst.index = await MiniSearch.loadJSONAsync(json, MINI_SEARCH_OPTIONS);
    return inst;
  }

  /** Chunked, non-blocking full build (async counterpart of `rebuild` on a fresh instance). */
  static async buildAsync(notes: NoteNode[]): Promise<NoteSearchIndex> {
    const inst = new NoteSearchIndex();
    const docs = notes.filter(isSearchableNode).map((n) => inst.toDoc(n));
    if (docs.length) await inst.index.addAllAsync(docs);
    return inst;
  }
}
