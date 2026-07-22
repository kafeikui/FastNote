import { useState } from 'react';
import type { Editor } from '@tiptap/core';
// Type-only imports (erased at build time): pull in the `declare module '@tiptap/core'`
// augmentations that declare chained commands like toggleBold/setLink/insertInlineMath.
// Without these, `tsc --noEmit` fails even though the runtime (which loads the extensions
// via packages/editor) works fine.
import type {} from '@tiptap/starter-kit';
import type {} from '@tiptap/extension-link';
import type {} from '@tiptap/extension-mathematics';
import type { EditorMode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';
import { InlineInputBar } from './InlineInputBar';

interface EditorToolbarProps {
  editor: Editor | null;
  mode: EditorMode;
  /** Hides the formula buttons when math rendering is disabled in settings. */
  enableMath?: boolean;
}

type PendingKind = 'link' | 'inlineMath' | 'blockMath';

export function EditorToolbar({ editor, mode, enableMath = false }: EditorToolbarProps) {
  const t = useT();
  // Inline input replaces window.prompt(), which silently returns null in Electron.
  const [pending, setPending] = useState<PendingKind | null>(null);
  if (mode !== 'wysiwyg' || !editor) return null;

  const btn = (label: string, action: () => void, active = false) => (
    <button
      key={label}
      type="button"
      className={active ? 'active' : ''}
      onClick={action}
      title={label}
    >
      {label}
    </button>
  );

  const pendingLabel =
    pending === 'link'
      ? t('editorToolbar.linkPrompt')
      : pending === 'inlineMath'
        ? t('editorToolbar.formulaInlinePrompt')
        : t('editorToolbar.formulaBlockPrompt');

  const pendingInitial = pending === 'link' ? ((editor.getAttributes('link').href as string) ?? '') : '';

  const confirmPending = (value: string) => {
    const v = value.trim();
    setPending(null);
    if (pending === 'link') {
      // Confirming an empty URL removes the link (the natural way to "unlink" from this bar).
      if (!v) editor.chain().focus().unsetLink().run();
      else editor.chain().focus().setLink({ href: v }).run();
      return;
    }
    if (!v) return;
    if (pending === 'inlineMath') {
      editor.chain().focus().insertInlineMath({ latex: v }).run();
    } else if (pending === 'blockMath') {
      editor.chain().focus().insertBlockMath({ latex: v }).run();
    }
  };

  return (
    <>
      <div className="fn-editor-toolbar">
        {btn('H1', () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive('heading', { level: 1 }))}
        {btn('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
        {btn('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
        <span className="fn-editor-toolbar__sep" />
        {btn('B', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'))}
        {btn('I', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'))}
        <span className="fn-editor-toolbar__sep" />
        {btn('•', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'))}
        {btn('1.', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'))}
        {btn('❝', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'))}
        {btn('</>', () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive('codeBlock'))}
        {btn('Link', () => setPending(pending === 'link' ? null : 'link'), editor.isActive('link'))}
        {enableMath && (
          <>
            <span className="fn-editor-toolbar__sep" />
            {btn('∑', () => setPending(pending === 'inlineMath' ? null : 'inlineMath'), editor.isActive('inlineMath'))}
            {btn('∑∑', () => setPending(pending === 'blockMath' ? null : 'blockMath'), editor.isActive('blockMath'))}
          </>
        )}
      </div>
      {pending && (
        <InlineInputBar
          key={pending}
          label={pendingLabel}
          initial={pendingInitial}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
