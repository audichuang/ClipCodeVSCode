import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
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

export type FileContent = { text: string } | { nonText: Uint8Array };

/** Reads a file and classifies it: strict UTF-8 without NUL is text, anything else non-text. */
export async function readClassifiedFile(filePath: string): Promise<FileContent> {
  return classifyBytes(new Uint8Array(await readFile(filePath)));
}

/**
 * The one text / non-text verdict every copy surface uses (files, SCM, Graph, History):
 * strict UTF-8 without NUL is text, anything else is carried as its raw bytes.
 */
export function classifyBytes(bytes: Uint8Array): FileContent {
  const text = decodeUtf8OrSkip(bytes);
  return text === undefined ? { nonText: bytes } : { text };
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

export interface WalkOptions {
  // 目錄級剪枝（回傳 false 就整棵子樹不走）。被 PATH exclude 規則命中的目錄，
  // 其下所有檔案必然也被同一規則排除，走完再逐檔過濾是純浪費 —
  // node_modules 這種大樹要在這裡就剪掉（對齊 IntelliJ 端 processDirectory 的行為）。
  shouldEnterDirectory?: (dirPath: string) => boolean;
  // A subtree we could not read is an omission the user must hear about; the per-file
  // counter never sees it because no file is ever yielded.
  onUnreadable?: (dirPath: string) => void;
  // A symlink to a directory is NEVER walked — not when it is the selection, not when it
  // is met during recursion — and is reported here instead (spec non-text-files.md "What
  // is carried", user decision D2 of 2026-11-09). Walking links is a trap: a cross-linked
  // tree (pnpm's .pnpm store, Bazel) has a path count that grows like a sum of falling
  // factorials — 7 linked dirs already yield 13,699 paths — and with the default 30-file
  // limit the copy becomes 30 aliases of the same few files. A symlink to a FILE is still
  // followed: it is yielded and its target's bytes are read under the link's path.
  onSymlinkedFolder?: (linkPath: string) => void;
  // A directory entry whose name is not valid UTF-8. A string readdir would hand back a
  // lossy U+FFFD spelling that no longer opens, so the entry vanished silently mid-walk.
  // It is reported here with that lossy spelling and neither yielded nor walked.
  onNonUtf8Name?: (lossyPath: string) => void;
  // The one exception to the symlinked-folder rule: the selected path is a workspace root
  // that is itself a link (VS Code keeps the link path for a folder opened through one).
  // It is walked like a real folder; links met inside it are still skipped.
  walkSelectedLink?: boolean;
  // Checked before every entry, skipped ones included: the caller's way to end a walk that
  // yields nothing (a run of symlinked, unreadable or pruned folders).
  shouldStop?: () => boolean;
}

export async function* listFilesRecursive(
  inputPath: string,
  options: WalkOptions = {},
  // True only for a path the user actually picked: a picked path that is gone is reported
  // as unreadable, a mid-walk race stays silent.
  isSelection = true
): AsyncGenerator<string> {
  const { shouldEnterDirectory, onUnreadable, onSymlinkedFolder, onNonUtf8Name, shouldStop } = options;
  if (shouldStop?.()) return;
  const info = await lstat(inputPath).catch(() => undefined);
  if (!info) {
    // A picked path that is gone (an open tab whose file was deleted, a selection removed
    // before the copy ran) is an omission too. Mid-walk races stay silent.
    if (isSelection) onUnreadable?.(inputPath);
    return;
  }

  if (info.isSymbolicLink()) {
    // A dangling link fails stat and is yielded: the read fails and it is named Unreadable.
    const target = await stat(inputPath).catch(() => undefined);
    if (!target?.isDirectory()) {
      yield inputPath;
      return;
    }
    if (!(isSelection && options.walkSelectedLink)) {
      // A link the exclude rules prune is as silent as a pruned real folder.
      if (shouldEnterDirectory && !shouldEnterDirectory(inputPath)) return;
      onSymlinkedFolder?.(inputPath);
      return;
    }
  } else if (!info.isDirectory()) {
    yield inputPath;
    return;
  }

  if (shouldEnterDirectory && !shouldEnterDirectory(inputPath)) return;

  // An unreadable directory must cost its own subtree, not the whole copy: an unguarded
  // readdir threw EACCES out of collectCopyFiles and nothing at all reached the clipboard.
  const raw = await readdir(inputPath, { encoding: 'buffer' }).catch(() => undefined);
  if (!raw) {
    onUnreadable?.(inputPath);
    return;
  }
  const entries = raw.map(bytes => ({ name: bytes.toString('utf8'), bytes }));
  const inner = { ...options, walkSelectedLink: false };
  for (const { name, bytes } of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (shouldStop?.()) return;
    const entryPath = path.join(inputPath, name);
    if (!Buffer.from(name, 'utf8').equals(bytes)) {
      onNonUtf8Name?.(entryPath);
      continue;
    }
    yield* listFilesRecursive(entryPath, inner, false);
  }
}

/** Writes UTF-8 text by replacing the directory entry; see writeBytesFile. */
export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await writeBytesFile(filePath, Buffer.from(content, 'utf8'));
}

/**
 * Writes [bytes] by REPLACING the directory entry, creating missing parent folders: a
 * temporary file in the same folder is written (owner-only meanwhile), given the old
 * file's permission mode (or the umask default for a new file), synced and renamed over
 * [filePath]. A hard link or symlink at [filePath] is never
 * written through — writing in place rewrote the file a hard link's OTHER name holds,
 * outside the workspace too. The temporary file is removed when anything fails.
 * Mirror of OpenIDEA fsutil.rs write_bytes_file.
 */
export async function writeBytesFile(filePath: string, bytes: Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  // Exclusive create under a fresh random name: never an existing entry or link.
  const temp = path.join(dir, `.snip-write.${randomBytes(8).toString('hex')}`);
  // Owner-only while the bytes land: created at 0o666 the temp held a 0600 file's content
  // world-readable until the chmod below.
  const handle = await open(temp, 'wx', 0o600);
  let renamed = false;
  try {
    try {
      await handle.writeFile(bytes);
      const existing = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      // An existing file keeps its mode; anything else gets what a plain create would.
      await handle.chmod(existing?.isFile() ? existing.mode & 0o7777 : 0o666 & ~process.umask());
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, filePath);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temp).catch(() => undefined);
  }
}

/**
 * Whether the regular file at [filePath] holds exactly [bytes] (size first, so a
 * different-sized file is not read). Mirror of OpenIDEA restore.rs holds_bytes.
 */
export async function holdsBytes(filePath: string, bytes: Uint8Array): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== bytes.length) return false;
    return Buffer.from(bytes).equals(await readFile(filePath));
  } catch {
    return false;
  }
}

export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}
