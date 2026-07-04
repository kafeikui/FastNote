import CodeBlock from '@tiptap/extension-code-block';
import { ReactNodeViewRenderer, NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState, type KeyboardEvent } from 'react';
import { useT } from '@fastnote/i18n';

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const t = useT();
  const lang = (node.attrs.language as string | null) || '';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(lang);

  const commit = () => {
    const next = draft.trim();
    updateAttributes({ language: next || null });
    setEditing(false);
  };

  const displayLang = lang || 'text';

  return (
    <NodeViewWrapper className="fn-code-block-wrap">
      <div className="fn-code-block__lang-bar" contentEditable={false}>
        {editing ? (
          <input
            className="fn-code-block__lang-input"
            value={draft}
            autoFocus
            placeholder={t('codeBlock.languagePlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="fn-code-block__lang-btn"
            onClick={() => {
              setDraft(lang);
              setEditing(true);
            }}
          >
            {displayLang}
          </button>
        )}
      </div>
      <pre className={`fn-code-block language-${displayLang}`} data-language={displayLang}>
        <code className={`language-${displayLang}`} data-language={displayLang}>
          <NodeViewContent as="div" />
        </code>
      </pre>
    </NodeViewWrapper>
  );
}

export const EnhancedCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      language: {
        default: null,
        parseHTML: (element) => {
          const lang =
            element.getAttribute('data-language') ??
            element.querySelector('code')?.getAttribute('data-language') ??
            element.querySelector('code')?.className.match(/language-(\S+)/)?.[1];
          return lang || null;
        },
        renderHTML: (attributes) => {
          if (!attributes.language) return {};
          return { 'data-language': attributes.language };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },

  markdownTokenName: 'code',

  parseMarkdown: (token, helpers) => {
    if (
      token.raw?.startsWith('```') === false &&
      token.raw?.startsWith('~~~') === false &&
      token.codeBlockStyle !== 'indented'
    ) {
      return [];
    }
    return helpers.createNode(
      'codeBlock',
      { language: token.lang || null },
      token.text ? [helpers.createTextNode(token.text)] : [],
    );
  },

  renderMarkdown: (node, helpers) => {
    const language = (node.attrs?.language as string | null) ?? '';
    if (!node.content?.length) {
      return `\`\`\`${language}\n\n\`\`\``;
    }
    return [`\`\`\`${language}`, helpers.renderChildren(node.content), '```'].join('\n');
  },
});
