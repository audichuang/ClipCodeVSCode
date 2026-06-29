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
const LABEL_PATTERN = new RegExp(`\\[(${LABELS.join('|')})\\]`, 'g');
const LEADING_LABEL_PATTERN = new RegExp(`^(?:\\[(${LABELS.join('|')})\\]\\s*)+`);
const GENERIC_FILE_HEADER = /^\s*(?:(\/\/|#|\/\*)\s*)?file:\s*(.+?)\s*(?:\*\/)?$/i;
// Scheme A marker — MUST match the Kotlin side byte-for-byte (see notes).
// Distinctive enough that a real source line virtually never starts with it, so
// the unconditional strip on read can't corrupt foreign/old clipboards. Must be
// byte-identical to the Kotlin ClipCode mirror or cross-tool restore breaks.
const ESCAPE_MARKER = '//clipcode-esc: ';

// Leading metadata line: records the source root folder name so restore can align
// folder levels. It sits before the first file header, so the parser ignores it as
// pre-header text; only extractSourceRoot() reads it (from line 1).
const SOURCE_ROOT_MARKER = '// clipcode-root: ';

/** Read the source-root metadata from the first line, if present. */
export function extractSourceRoot(clipboardText: string): string | undefined {
  const firstLine = clipboardText.slice(0, clipboardText.indexOf('\n') === -1 ? undefined : clipboardText.indexOf('\n'));
  if (!firstLine.startsWith(SOURCE_ROOT_MARKER)) return undefined;
  const value = firstLine.slice(SOURCE_ROOT_MARKER.length).trim();
  return value || undefined;
}

export function formatHeader(
  headerFormat: string,
  clipboardPath: string,
  changeType?: ChangeTypeLabel
): string {
  const pathWithLabel = changeType ? `[${changeType}] ${clipboardPath}` : clipboardPath;
  return headerFormat.replaceAll('$FILE_PATH', pathWithLabel);
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

  if (includeEmptyWrappers || options.postText) lines.push(escapeContent(options.postText, customRegex));
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
  if (findHeaderPath(line, customRegex) === undefined) return false;
  return findHeaderPath(ESCAPE_MARKER + line, customRegex) === undefined;
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

  for (const line of lines) {
    const rawPath = findHeaderPath(line, customRegex);
    if (rawPath !== undefined) {
      if (currentPath !== undefined) {
        entries.push({
          path: currentPath,
          content: unescapeContent(joinContent(currentContent)),
          changeTypes: currentLabels
        });
      }
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
  while (start < end && /^\s*$/.test(lines[start])) start++;
  while (end > start && /^\s*$/.test(lines[end - 1])) end--;
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
  return path.replace(LEADING_LABEL_PATTERN, '').trim();
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
  const path = stripLeadingLabels(rawPath).trim();
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
