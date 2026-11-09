import { createHash } from 'node:crypto';

// Non-text files (images, archives, Big5/UTF-16 text...) carried as Base64 in files mode.
// Spec: non-text-files.md. Mirror of OpenIDEA crates/ide-clip/src/nontext.rs; the wire
// bytes are pinned by test/fixtures/clipboard-contract.json (nonTextBuildCases).

/** Base64 characters per line in files mode. */
export const BASE64_LINE_LEN = 76;

// `[0-9]`, never `\d`: keep the digit class ASCII on every implementation.
const PLACEHOLDER_LINE = /^\/\/ File skipped: non-text file, ([0-9]+) bytes, sha256 ([0-9a-f]{64}); base64 follows$/;
const MAX_U64 = (1n << 64n) - 1n;
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;
const ASCII_WS_ALL = /[ \t\n\v\f\r]+/g;

export type NonTextError = 'base64' | 'size' | 'sha256';
export type NonTextParse = { bytes: Uint8Array } | { error: NonTextError };

export interface NonTextHeader {
  size: number;
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The first body line of a files-mode non-text entry. */
export function placeholderLine(size: number, sha256: string): string {
  return `// File skipped: non-text file, ${size} bytes, sha256 ${sha256}; base64 follows`;
}

/** Standard padded Base64 split into lines of at most BASE64_LINE_LEN characters. */
export function base64Lines(bytes: Uint8Array): string[] {
  const flat = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < flat.length; i += BASE64_LINE_LEN) lines.push(flat.slice(i, i + BASE64_LINE_LEN));
  return lines;
}

/** Standard Base64 wrapped at BASE64_LINE_LEN, lines joined by `\n`. */
export function encodeWrapped(bytes: Uint8Array): string {
  return base64Lines(bytes).join('\n');
}

/** Recognizes the placeholder line (one trailing `\r` is dropped first). */
export function parsePlaceholderLine(line: string): NonTextHeader | undefined {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  const match = PLACEHOLDER_LINE.exec(stripped);
  if (!match) return undefined;
  if (BigInt(match[1]) > MAX_U64) return undefined;
  return { size: Number(match[1]), sha256: match[2] };
}

/**
 * Strict Base64 decode. Node's Buffer.from(s, 'base64') is lenient (it accepts missing
 * padding, stray characters and non-zero trailing bits), so the input is validated first
 * and the decoded bytes must re-encode to exactly the same text.
 */
export function decodeStrictBase64(text: string): Uint8Array | undefined {
  const compact = text.replace(ASCII_WS_ALL, '');
  if (!BASE64_ALPHABET.test(compact) || compact.length % 4 !== 0) return undefined;
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.toString('base64') !== compact) return undefined;
  return new Uint8Array(decoded);
}

/** Decodes strictly, then checks the length and SHA-256 against the placeholder header. */
export function decodeVerified(base64Text: string, header: NonTextHeader): NonTextParse {
  const bytes = decodeStrictBase64(base64Text);
  if (!bytes) return { error: 'base64' };
  if (bytes.length !== header.size) return { error: 'size' };
  if (sha256Hex(bytes) !== header.sha256) return { error: 'sha256' };
  return { bytes };
}

/**
 * A parsed (already un-escaped) entry body: undefined when it is not a non-text entry,
 * else its verified bytes or why they are corrupt.
 */
export function parseBody(content: string): NonTextParse | undefined {
  const newline = content.indexOf('\n');
  const first = newline === -1 ? content : content.slice(0, newline);
  const rest = newline === -1 ? '' : content.slice(newline + 1);
  const header = parsePlaceholderLine(first);
  if (!header) return undefined;
  return decodeVerified(rest, header);
}
