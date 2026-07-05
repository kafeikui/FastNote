import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Mathematics } from '@tiptap/extension-mathematics';
import { Markdown } from '@tiptap/markdown';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { useEffect, useRef } from 'react';
import type { EditorMode, NoteAttachment } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { AttachmentRef } from './AttachmentRefExtension';
import { EnhancedCodeBlock } from './CodeBlockExtension';
import { serializeDocJsonToMarkdown } from './markdownSerialize';
import { normalizeLatexDelimiters } from './latexDelimiters';
import 'katex/dist/katex.min.css';

export interface NoteEditorProps {
  noteId: string;
  mode: EditorMode;
  content: string;
  onChange: (markdown: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  onRegisterInsert?: (insert: (text: string) => void) => void;
  attachments?: NoteAttachment[];
  onAttachmentDownload?: (attachmentId: string) => void;
  onAttachmentEdit?: (attachmentId: string, description: string) => void | Promise<void>;
  placeholder?: string;
  showLineNumbers?: boolean;
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
  attachments = [],
  onAttachmentDownload,
  onAttachmentEdit,
  placeholder,
  showLineNumbers = true,
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
  const editFormulaPromptRef = useRef(t('noteEditor.editFormulaPrompt'));
  editFormulaPromptRef.current = t('noteEditor.editFormulaPrompt');

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ link: false, codeBlock: false }),
        EnhancedCodeBlock,
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
        Markdown,
        Placeholder.configure({ placeholder: effectivePlaceholder }),
      ],
      content: normalizeLatexDelimiters(content),
      contentType: 'markdown',
      onUpdate: ({ editor: e }) => {
        if (modeRef.current !== 'wysiwyg') return;
        onChangeRef.current(getMarkdown(e));
      },
    },
    [noteId],
  );

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    if (lastLoadedNoteRef.current !== noteId) {
      editor.commands.setContent(normalizeLatexDelimiters(content), { contentType: 'markdown', emitUpdate: false });
      lastLoadedNoteRef.current = noteId;
    }
  }, [noteId, content, editor]);

  useEffect(() => {
    if (!editor) return;
    if (prevModeRef.current === 'source' && mode === 'wysiwyg') {
      editor.commands.setContent(normalizeLatexDelimiters(content), { contentType: 'markdown', emitUpdate: false });
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
      extensions: [basicSetup, markdown()],
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

    return () => {
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
