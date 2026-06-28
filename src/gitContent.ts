export interface ContentRepo {
  rootUri: { fsPath: string };
  show?: (ref: string, path: string) => Promise<string>;
  buffer?: (ref: string, path: string) => Promise<Uint8Array>;
}

export function normalizeFsPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function repoRelativePath(repoRootFsPath: string, fileFsPath: string): string {
  const relativePath = normalizeFsPath(fileFsPath).slice(normalizeFsPath(repoRootFsPath).length + 1);
  return relativePath.replaceAll('\\', '/');
}

export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
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
