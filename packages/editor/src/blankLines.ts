const FENCE_OR_CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/**
 * Markdown normally collapses any number of blank lines into a single paragraph break, so
 * deliberately left empty lines vanish in render mode. To preserve them we turn every blank line
 * beyond the first into a paragraph containing a single NBSP, which renders as a visually empty
 * line. `serializeDocJsonToMarkdown` reverses this: empty/NBSP-only paragraphs serialize back to
 * plain blank lines.
 */
export function preserveBlankLines(markdown: string): string {
  if (!markdown) return markdown;
  const parts = markdown.split(FENCE_OR_CODE);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/\n{3,}/g, (m) => `\n\n${'\u00A0\n\n'.repeat(m.length - 2)}`);
    })
    .join('');
}
