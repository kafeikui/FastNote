import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Markdown } from '@tiptap/markdown';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { deleteLine } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { useEffect, useRef } from 'react';
import type { AnyExtension } from '@tiptap/core';
import type { EditorMode, NoteAttachment } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { AttachmentRef } from './AttachmentRefExtension';
import { EnhancedCodeBlock } from './CodeBlockExtension';
import { LineEditing } from './LineEditingExtension';
import { serializeDocJsonToMarkdown } from './markdownSerialize';
import { normalizeLatexDelimiters } from './latexDelimiters';
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
  const editFormulaPromptRef = useRef(t('noteEditor.editFormulaPrompt'));
  editFormulaPromptRef.current = t('noteEditor.editFormulaPrompt');

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
            const latex = window.prompt(editFormulaPromptRef.current, (node.attrs.latex as string) ?? '');
            if (latex === null) return;
            editorRef.current?.chain().focus().updateInlineMath({ latex, pos }).run();
          },
        },
        blockOptions: {
          onClick: (node, pos) => {
            const latex = window.prompt(editFormulaPromptRef.current, (node.attrs.latex as string) ?? '');
            if (latex === null) return;
            editorRef.current?.chain().focus().updateBlockMath({ latex, pos }).run();
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
        // Prec.high: basicSetup's search keymap already claims Mod-d (select next occurrence),
        // so the delete-line binding must take precedence. Alt-ArrowUp/Down (move line) already
        // ship in the default keymap.
        Prec.high(keymap.of([{ key: 'Mod-d', run: deleteLine }])),
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
