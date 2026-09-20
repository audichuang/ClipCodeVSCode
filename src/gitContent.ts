import path from 'node:path';
import { decodeUtf8OrSkip } from './fileSystem.js';

export interface ContentRepo {
  rootUri: { fsPath: string };
  show?: (ref: string, path: string) => Promise<string>;
  buffer?: (ref: string, path: string) => Promise<Uint8Array>;
}

export function normalizeFsPath(value: string): string {
  // A COMPARISON KEY only — it case-folds on win32, so it must never be returned as a
  // path. Trims a trailing separator so a repo root like '/repo/' compares equal to '/repo'.
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function repoRelativePath(repoRootFsPath: string, fileFsPath: string): string {
  // path.relative, NOT a slice of normalizeFsPath's output. normalizeFsPath lowercases on
  // win32 — correct for a comparison KEY, wrong for a value we hand to git: this returned
  // `src/myfile.ts` for `src/MyFile.ts` on Windows only, and `git show <ref>:<path>` looks
  // up tree entries byte-exactly no matter what core.ignorecase says, so every mixed-case
  // file missed on its first candidate. The bug could not surface on Linux or macOS CI, and
  // test/gitContent.test.ts uses all-lowercase POSIX paths, so nothing caught it.
  // Case-folding for comparison stays in normalizeFsPath; this returns the real spelling.
  return path.relative(repoRootFsPath, fileFsPath).split(path.sep).join('/');
}

export function decodeText(bytes: Uint8Array): string | undefined {
  // Shared with readTextFile: a non-UTF-8 blob is skipped, never decoded to U+FFFD mojibake
  // and then written back over the real file on restore.
  return decodeUtf8OrSkip(bytes);
}

export function isTextContent(content: string | undefined): content is string {
  return content !== undefined && !content.includes('\0');
}

export async function readRefContent(
  repo: ContentRepo,
  ref: string,
  fileFsPath: string
): Promise<string | undefined> {
  const relative = repoRelativePath(repo.rootUri.fsPath, fileFsPath);
  const candidates = [...new Set([relative, fileFsPath].filter(Boolean))];

  for (const candidate of candidates) {
    // buffer() FIRST: it is the only entry point that still has bytes to validate. show()
    // returns an already-decoded string, and the real Git API decodes leniently — bytes the
    // strict decoder rejects come back as U+FFFD mojibake, which restore then writes over
    // the real file. Asking show() first meant every History / SCM / per-file Git copy
    // silently skipped the UTF-8 guard the disk path enforces.
    if (repo.buffer) {
      const bytes = await repo.buffer(ref, candidate).catch(() => undefined);
      if (bytes) {
        // Bytes in hand, so this decode is the verdict for this file — falling through to
        // show() here would hand back exactly the mojibake just refused.
        const text = decodeText(bytes);
        return isTextContent(text) ? text : undefined;
      }
    }
    // Only when buffer() is unavailable or has no bytes for this spelling. A string carries
    // no bytes to check, so this path cannot enforce the guard — it is the documented
    // residual, not a shortcut.
    if (repo.show) {
      const shown = await repo.show(ref, candidate).catch(() => undefined);
      if (isTextContent(shown)) return shown;
    }
  }
  return undefined;
}
