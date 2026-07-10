import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface FindMatch {
  from: number;
  to: number;
}

/**
 * Case-insensitive text search across the document's text nodes. Matches never span node
 * boundaries (e.g. half-bold words) — a deliberate first-version limitation.
 */
export function findMatchesInDoc(doc: PMNode, query: string): FindMatch[] {
  const matches: FindMatch[] = [];
  if (!query) return matches;
  const q = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const text = node.text.toLowerCase();
    let idx = text.indexOf(q);
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + q.length });
      idx = text.indexOf(q, idx + q.length);
    }
    return true;
  });
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
