import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface FindMatch {
  from: number;
  to: number;
}

/**
 * One searchable character of the flattened document. `pos` is the ProseMirror position of the
 * character, or -1 for virtual newlines inserted at block boundaries (which have no single
 * character position of their own).
 */
interface FlatChar {
  ch: string;
  pos: number;
}

/**
 * Flattens the document into a character stream: text node characters keep their PM positions,
 * hard breaks become '\n', and boundaries between textblocks (paragraph ends, list items, …)
 * become virtual '\n' characters. This lets a query with newlines match across paragraphs, and
 * lets any query match across mark boundaries (e.g. a half-bold word).
 */
function flattenDoc(doc: PMNode): FlatChar[] {
  const chars: FlatChar[] = [];
  let seenTextblock = false;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (seenTextblock) chars.push({ ch: '\n', pos: -1 });
      seenTextblock = true;
      return true;
    }
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) chars.push({ ch: node.text[i], pos: pos + i });
      return true;
    }
    if (node.isInline && node.isLeaf) {
      // Hard breaks are searchable newlines; other inline atoms (math, …) are opaque — use a
      // NUL placeholder no query can contain, so matches never span them.
      chars.push({ ch: node.type.name === 'hardBreak' ? '\n' : '\u0000', pos });
    }
    return true;
  });
  return chars;
}

/** Case-insensitive text search over the flattened document (see flattenDoc). */
export function findMatchesInDoc(doc: PMNode, query: string): FindMatch[] {
  const matches: FindMatch[] = [];
  if (!query) return matches;
  const chars = flattenDoc(doc);
  const haystack = chars.map((c) => c.ch).join('').toLowerCase();
  const q = query.toLowerCase();
  let idx = haystack.indexOf(q);
  while (idx !== -1) {
    // Anchor the PM range on the first/last real characters; a match consisting solely of
    // virtual newlines has no anchor and is skipped.
    let first = -1;
    let last = -1;
    for (let i = idx; i < idx + q.length; i++) {
      if (chars[i].pos >= 0) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first !== -1) {
      matches.push({ from: chars[first].pos, to: chars[last].pos + 1 });
    }
    idx = haystack.indexOf(q, idx + q.length);
  }
  return matches;
}

interface FindPluginState {
  query: string;
  matches: FindMatch[];
  activeIndex: number;
  decorations: DecorationSet;
}

interface FindMeta {
  query: string;
  activeIndex: number;
}

export const findReplacePluginKey = new PluginKey<FindPluginState>('fnFindReplace');

function buildState(doc: PMNode, query: string, requestedIndex: number): FindPluginState {
  const matches = findMatchesInDoc(doc, query);
  const activeIndex = matches.length === 0 ? 0 : Math.min(Math.max(requestedIndex, 0), matches.length - 1);
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === activeIndex ? 'fn-find-match fn-find-match--active' : 'fn-find-match',
      }),
    ),
  );
  return { query, matches, activeIndex, decorations };
}

const EMPTY_STATE: FindPluginState = {
  query: '',
  matches: [],
  activeIndex: 0,
  decorations: DecorationSet.empty,
};

/** Highlights matches of the active find query and tracks the currently selected one. */
export const FindReplace = Extension.create({
  name: 'fnFindReplace',

  addProseMirrorPlugins() {
    return [
      new Plugin<FindPluginState>({
        key: findReplacePluginKey,
        state: {
          init: () => EMPTY_STATE,
          apply(tr, prev) {
            const meta = tr.getMeta(findReplacePluginKey) as FindMeta | undefined;
            if (meta) {
              return meta.query ? buildState(tr.doc, meta.query, meta.activeIndex) : EMPTY_STATE;
            }
            if (!prev.query) return prev;
            if (tr.docChanged) return buildState(tr.doc, prev.query, prev.activeIndex);
            return prev;
          },
        },
        props: {
          decorations(state) {
            return findReplacePluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

interface GlobalHighlightState {
  query: string;
  decorations: DecorationSet;
}

export const globalHighlightPluginKey = new PluginKey<GlobalHighlightState>('fnGlobalHighlight');

function buildGlobalState(doc: PMNode, query: string): GlobalHighlightState {
  const decorations = DecorationSet.create(
    doc,
    findMatchesInDoc(doc, query).map((m) => Decoration.inline(m.from, m.to, { class: 'fn-global-match' })),
  );
  return { query, decorations };
}

const EMPTY_GLOBAL_STATE: GlobalHighlightState = { query: '', decorations: DecorationSet.empty };

/**
 * Global-search highlight (VSCode style): marks every occurrence of the sidebar full-text search
 * query in a color distinct from the find/replace bar's, so both can be visible at once. Purely
 * decorative — no navigation state; driven by a meta carrying `{ query }`.
 */
export const GlobalHighlight = Extension.create({
  name: 'fnGlobalHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<GlobalHighlightState>({
        key: globalHighlightPluginKey,
        state: {
          init: () => EMPTY_GLOBAL_STATE,
          apply(tr, prev) {
            const meta = tr.getMeta(globalHighlightPluginKey) as { query: string } | undefined;
            if (meta) {
              return meta.query ? buildGlobalState(tr.doc, meta.query) : EMPTY_GLOBAL_STATE;
            }
            if (!prev.query) return prev;
            if (tr.docChanged) return buildGlobalState(tr.doc, prev.query);
            return prev;
          },
        },
        props: {
          decorations(state) {
            return globalHighlightPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
