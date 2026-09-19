import { decodeUtf8OrSkip } from './fileSystem.js';

export interface ContentRepo {
  rootUri: { fsPath: string };
  show?: (ref: string, path: string) => Promise<string>;
  buffer?: (ref: string, path: string) => Promise<Uint8Array>;
}

export function normalizeFsPath(value: string): string {
  // Trim a trailing separator so a repo root like '/repo/' compares equal to
  // '/repo' (resolveRepo) and repoRelativePath's slice(length+1) stays correct.
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function repoRelativePath(repoRootFsPath: string, fileFsPath: string): string {
  const relativePath = normalizeFsPath(fileFsPath).slice(normalizeFsPath(repoRootFsPath).length + 1);
  return relativePath.replaceAll('\\', '/');
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
    if (repo.show) {
      const shown = await repo.show(ref, candidate).catch(() => undefined);
      if (isTextContent(shown)) return shown;
    }
    if (repo.buffer) {
      const bytes = await repo.buffer(ref, candidate).catch(() => undefined);
      const text = bytes ? decodeText(bytes) : undefined;
      if (isTextContent(text)) return text;
    }
  }
  return undefined;
}
