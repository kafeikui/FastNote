import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownViewProps {
  markdown: string;
  className?: string;
}

/** Renders markdown to sanitized HTML (used for AI assistant replies). Fully local: marked
 * parses, DOMPurify strips anything executable before it touches the DOM. */
export function MarkdownView({ markdown, className }: MarkdownViewProps) {
  const html = useMemo(() => {
    const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
    return DOMPurify.sanitize(raw);
  }, [markdown]);
  return (
    <div
      className={`fn-md-view${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
