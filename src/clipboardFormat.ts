export type ChangeTypeLabel = 'NEW' | 'MODIFIED' | 'DELETED' | 'MOVED';

export interface ParsedEntry {
  path: string;
  content: string;
  changeTypes: Set<ChangeTypeLabel>;
}

export interface PayloadFile {
  path: string;
  content?: string;
  changeType?: ChangeTypeLabel;
  skippedReason?: string;
}

interface BuildPayloadOptions {
  headerFormat: string;
  preText: string;
  postText: string;
  addExtraLineBetweenFiles: boolean;
  files: PayloadFile[];
  // Basename of the folder the paths are relative to (source repo/workspace root).
  // Emitted as a leading metadata line so Paste & Restore can align folder levels
  // deterministically instead of guessing. Optional; omitted = no metadata line.
  sourceRoot?: string;
}

const LABELS: ChangeTypeLabel[] = ['NEW', 'MODIFIED', 'DELETED', 'MOVED'];
// ASCII whitespace class — matches the Kotlin mirror's regex `\s` (ASCII-only). JS's
// own `\s` is Unicode-wide (NBSP, ideographic space U+3000, BOM…), so a line indented
// with a full-width space would parse as a header here but NOT on the Kotlin side,
// splitting a phantom file on cross-tool restore. Builders only ever emit ASCII
// whitespace, so pinning to ASCII keeps both parsers byte-aligned. Keep in sync with
// ClipboardRestoreParser.kt (GENERIC_FILE_HEADER, MULTI_LABEL_PATTERN).
const ASCII_WS = ' \\t\\n\\x0B\\f\\r';
const LABEL_PATTERN = new RegExp(`\\[(${LABELS.join('|')})\\]`, 'g');
const LEADING_LABEL_PATTERN = new RegExp(`^(?:\\[(${LABELS.join('|')})\\][${ASCII_WS}]*)+`);
// The `file:` token is spelled out per-character instead of relying on the /i flag.
// Kotlin's RegexOption.IGNORE_CASE is CASE_INSENSITIVE|UNICODE_CASE, which folds the
// Turkish dotless i (U+0131) onto `i`; JavaScript's /i explicitly refuses that fold. A
// content line "// fıle: phantom.ts" was therefore plain content here and a header in
// IntelliJ, so this payload pasted into ClipCode was truncated and grew a phantom file.
// ASCII case folding is all this token ever needed — keep both sides spelled out.
const GENERIC_FILE_HEADER = new RegExp(
  `^[${ASCII_WS}]*(?:(\\/\\/|#|\\/\\*)[${ASCII_WS}]*)?[Ff][Ii][Ll][Ee]:[${ASCII_WS}]*(.+?)[${ASCII_WS}]*(?:\\*\\/)?$`
);
// Scheme A marker — MUST match the Kotlin side byte-for-byte (see notes).
// Distinctive enough that a real source line virtually never starts with it, so
// the unconditional strip on read can't corrupt foreign/old clipboards. Must be
// byte-identical to the Kotlin ClipCode mirror or cross-tool restore breaks.
const ESCAPE_MARKER = '//clipcode-esc: ';

// Leading metadata line: records the source root folder name so restore can align
// folder levels. It sits before the first file header, so the parser ignores it as
// pre-header text; only extractSourceRoot() reads it (from line 1).
const SOURCE_ROOT_MARKER = '// clipcode-root: ';

// Terminates the last file's body. Without it NOTHING on the wire says where the file
// content stops and the configured footer starts, so the footer was accumulated INTO that
// file — which also made a size-skipped placeholder body multi-line and walked straight
// past the placeholder guard, overwriting a real 1100-byte file with a 58-byte stub.
// Reconstructing the footer from the RECEIVER's setting (the first attempt) cannot work:
// the two tools do not share settings, so it missed exactly when it mattered, and when it
// did fire on a foreign payload it silently deleted a real closing line. An explicit
// marker is receiver-independent. Escaped like any other line when it appears in real
// content, so it round-trips. MUST be byte-identical to the Kotlin mirror.
const POST_TEXT_MARKER = '// clipcode-end';

// ASCII-only trim, never String.trim(). Kotlin's trim is Character.isWhitespace ∪
// isSpaceChar and JS's is the ECMAScript WhiteSpace set; they disagree on U+001C-U+001F
// and U+FEFF. That disagreement is not cosmetic — it decided whether a header path kept a
// trailing control char (so the two tools wrote DIFFERENT filenames), whether a line
// counted as blank, and, through isPlaceholderBody, whether a real file got overwritten.
// One ASCII class on both sides removes the whole class of divergence.
const ASCII_WS_TRIM = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;
export function asciiTrim(value: string): string {
  return value.replace(ASCII_WS_TRIM, '');
}

/** Read the source-root metadata from the first line, if present. */
export function extractSourceRoot(clipboardText: string): string | undefined {
  const firstLine = clipboardText.slice(0, clipboardText.indexOf('\n') === -1 ? undefined : clipboardText.indexOf('\n'));
  if (!firstLine.startsWith(SOURCE_ROOT_MARKER)) return undefined;
  const value = asciiTrim(firstLine.slice(SOURCE_ROOT_MARKER.length));
  return value || undefined;
}

export function formatHeader(
  headerFormat: string,
  clipboardPath: string,
  changeType?: ChangeTypeLabel
): string {
  const pathWithLabel = changeType ? `[${changeType}] ${clipboardPath}` : clipboardPath;
  // split/join, NOT replaceAll(str, str): a string replacement in replaceAll expands
  // `$&`, `$$`, etc., so a path containing those would be corrupted (even in this
  // tool's own round-trip). split/join inserts pathWithLabel verbatim, matching the
  // Kotlin side's literal String.replace.
  return headerFormat.split('$FILE_PATH').join(pathWithLabel);
}

export function buildPayload(options: BuildPayloadOptions): string {
  return buildPayloadInternal(options, true);
}

export function buildGitPayload(options: BuildPayloadOptions): string {
  return buildPayloadInternal(options, false);
}

function buildPayloadInternal(options: BuildPayloadOptions, includeEmptyWrappers: boolean): string {
  const customRegex = toHeaderPattern(options.headerFormat);
  const lines: string[] = [];
  // Metadata line first (before any header) so the parser drops it as pre-header
  // text and only extractSourceRoot() reads it. Skip it if the configured header
  // is permissive enough to parse the marker line as a file (e.g. "$FILE_PATH"),
  // which would make it a phantom entry for parsers that don't special-case it.
  if (options.sourceRoot) {
    const metaLine = `${SOURCE_ROOT_MARKER}${options.sourceRoot}`;
    if (findHeaderPath(metaLine, customRegex) === undefined) lines.push(metaLine);
  }
  // Escape pre/post text too, so a header-shaped wrapper can't read back as a file.
  if (includeEmptyWrappers || options.preText) lines.push(escapeContent(options.preText, customRegex));

  for (const file of options.files) {
    lines.push(formatHeader(options.headerFormat, file.path, file.changeType));
    const body = file.skippedReason ? `// File skipped: ${file.skippedReason}` : file.content ?? '';
    lines.push(escapeContent(body, customRegex));
    if (options.addExtraLineBetweenFiles) lines.push('');
  }

  if (includeEmptyWrappers || options.postText) {
    // Only when there IS a footer — an empty wrapper slot needs no terminator, and this
    // keeps every postText-free payload byte-identical to the previous format.
    // Suppressed when the configured header would swallow the marker line, exactly as the
    // `clipcode-root` line is: under `// $FILE_PATH` the marker IS a valid header for a
    // file named `clipcode-end`, so emitting it would make that real file unrepresentable.
    // Without the terminator the footer glues onto the last file, which is what payloads
    // from before this marker already do — a known, documented fallback.
    if (options.postText && findHeaderPath(POST_TEXT_MARKER, customRegex) === undefined) {
      lines.push(POST_TEXT_MARKER);
    }
    lines.push(escapeContent(options.postText, customRegex));
  }
  return lines.join('\n');
}

// Scheme A escape: prefix any content line that would parse as a header with
// ESCAPE_MARKER so it round-trips as content, not a phantom file boundary.
function escapeContent(text: string, customRegex?: RegExp): string {
  if (!text) return text;
  return text
    .split('\n')
    .map(line => (needsEscape(line, customRegex) ? ESCAPE_MARKER + line : line))
    .join('\n');
}

// Escape a line if it would parse as a header (must be hidden) or already starts
// with the marker (so unescape stays a true inverse). Skip it when prefixing the
// marker wouldn't stop it parsing as a header anyway — a degenerate headerFormat
// that matches everything — so we don't mark every single content line.
function needsEscape(line: string, customRegex?: RegExp): boolean {
  if (line.startsWith(ESCAPE_MARKER)) return true;
  // A real content line that IS the end marker must not terminate its own file.
  if (line === POST_TEXT_MARKER || line === POST_TEXT_MARKER + '\r') return true;
  // escapeContent splits on '\n', but the parser splits on /\r?\n/ and drops the \r.
  // Test what the PARSER will see, or a CRLF line that is a header slips through
  // unescaped and becomes a phantom file on restore. The marker is still prefixed to
  // the original line, so the payload's line endings are untouched.
  const asParsed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (findHeaderPath(asParsed, customRegex) === undefined) return false;
  return findHeaderPath(ESCAPE_MARKER + asParsed, customRegex) === undefined;
}

// Inverse of escapeContent: strip exactly one leading marker per line.
function unescapeContent(text: string): string {
  return text
    .split('\n')
    .map(line => (line.startsWith(ESCAPE_MARKER) ? line.slice(ESCAPE_MARKER.length) : line))
    .join('\n');
}

export function parseClipboard(content: string, headerFormat: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const customRegex = toHeaderPattern(headerFormat);
  let currentPath: string | undefined;
  let currentLabels = new Set<ChangeTypeLabel>();
  const currentContent: string[] = [];

  const lines = content.split(/\r?\n/);
  // Drop a leading source-root metadata line so a permissive headerFormat can't
  // turn it into a phantom file. extractSourceRoot() reads it separately.
  if (lines[0]?.startsWith(SOURCE_ROOT_MARKER)) lines.shift();

  const flush = () => {
    if (currentPath === undefined) return;
    entries.push({
      path: currentPath,
      content: unescapeContent(joinContent(currentContent)),
      changeTypes: currentLabels
    });
    currentPath = undefined;
    currentLabels = new Set();
    currentContent.length = 0;
  };

  for (const line of lines) {
    const rawPath = findHeaderPath(line, customRegex);
    // The HEADER wins. Under a permissive format such as `// $FILE_PATH` this very line is
    // the header of a real file named `clipcode-end`, and treating it as the terminator
    // first discarded that file and its body outright. The builder suppresses the marker
    // for exactly those formats, so the two rules never fight over the same line.
    if (rawPath === undefined && line === POST_TEXT_MARKER) {
      // Ends the CURRENT file's body — the footer follows. NOT the whole parse: two
      // payloads pasted back to back is an ordinary thing to do, and stopping here dropped
      // every file in the second one without a word.
      flush();
      continue;
    }
    if (rawPath !== undefined) {
      flush();
      currentLabels = extractLeadingLabels(rawPath);
      currentPath = stripLeadingLabels(rawPath);
      currentContent.length = 0;
    } else if (currentPath !== undefined) {
      currentContent.push(line);
    }
  }

  if (currentPath !== undefined) {
    entries.push({
      path: currentPath,
      content: unescapeContent(joinContent(currentContent)),
      changeTypes: currentLabels
    });
  }

  return entries;
}

// Join accumulated content lines, dropping only the structural blank lines the
// builder injects (empty pre/post wrapper slots and the addExtraLineBetweenFiles
// separator) while preserving the file's own whitespace: leading indentation,
// interior blank lines, and trailing spaces on real lines.
// ponytail: a single content trailing '\n' is indistinguishable on the wire from
// the separator blank, so it is stripped with the structure — lossless requires a
// length/escape token in the header, which would break the cross-tool format.
function joinContent(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && asciiTrim(lines[start]) === '') start++;
  while (end > start && asciiTrim(lines[end - 1]) === '') end--;
  return lines.slice(start, end).join('\n');
}

export function extractLeadingLabels(path: string): Set<ChangeTypeLabel> {
  const prefix = path.match(LEADING_LABEL_PATTERN)?.[0];
  if (!prefix) return new Set();
  return new Set(
    Array.from(prefix.matchAll(LABEL_PATTERN), match => match[1] as ChangeTypeLabel)
  );
}

export function stripLeadingLabels(path: string): string {
  return asciiTrim(path.replace(LEADING_LABEL_PATTERN, ''));
}

function findHeaderPath(line: string, customRegex?: RegExp): string | undefined {
  const customMatch = customRegex?.exec(line);
  if (customMatch?.[1]) return customMatch[1];

  const genericMatch = GENERIC_FILE_HEADER.exec(line);
  if (!genericMatch) return undefined;

  const prefix = genericMatch[1];
  const rawPath = genericMatch[2];
  if (!prefix && !isLikelyBareFileHeaderPath(rawPath)) return undefined;
  return rawPath;
}

function isLikelyBareFileHeaderPath(rawPath: string): boolean {
  const path = asciiTrim(stripLeadingLabels(rawPath));
  if (!path) return false;
  if (path.startsWith('"') || path.startsWith("'")) return false;
  if (path.endsWith(',') || path.endsWith(';')) return false;
  return path.includes('/') || path.includes('\\') || path.includes('.');
}

function toHeaderPattern(headerFormat: string): RegExp | undefined {
  const placeholder = '$FILE_PATH';
  const index = headerFormat.indexOf(placeholder);
  if (index < 0) return undefined;
  const prefix = escapeRegex(headerFormat.slice(0, index));
  const suffix = escapeRegex(headerFormat.slice(index + placeholder.length));
  return new RegExp(`^${prefix}(.+?)${suffix}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
