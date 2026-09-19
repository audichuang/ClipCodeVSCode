import { lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export async function readTextFile(filePath: string): Promise<string | undefined> {
  const bytes = await readFile(filePath);
  return decodeUtf8OrSkip(bytes);
}

/**
 * A non-UTF-8 text file (Big5, Shift_JIS, latin-1) used to decode with fatal:false, so every
 * undecodable byte became U+FFFD and Paste & Restore wrote that mojibake back over the real
 * file. Skipping such a file is strictly better than destroying it: undefined is the same
 * "not copyable as text" signal binary files already use.
 */
export function decodeUtf8OrSkip(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    // ignoreBOM: TextDecoder otherwise SWALLOWS a leading U+FEFF, so `EF BB BF 61 62 63`
    // decoded to "abc" here and "\uFEFFabc" in Kotlin — different payload bytes for the
    // same file, and this side quietly dropping a BOM the file really has.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * 8 MiB. A restore target larger than this is not something a clipboard payload should be
 * replacing unasked, and reading it whole just to inspect its encoding is a bigger cost
 * than the check is worth — so it is reported as unverifiable rather than read.
 */
const ENCODING_CHECK_LIMIT = 8 * 1024 * 1024;

export type TargetEncoding = 'absent' | 'utf8' | 'other' | 'unverifiable';

/**
 * What is on disk at [filePath] right now.
 *
 * Writing UTF-8 over a Big5 / Shift_JIS / UTF-16 file changes its encoding with nothing
 * said, and the wire format carries no encoding, so nothing can put the original bytes
 * back. The check therefore fails CLOSED: a file we could not read, or one too large to
 * read, is `unverifiable` and must not be overwritten either. Treating a failed read as
 * "not non-UTF-8" authorised overwriting exactly the files we could say least about.
 * Mirror of RestorePlan.targetEncoding.
 */
export async function targetEncoding(filePath: string): Promise<TargetEncoding> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return 'absent'; // nothing to clobber
  }
  if (!info.isFile()) return 'absent';
  if (info.size > ENCODING_CHECK_LIMIT) return 'unverifiable';
  try {
    return decodeUtf8OrSkip(await readFile(filePath)) === undefined ? 'other' : 'utf8';
  } catch {
    return 'unverifiable';
  }
}

/** True when the bytes on disk must not be replaced with UTF-8 text. */
export async function mustNotOverwrite(filePath: string): Promise<boolean> {
  const encoding = await targetEncoding(filePath);
  return encoding === 'other' || encoding === 'unverifiable';
}

export async function* listFilesRecursive(
  inputPath: string,
  // 目錄級剪枝（回傳 false 就整棵子樹不走）。被 PATH exclude 規則命中的目錄，
  // 其下所有檔案必然也被同一規則排除，走完再逐檔過濾是純浪費 —
  // node_modules 這種大樹要在這裡就剪掉（對齊 IntelliJ 端 processDirectory 的行為）。
  shouldEnterDirectory?: (dirPath: string) => boolean,
  // True only for a path the user actually picked. A directory symlink is walked when it
  // IS the selection — right-clicking a linked folder used to copy NOTHING — but is never
  // followed during recursion. Following them everywhere looks like parity with IntelliJ
  // and is a trap: a cross-linked tree (pnpm's .pnpm store, Bazel) has a path count that
  // grows like a sum of falling factorials — 7 linked dirs already yield 13,699 paths, and
  // with the default 30-file limit the "copy" is 30 aliases of the same few files while
  // the rest of the real tree is dropped. The real packages are reached through their own
  // directories anyway.
  isSelection = true,
  // A subtree we could not read is an omission the user must hear about; the per-file
  // counter never sees it because no file is ever yielded.
  onUnreadable?: (dirPath: string) => void
): AsyncGenerator<string> {
  const info = await lstat(inputPath).catch(() => undefined);
  if (!info) return;

  let isDirectory = info.isDirectory();
  if (info.isSymbolicLink()) {
    const target = await stat(inputPath).catch(() => undefined);
    if (!target?.isDirectory()) {
      yield inputPath;
      return;
    }
    if (!isSelection) return;
    isDirectory = true;
  } else if (!isDirectory) {
    yield inputPath;
    return;
  }

  if (shouldEnterDirectory && !shouldEnterDirectory(inputPath)) return;

  // An unreadable directory must cost its own subtree, not the whole copy: an unguarded
  // readdir threw EACCES out of collectCopyFiles and nothing at all reached the clipboard.
  const entries = await readdir(inputPath).catch(() => undefined);
  if (!entries) {
    onUnreadable?.(inputPath);
    return;
  }
  for (const entry of entries.sort()) {
    yield* listFilesRecursive(path.join(inputPath, entry), shouldEnterDirectory, false, onUnreadable);
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}
