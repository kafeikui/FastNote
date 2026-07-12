/**
 * Many external sources (AI chat assistants, LaTeX documents, MathJax-rendered pages) use the
 * standard LaTeX delimiters `\( ... \)` (inline) and `\[ ... \]` (block/display) for math instead
 * of the `$ ... $` / `$$ ... $$` syntax our editor's math extension understands. Some sources even
 * lose the backslashes entirely when copied as plain text, leaving a bare `[` / `]` alone on their
 * own line wrapping the expression. This normalizes pasted/loaded markdown so those expressions
 * still render, without touching the canonical storage format (notes are re-serialized back to
 * `$`/`$$` on the next edit).
 *
 * It also fixes up a common breakage even in already-correct `$...$`/`$$...$$` math: a literal `%`
 * (e.g. "93.7%") starts a LaTeX comment that swallows the rest of the expression (including the
 * closing brace/delimiter), so KaTeX fails to parse it. We escape any unescaped `%` inside math
 * spans to `\%` so it renders as a literal percent sign instead.
 */

const FENCE_OR_CODE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// A line that is only `[`/`\[` ... eventually a line that is only `]`/`\]`, non-greedy so each
// block is matched separately.
const ESCAPED_BLOCK = /\\\[([\s\S]*?)\\\]/g;
const ESCAPED_INLINE = /\\\(([\s\S]*?)\\\)/g;
// Bare brackets alone on their own line: safe to treat as display math only because a lone `[`
// with nothing else on the line almost never occurs in normal prose/markdown (link syntax always
// has `]( ... )` or `]:` right after the closing bracket on the same line).
const BARE_BLOCK = /^[ \t]*\[[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\][ \t]*$/gm;
// Already-correct `$$ ... $$` / `$ ... $` math, only re-wrapped here to fix up `%` escaping.
const DOLLAR_BLOCK = /\$\$([\s\S]*?)\$\$/g;
const DOLLAR_INLINE = /\$([^$\n]+?)\$(?!\$)/g;

function looksLikeLatex(expr: string): boolean {
  return /\\[a-zA-Z]+|_\{|\^\{/.test(expr);
}

function escapePercent(expr: string): string {
  return expr.replace(/\\%|%/g, (m) => (m === '%' ? '\\%' : m));
}

function mapOutsideCode(markdown: string, transform: (chunk: string) => string): string {
  const parts = markdown.split(FENCE_OR_CODE);
  return parts.map((part, index) => (index % 2 === 0 ? transform(part) : part)).join('');
}

function convertDelimiters(chunk: string): string {
  let out = chunk.replace(
    ESCAPED_BLOCK,
    (_match, expr: string) => `\n\n$$\n${escapePercent(expr.trim())}\n$$\n\n`,
  );
  out = out.replace(ESCAPED_INLINE, (_match, expr: string) => `$${escapePercent(expr.trim())}$`);
  out = out.replace(BARE_BLOCK, (match, expr: string) => {
    if (!looksLikeLatex(expr)) return match;
    return `\n\n$$\n${escapePercent(expr.trim())}\n$$\n\n`;
  });
  // Fix up `%` in math that was already correctly delimited (escapePercent is idempotent, so this
  // is safe to run over blocks we just converted above too).
  out = out.replace(DOLLAR_BLOCK, (_match, expr: string) => `$$${escapePercent(expr)}$$`);
  out = out.replace(DOLLAR_INLINE, (_match, expr: string) => `$${escapePercent(expr)}$`);
  return out;
}

export function normalizeLatexDelimiters(markdown: string): string {
  if (!markdown) return markdown;
  return mapOutsideCode(markdown, convertDelimiters).replace(/\n{3,}/g, '\n\n');
}

// Looser than looksLikeLatex (which guards bare-bracket *blocks*): text already wrapped in
// `$...$` just needs a hint of math — a command, or a bare `_`/`^` script like `E=mc^2` — to be
// treated as such, while `$5 and $10` style prose (digits/words only) stays plain text.
const INLINE_MATH_HINT = /\\[a-zA-Z]+|[_^]\{|[_^][a-zA-Z0-9]/;

export interface MathSegment {
  /** Unique placeholder left in the returned text where this expression sat. */
  token: string;
  /** The LaTeX source, without delimiters. */
  expr: string;
  /** True for `$$...$$` display math, false for inline `$...$`. */
  display: boolean;
}

/**
 * Normalizes delimiters, then lifts every math expression out of the markdown and replaces it
 * with an inert alphanumeric placeholder that survives markdown parsing and HTML sanitization
 * untouched. The caller renders each segment (e.g. with KaTeX) and substitutes it back into the
 * final HTML — this keeps the math source away from the markdown parser, which would otherwise
 * mangle `_`/`\` inside expressions. Inline `$...$` is only treated as math when it plausibly
 * contains LaTeX, so prose like "$5 and $10" is left alone.
 */
export function extractMathSegments(markdown: string): { text: string; segments: MathSegment[] } {
  const segments: MathSegment[] = [];
  if (!markdown) return { text: markdown, segments };
  const takeToken = (expr: string, display: boolean): string => {
    const token = `FNMATH${segments.length}MARK`;
    segments.push({ token, expr, display });
    return token;
  };
  const text = mapOutsideCode(normalizeLatexDelimiters(markdown), (chunk) => {
    // Blank lines around block placeholders make marked emit them as standalone paragraphs.
    let out = chunk.replace(DOLLAR_BLOCK, (_m, expr: string) => `\n\n${takeToken(expr.trim(), true)}\n\n`);
    out = out.replace(DOLLAR_INLINE, (match, expr: string) =>
      INLINE_MATH_HINT.test(expr) ? takeToken(expr, false) : match,
    );
    return out;
  });
  return { text: text.replace(/\n{3,}/g, '\n\n'), segments };
}
