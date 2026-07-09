import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';

interface BlockInfo {
  index: number;
  start: number;
}

/** Locate the top-level block containing the selection head. */
function topBlockAtSelection(state: EditorState): BlockInfo | null {
  const { $from } = state.selection;
  const index = $from.index(0);
  if (index >= state.doc.childCount) return null;
  let start = 0;
  for (let k = 0; k < index; k += 1) start += state.doc.child(k).nodeSize;
  return { index, start };
}

function deleteCurrentBlock(state: EditorState, tr: Transaction): boolean {
  const info = topBlockAtSelection(state);
  if (!info) return false;
  const node = state.doc.child(info.index);
  const end = info.start + node.nodeSize;
  if (state.doc.childCount === 1) {
    // A doc must keep at least one block, so clear the last one instead of removing it.
    const para = state.schema.nodes.paragraph?.create();
    if (!para) return false;
    tr.replaceWith(info.start, end, para);
    tr.setSelection(TextSelection.near(tr.doc.resolve(info.start + 1)));
  } else {
    tr.delete(info.start, end);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(info.start, tr.doc.content.size))));
  }
  return true;
}

function moveCurrentBlock(state: EditorState, tr: Transaction, dir: -1 | 1): boolean {
  const info = topBlockAtSelection(state);
  if (!info) return false;
  const targetIndex = info.index + dir;
  if (targetIndex < 0 || targetIndex >= state.doc.childCount) return false;

  const firstIndex = Math.min(info.index, targetIndex);
  let pairStart = 0;
  for (let k = 0; k < firstIndex; k += 1) pairStart += state.doc.child(k).nodeSize;
  const a = state.doc.child(firstIndex);
  const b = state.doc.child(firstIndex + 1);
  const pairEnd = pairStart + a.nodeSize + b.nodeSize;

  const offsetInNode = state.selection.from - info.start;
  tr.replaceWith(pairStart, pairEnd, Fragment.from([b, a]));
  const newStart = dir === -1 ? pairStart : pairStart + b.nodeSize;
  const newPos = Math.min(newStart + offsetInNode, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
  tr.scrollIntoView();
  return true;
}

/**
 * Line-level editing shortcuts for the WYSIWYG editor, mirroring the CodeMirror source-mode
 * bindings: Mod-d deletes the current block ("line"), Alt-ArrowUp/Down swaps it with its
 * neighbor.
 */
export const LineEditing = Extension.create({
  name: 'lineEditing',

  addKeyboardShortcuts() {
    return {
      'Mod-d': () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          if (!dispatch) return false;
          return deleteCurrentBlock(state, tr);
        }),
      'Alt-ArrowUp': () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          if (!dispatch) return false;
          return moveCurrentBlock(state, tr, -1);
        }),
      'Alt-ArrowDown': () =>
        this.editor.commands.command(({ state, tr, dispatch }) => {
          if (!dispatch) return false;
          return moveCurrentBlock(state, tr, 1);
        }),
    };
  },
});
