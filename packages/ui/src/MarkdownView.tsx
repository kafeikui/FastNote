import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { extractMathSegments } from '@fastnote/shared';

interface MarkdownViewProps {
  markdown: string;
  className?: string;
  /** Case-insensitive query whose occurrences are wrapped in <mark class="fn-ai-find-mark">. */
  highlightQuery?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Renders markdown to sanitized HTML. Fully local: marked parses, DOMPurify strips anything
 * executable.
 *
 * Math (`$$...$$`, `$...$`, and the `\[...\]`/`\(...\)` variants LLMs love) is lifted out into
 * placeholder tokens before parsing — the markdown parser would otherwise mangle `_`/`\` inside
 * expressions — and rendered with KaTeX after sanitization. KaTeX output is injected verbatim:
 * `renderToString` escapes its input, so it cannot smuggle markup through (`throwOnError: false`
 * turns bad LaTeX into escaped red text, same setting as the note editor).
 *
 * `mathAsTex` keeps formulas as escaped `<code>` TeX source instead of KaTeX markup — for export
 * targets (e.g. Word documents) where KaTeX's HTML renders as duplicated garbled text without
 * its stylesheet and fonts.
 */
export function renderMarkdownHtml(markdown: string, opts?: { mathAsTex?: boolean }): string {
  const { text, segments } = extractMathSegments(markdown);
  const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
  let out = DOMPurify.sanitize(raw);
  for (const seg of segments) {
    const rendered = opts?.mathAsTex
      ? `<code>${escapeHtml(seg.display ? `$$${seg.expr}$$` : `$${seg.expr}$`)}</code>`
      : katex.renderToString(seg.expr, {
          throwOnError: false,
          // AI replies routinely put CJK text and typographic dashes inside formulas; KaTeX
          // renders them fine, the default 'warn' strict mode just floods the console.
          strict: false,
          displayMode: seg.display,
        });
    // Replacement-function form so `$`-sequences in KaTeX output are inserted literally.
    out = out.replace(seg.token, () => rendered);
  }
  return out;
}

/**
 * Wraps occurrences of `query` (case-insensitive) in <mark class="fn-ai-find-mark"> by parsing
 * the (already sanitized) HTML and walking its text nodes, so tags/attributes are never touched.
 * KaTeX subtrees are skipped: each formula carries a hidden MathML copy of its TeX source that
 * would produce invisible, unscrollable matches, and the visible half is fragmented into
 * per-glyph spans that a multi-character query can't match anyway.
 *
 * Done at the HTML-string level (not by mutating the live DOM afterwards) so the marks are part
 * of what React renders — post-render DOM surgery gets overwritten by reconciliation.
 */
export function highlightHtml(html: string, query: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('.katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    let i = lower.indexOf(q);
    if (i === -1) continue;
    const frag = doc.createDocumentFragment();
    let pos = 0;
    while (i !== -1) {
      if (i > pos) frag.appendChild(doc.createTextNode(text.slice(pos, i)));
      const mark = doc.createElement('mark');
      mark.className = 'fn-ai-find-mark';
      mark.textContent = text.slice(i, i + q.length);
      frag.appendChild(mark);
      pos = i + q.length;
      i = lower.indexOf(q, pos);
    }
    if (pos < text.length) frag.appendChild(doc.createTextNode(text.slice(pos)));
    node.parentNode?.replaceChild(frag, node);
  }
  return doc.body.innerHTML;
}

/** Renders markdown to sanitized HTML in the DOM (used for AI assistant replies). */
export function MarkdownView({ markdown, className, highlightQuery }: MarkdownViewProps) {
  // Two-step memo: markdown/KaTeX rendering is expensive and must not re-run on every find-query
  // keystroke; the highlight pass is a cheap DOM walk over the cached HTML.
  const base = useMemo(() => renderMarkdownHtml(markdown), [markdown]);
  const html = useMemo(
    () => (highlightQuery ? highlightHtml(base, highlightQuery) : base),
    [base, highlightQuery],
  );
  return (
    <div
      className={`fn-md-view${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
