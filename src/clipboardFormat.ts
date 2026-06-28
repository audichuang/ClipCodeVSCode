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
}

const LABELS: ChangeTypeLabel[] = ['NEW', 'MODIFIED', 'DELETED', 'MOVED'];
const LABEL_PATTERN = new RegExp(`\\[(${LABELS.join('|')})\\]`, 'g');
const LEADING_LABEL_PATTERN = new RegExp(`^(?:\\[(${LABELS.join('|')})\\]\\s*)+`);
const GENERIC_FILE_HEADER = /^\s*(?:(\/\/|#|\/\*)\s*)?file:\s*(.+?)\s*(?:\*\/)?$/i;

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
  const lines: string[] = [];
  if (includeEmptyWrappers || options.preText) lines.push(options.preText);

  for (const file of options.files) {
    lines.push(formatHeader(options.headerFormat, file.path, file.changeType));
    lines.push(file.skippedReason ? `// File skipped: ${file.skippedReason}` : file.content ?? '');
    if (options.addExtraLineBetweenFiles) lines.push('');
  }

  if (includeEmptyWrappers || options.postText) lines.push(options.postText);
  return lines.join('\n');
}

export function parseClipboard(content: string, headerFormat: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  const customRegex = toHeaderPattern(headerFormat);
  let currentPath: string | undefined;
  let currentLabels = new Set<ChangeTypeLabel>();
  const currentContent: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const rawPath = findHeaderPath(line, customRegex);
    if (rawPath !== undefined) {
      if (currentPath !== undefined) {
        entries.push({
          path: currentPath,
          content: currentContent.join('\n').trim(),
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
      content: currentContent.join('\n').trim(),
      changeTypes: currentLabels
    });
  }

  return entries;
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
