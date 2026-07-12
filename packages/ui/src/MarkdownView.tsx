import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { extractMathSegments } from '@fastnote/shared';

interface MarkdownViewProps {
  markdown: string;
  className?: string;
}

/** Renders markdown to sanitized HTML (used for AI assistant replies). Fully local: marked
 * parses, DOMPurify strips anything executable before it touches the DOM.
 *
 * Math (`$$...$$`, `$...$`, and the `\[...\]`/`\(...\)` variants LLMs love) is lifted out into
 * placeholder tokens before parsing — the markdown parser would otherwise mangle `_`/`\` inside
 * expressions — and rendered with KaTeX after sanitization. KaTeX output is injected verbatim:
 * `renderToString` escapes its input, so it cannot smuggle markup through (`throwOnError: false`
 * turns bad LaTeX into escaped red text, same setting as the note editor). */
export function MarkdownView({ markdown, className }: MarkdownViewProps) {
  const html = useMemo(() => {
    const { text, segments } = extractMathSegments(markdown);
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    let out = DOMPurify.sanitize(raw);
    for (const seg of segments) {
      const rendered = katex.renderToString(seg.expr, {
        throwOnError: false,
        displayMode: seg.display,
      });
      // Replacement-function form so `$`-sequences in KaTeX output are inserted literally.
      out = out.replace(seg.token, () => rendered);
    }
    return out;
  }, [markdown]);
  return (
    <div
      className={`fn-md-view${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
