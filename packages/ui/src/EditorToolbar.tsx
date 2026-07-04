import type { Editor } from '@tiptap/core';
import type { EditorMode } from '@fastnote/shared';
import { useT } from '@fastnote/i18n';

interface EditorToolbarProps {
  editor: Editor | null;
  mode: EditorMode;
}

export function EditorToolbar({ editor, mode }: EditorToolbarProps) {
  const t = useT();
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

  return (
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
      {btn('Link', () => {
        const url = prompt(t('editorToolbar.linkPrompt'));
        if (url) editor.chain().focus().setLink({ href: url }).run();
      }, editor.isActive('link'))}
    </div>
  );
}
