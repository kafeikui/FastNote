import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Markdown } from '@tiptap/markdown';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { deleteLine } from '@codemirror/commands';
import {
  search as cmSearch,
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
} from '@codemirror/search';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { useEffect, useRef } from 'react';
import type { AnyExtension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorMode, NoteAttachment, FindReplaceController, FindReplaceStatus } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { AttachmentRef } from './AttachmentRefExtension';
import { EnhancedCodeBlock } from './CodeBlockExtension';
import { LineEditing } from './LineEditingExtension';
import { FindReplace, findReplacePluginKey } from './FindReplaceExtension';
import { serializeDocJsonToMarkdown } from './markdownSerialize';
import { normalizeLatexDelimiters } from '@fastnote/shared';
import { preserveBlankLines } from './blankLines';
import 'katex/dist/katex.min.css';

export interface NoteEditorProps {
  noteId: string;
  mode: EditorMode;
  content: string;
  onChange: (markdown: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  onRegisterInsert?: (insert: (text: string) => void) => void;
  /**
   * Registers a "format as JSON" action for the current view (source or render mode). The
   * callback returns false when the (selected) text isn't valid JSON so the caller can surface
   * an error.
   */
  onRegisterFormatJson?: (format: (() => boolean) | null) => void;
  /** Reports the number of characters currently selected (0 when the selection is empty). */
  onSelectionChars?: (count: number) => void;
  /**
   * Called when the user clicks an existing formula to edit it. The host shows an input UI and
   * calls `apply` with the new LaTeX. (window.prompt is unavailable in the Electron renderer.)
   */
  onEditFormula?: (latex: string, apply: (next: string) => void) => void;
  /** Registers the find/replace driver for the current view (source or render mode). */
  onRegisterFindReplace?: (controller: FindReplaceController | null) => void;
  attachments?: NoteAttachment[];
  onAttachmentDownload?: (attachmentId: string) => void;
  onAttachmentEdit?: (attachmentId: string, description: string) => void | Promise<void>;
  placeholder?: string;
  showLineNumbers?: boolean;
  /** Off by default: KaTeX parsing/rendering can be slow on very long documents. */
  enableMath?: boolean;
}

function getMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  return serializeDocJsonToMarkdown(editor.getJSON());
}

export function NoteEditor({
  noteId,
  mode,
  content,
  onChange,
  onEditorReady,
  onRegisterInsert,
  onRegisterFormatJson,
  onSelectionChars,
  onEditFormula,
  onRegisterFindReplace,
  attachments = [],
  onAttachmentDownload,
  onAttachmentEdit,
  placeholder,
  showLineNumbers = true,
  enableMath = false,
}: NoteEditorProps) {
  const t = useT();
  const effectivePlaceholder = placeholder ?? t('noteEditor.placeholder');
  const cmRef = useRef<HTMLDivElement>(null);
  const cmView = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lastLoadedNoteRef = useRef<string | null>(null);
  const prevModeRef = useRef(mode);

  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const onDownloadRef = useRef(onAttachmentDownload);
  onDownloadRef.current = onAttachmentDownload;
  const onEditRef = useRef(onAttachmentEdit);
  onEditRef.current = onAttachmentEdit;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const editorRef = useRef<Editor | null>(null);
  const onSelectionCharsRef = useRef(onSelectionChars);
  onSelectionCharsRef.current = onSelectionChars;
  const onEditFormulaRef = useRef(onEditFormula);
  onEditFormulaRef.current = onEditFormula;
  // Must be a ref: the host passes a fresh arrow function every render, and using it as an
  // effect dependency would re-run the find/replace registration effect (whose cleanup clears
  // the active query and highlights) on every host re-render.
  const onRegisterFindReplaceRef = useRef(onRegisterFindReplace);
  onRegisterFindReplaceRef.current = onRegisterFindReplace;

  // Math parsing/rendering is opt-in: KaTeX work on long documents can make render mode very
  // slow, so the extension (and the $/\[ delimiter normalization) is only wired up when enabled.
  // Blank-line preservation runs first so its NBSP paragraphs survive the latex normalization
  // (which collapses newline runs).
  const prepareContent = (md: string) => {
    const kept = preserveBlankLines(md);
    return enableMath ? normalizeLatexDelimiters(kept) : kept;
  };

  const extensions: AnyExtension[] = [
    StarterKit.configure({ link: false, codeBlock: false }),
    EnhancedCodeBlock,
    LineEditing,
    FindReplace,
    Link.configure({
      openOnClick: false,
      autolink: false,
      HTMLAttributes: { class: 'fn-link' },
      validate: (href) => href.startsWith('http://') || href.startsWith('https://'),
    }),
    AttachmentRef.configure({
      getAttachment: (id: string) => attachmentsRef.current.find((a) => a.id === id),
      onDownload: (id: string) => onDownloadRef.current?.(id),
      onEdit: (id: string, desc: string) => onEditRef.current?.(id, desc),
    }),
  ];
  if (enableMath) {
    extensions.push(
      Mathematics.configure({
        katexOptions: { throwOnError: false },
        inlineOptions: {
          onClick: (node, pos) => {
            onEditFormulaRef.current?.((node.attrs.latex as string) ?? '', (latex) => {
              editorRef.current?.chain().focus().updateInlineMath({ latex, pos }).run();
            });
          },
        },
        blockOptions: {
          onClick: (node, pos) => {
            onEditFormulaRef.current?.((node.attrs.latex as string) ?? '', (latex) => {
              editorRef.current?.chain().focus().updateBlockMath({ latex, pos }).run();
            });
          },
        },
      }),
    );
  }
  extensions.push(
    // `breaks: true`: a single newline in the source is a real line break (GFM behavior), so
    // users don't have to leave a blank line between lines for them to render separately.
    Markdown.configure({ markedOptions: { breaks: true } }),
    Placeholder.configure({ placeholder: effectivePlaceholder }),
  );

  const editor = useEditor(
    {
      extensions,
      content: prepareContent(content),
      contentType: 'markdown',
      editorProps: {
        // Ctrl/Cmd+click opens the link. window.open is intercepted by the Electron main
        // process (setWindowOpenHandler) and routed to the system default browser; in the web
        // app it opens a normal new tab.
        handleClick: (_view, _pos, event) => {
          if (!event.ctrlKey && !event.metaKey) return false;
          const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
          const href = anchor?.getAttribute('href');
          if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
            window.open(href, '_blank', 'noopener');
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: e }) => {
        if (modeRef.current !== 'wysiwyg') return;
        onChangeRef.current(getMarkdown(e));
      },
    },
    [noteId, enableMath],
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    if (lastLoadedNoteRef.current !== noteId) {
      editor.commands.setContent(prepareContent(content), { contentType: 'markdown', emitUpdate: false });
      lastLoadedNoteRef.current = noteId;
    }
  }, [noteId, content, editor]);

  useEffect(() => {
    if (!editor) return;
    if (prevModeRef.current === 'source' && mode === 'wysiwyg') {
      editor.commands.setContent(prepareContent(content), { contentType: 'markdown', emitUpdate: false });
    }
    prevModeRef.current = mode;
  }, [mode, content, editor]);

  useEffect(() => {
    if (!editor || mode !== 'wysiwyg') return;
    editor.view.dispatch(editor.state.tr.setMeta('attachmentRefresh', Date.now()));
  }, [attachments, editor, mode]);

  useEffect(() => {
    onEditorReadyRef.current?.(mode === 'wysiwyg' ? editor : null);
    return () => onEditorReadyRef.current?.(null);
  }, [editor, mode]);

  useEffect(() => {
    if (!editor || mode !== 'wysiwyg') return;
    const report = () => {
      const { from, to } = editor.state.selection;
      onSelectionCharsRef.current?.(from === to ? 0 : editor.state.doc.textBetween(from, to, '\n').length);
    };
    editor.on('selectionUpdate', report);
    editor.on('update', report);
    return () => {
      editor.off('selectionUpdate', report);
      editor.off('update', report);
      onSelectionCharsRef.current?.(0);
    };
  }, [editor, mode]);

  // Render-mode find/replace: driven by the ProseMirror plugin in FindReplaceExtension, which
  // owns match computation and highlight decorations.
  useEffect(() => {
    if (!editor || mode !== 'wysiwyg' || !onRegisterFindReplaceRef.current) return;

    const dispatchFind = (query: string, activeIndex: number) => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(editor.state.tr.setMeta(findReplacePluginKey, { query, activeIndex }));
    };

    const status = (): FindReplaceStatus => {
      const s = findReplacePluginKey.getState(editor.state);
      const total = s?.matches.length ?? 0;
      return { total, current: total > 0 ? (s?.activeIndex ?? 0) + 1 : 0 };
    };

    const scrollToActive = () => {
      const s = findReplacePluginKey.getState(editor.state);
      const m = s?.matches[s.activeIndex];
      if (!m) return;
      const sel = TextSelection.create(editor.state.doc, m.from, m.to);
      editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
    };

    const step = (dir: 1 | -1): FindReplaceStatus => {
      const s = findReplacePluginKey.getState(editor.state);
      const total = s?.matches.length ?? 0;
      if (!s || total === 0) return { total: 0, current: 0 };
      dispatchFind(s.query, (s.activeIndex + dir + total) % total);
      scrollToActive();
      return status();
    };

    onRegisterFindReplaceRef.current({
      search: (query) => {
        dispatchFind(query, 0);
        if (query) scrollToActive();
        return status();
      },
      next: () => step(1),
      prev: () => step(-1),
      replace: (replacement) => {
        const s = findReplacePluginKey.getState(editor.state);
        const m = s?.matches[s.activeIndex];
        if (!m) return status();
        // The doc change makes the plugin recompute matches; the active index stays put, which
        // naturally lands on the next remaining match.
        editor.view.dispatch(editor.state.tr.insertText(replacement, m.from, m.to));
        scrollToActive();
        return status();
      },
      replaceAll: (replacement) => {
        const s = findReplacePluginKey.getState(editor.state);
        if (!s || s.matches.length === 0) return 0;
        const count = s.matches.length;
        const tr = editor.state.tr;
        // Back to front so earlier positions stay valid without mapping.
        for (const m of [...s.matches].reverse()) {
          tr.insertText(replacement, m.from, m.to);
        }
        editor.view.dispatch(tr);
        return count;
      },
      close: () => {
        dispatchFind('', 0);
      },
    });

    return () => {
      dispatchFind('', 0);
      onRegisterFindReplaceRef.current?.(null);
    };
  }, [editor, mode, noteId]);

  // Render-mode "format JSON": formats the selected text (or the whole document when nothing is
  // selected) and replaces it with a json code block, which is the only rich-text construct that
  // preserves the indentation.
  useEffect(() => {
    if (!editor || mode !== 'wysiwyg' || !onRegisterFormatJson) return;
    onRegisterFormatJson(() => {
      const { from, to, empty } = editor.state.selection;
      const text = empty
        ? editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')
        : editor.state.doc.textBetween(from, to, '\n');
      let formatted: string;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return false;
      }
      const block = { type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: formatted }] };
      if (empty) {
        editor.commands.setContent({ type: 'doc', content: [block] }, { emitUpdate: true });
      } else {
        editor.chain().focus().insertContentAt({ from, to }, block).run();
      }
      return true;
    });
    return () => onRegisterFormatJson(null);
  }, [editor, mode, onRegisterFormatJson, noteId]);

  useEffect(() => {
    if (!onRegisterInsert) return;
    if (mode === 'wysiwyg' && editor) {
      onRegisterInsert((text) => {
        editor.chain().focus().insertContent(text, { contentType: 'markdown' }).run();
      });
      return;
    }
    if (mode === 'source' && cmView.current) {
      onRegisterInsert((text) => {
        const view = cmView.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        });
        onChangeRef.current(view.state.doc.toString());
      });
    }
  }, [editor, mode, onRegisterInsert, noteId]);

  useEffect(() => {
    if (mode !== 'source' || !cmRef.current) return;

    cmView.current?.destroy();
    cmView.current = new EditorView({
      doc: content,
      extensions: [
        basicSetup,
        markdown(),
        // Provides the search state used by the shared find/replace bar (driven programmatically
        // below — CodeMirror's own panel stays hidden).
        cmSearch(),
        // Prec.high: basicSetup's search keymap already claims Mod-d (select next occurrence),
        // so the delete-line binding must take precedence. Alt-ArrowUp/Down (move line) already
        // ship in the default keymap. Mod-f is swallowed so CodeMirror's built-in search panel
        // never opens — the app-level shortcut opens the shared find/replace bar instead.
        Prec.high(
          keymap.of([
            { key: 'Mod-d', run: deleteLine },
            { key: 'Mod-f', run: () => true },
          ]),
        ),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            const { from, to } = update.state.selection.main;
            onSelectionCharsRef.current?.(to - from);
          }
        }),
      ],
      parent: cmRef.current,
      dispatch: (tr) => {
        cmView.current?.update([tr]);
        if (tr.docChanged) {
          onChangeRef.current(tr.newDoc.toString());
        }
      },
    });

    onRegisterInsert?.((text) => {
      const view = cmView.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      onChangeRef.current(view.state.doc.toString());
    });

    // Source-mode find/replace: programmatic driving of @codemirror/search (no built-in panel).
    // The selection is placed on the current match; basicSetup's highlightSelectionMatches then
    // highlights the other occurrences.
    if (onRegisterFindReplaceRef.current) {
      let frQuery = '';

      const applyQuery = (query: string, replacement: string) => {
        cmView.current?.dispatch({
          effects: setSearchQuery.of(
            new SearchQuery({ search: query, replace: replacement, caseSensitive: false }),
          ),
        });
      };

      const frStatus = (): FindReplaceStatus => {
        const view = cmView.current;
        if (!view || !frQuery) return { total: 0, current: 0 };
        const q = new SearchQuery({ search: frQuery, caseSensitive: false });
        const cursor = q.getCursor(view.state) as Iterator<{ from: number; to: number }>;
        const sel = view.state.selection.main;
        let total = 0;
        let current = 0;
        for (let r = cursor.next(); !r.done; r = cursor.next()) {
          total++;
          if (r.value.from < sel.to) current = total;
        }
        return { total, current };
      };

      onRegisterFindReplaceRef.current({
        search: (query) => {
          frQuery = query;
          applyQuery(query, '');
          if (query && cmView.current) {
            // Search from the top so the first hit is the first match in the document.
            cmView.current.dispatch({ selection: { anchor: 0 } });
            cmFindNext(cmView.current);
          }
          return frStatus();
        },
        next: () => {
          if (cmView.current) cmFindNext(cmView.current);
          return frStatus();
        },
        prev: () => {
          if (cmView.current) cmFindPrevious(cmView.current);
          return frStatus();
        },
        replace: (replacement) => {
          applyQuery(frQuery, replacement);
          if (cmView.current) cmReplaceNext(cmView.current);
          return frStatus();
        },
        replaceAll: (replacement) => {
          const before = frStatus().total;
          applyQuery(frQuery, replacement);
          if (cmView.current) cmReplaceAll(cmView.current);
          return before;
        },
        close: () => {
          frQuery = '';
          applyQuery('', '');
        },
      });
    }

    onRegisterFormatJson?.(() => {
      const view = cmView.current;
      if (!view) return false;
      const { from, to } = view.state.selection.main;
      const hasSelection = from !== to;
      const text = hasSelection ? view.state.sliceDoc(from, to) : view.state.doc.toString();
      let formatted: string;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        return false;
      }
      view.dispatch({
        changes: hasSelection
          ? { from, to, insert: formatted }
          : { from: 0, to: view.state.doc.length, insert: formatted },
      });
      onChangeRef.current(view.state.doc.toString());
      return true;
    });

    return () => {
      onRegisterFormatJson?.(null);
      onRegisterFindReplaceRef.current?.(null);
      onSelectionCharsRef.current?.(0);
      cmView.current?.destroy();
      cmView.current = null;
    };
  }, [noteId, mode]);

  useEffect(() => {
    if (mode !== 'source' || !cmView.current) return;
    const view = cmView.current;
    const cur = view.state.doc.toString();
    if (cur !== content) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: content },
      });
    }
  }, [content, mode]);

  if (mode === 'source') {
    return (
      <div
        ref={cmRef}
        className={`fn-editor fn-editor--source${showLineNumbers ? '' : ' fn-editor--no-line-numbers'}`}
      />
    );
  }

  return (
    <div className={`fn-editor fn-editor--wysiwyg${showLineNumbers ? ' fn-editor--lined' : ''}`}>
      <EditorContent editor={editor} />
    </div>
  );
}

export type { Editor };

export function flushEditorMarkdown(editor: Editor | null): string | null {
  if (!editor) return null;
  return getMarkdown(editor);
}
