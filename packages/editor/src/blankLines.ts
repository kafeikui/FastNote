/** Matches fenced code blocks and inline code spans, whose newlines must never be touched. */
export const FENCE_OR_CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Markdown normally collapses any number of blank lines into a single paragraph break, so
 * deliberately left empty lines vanish in render mode. To preserve them we turn every blank line
 * beyond the first into a paragraph containing a single NBSP, which renders as a visually empty
 * line. `serializeDocJsonToMarkdown` reverses this: empty/NBSP-only paragraphs serialize back to
 * plain blank lines.
 *
 * Document edges need dedicated rules (verified against marked + @tiptap/markdown behavior):
 * - a single trailing "\n" never even produces a token (the paragraph absorbs it), so the last
 *   Enter typed in source mode used to vanish;
 * - trailing "\n\n" produces a boundary `space` token that @tiptap/markdown turns into an
 *   *implicit* empty paragraph, counted differently from interior runs;
 * - leading newlines are dropped entirely.
 * The trailing rule therefore consumes the whole run — n newlines become n NBSP paragraphs with
 * the string ending on the last NBSP — so the parser never sees a trailing newline and the
 * implicit-paragraph heuristic can't fire. The serializer restores exactly one "\n" per trailing
 * NBSP/empty paragraph.
 */
export function preserveBlankLines(markdown: string): string {
  if (!markdown) return markdown;
  const parts = markdown.split(FENCE_OR_CODE);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let out = part;
      // Trailing edge: n newlines → n NBSP paragraphs, ending on the last NBSP (no trailing
      // newline survives). The "\n\n" separator is only needed when content precedes the run.
      if (index === parts.length - 1) {
        out = out.replace(/\n+$/, (m, offset: number) => {
          const nbsps = Array<string>(m.length).fill('\u00A0').join('\n\n');
          return offset > 0 || index > 0 ? `\n\n${nbsps}` : nbsps;
        });
      }
      // Leading edge: each dropped-by-markdown newline becomes an NBSP paragraph.
      if (index === 0) {
        out = out.replace(/^\n+/, (m) => '\u00A0\n\n'.repeat(m.length));
      }
      // Interior runs: a paragraph break plus one NBSP paragraph per extra blank line.
      return out.replace(/\n{3,}/g, (m) => `\n\n${'\u00A0\n\n'.repeat(m.length - 2)}`);
    })
    .join('');
}
