/**
 * Heuristic: does this commit message contain Markdown formatting worth
 * rendering? Deliberately conservative — ordinary commit messages must NOT be
 * flagged, including ones with snake_case identifiers (`update_user_profile`)
 * or Python dunders (`__init__`), so underscore-based emphasis is never used
 * as a signal. Bare URLs are ignored too; they are linkified in plain mode
 * anyway and a "see https://…" line is not really Markdown.
 *
 * When this returns false the details panel shows the message as plain text
 * with no Markdown/Plain toggle; when true it renders Markdown and offers the
 * toggle.
 */
const MARKDOWN_PATTERNS: RegExp[] = [
  /^#{1,6}\s+\S/m, // # heading
  /```/, // ``` fenced code block
  /`[^`\n]+`/, // `inline code`
  /^\s*>\s+\S/m, // > blockquote
  /^\s*[-*+]\s+\S/m, // - bullet list (incl. task lists)
  /^\s*\d+\.\s+\S/m, // 1. ordered list
  /\*\*[^*\n]+\*\*/, // **bold**
  /\*[^*\s][^*\n]*\*/, // *italic*
  /~~[^~\n]+~~/, // ~~strikethrough~~
  /\[[^\]\n]+\]\([^)\n]+\)/, // [text](url)
  /^\s*\|?(?:\s*:?-+:?\s*\|)+/m, // | --- | table delimiter row
  /^\s*([-*_])\1{2,}\s*$/m, // --- *** ___ horizontal rule
];

export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return MARKDOWN_PATTERNS.some((re) => re.test(text));
}
