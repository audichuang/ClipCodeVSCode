import * as path from 'path';

/** Resolve a webview-supplied repo-relative path and assert it stays inside
 *  the repository root. Throws on traversal attempts (`../etc/passwd`) or
 *  absolute paths.
 *  Returns the absolute resolved path. */
export function resolveRepoRelativePath(repoPath: string, rel: unknown, op: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`Invalid path for ${op}`);
  }
  const fullPath = path.resolve(repoPath, rel);
  const fromRoot = path.relative(repoPath, fullPath);
  if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
    throw new Error(`Path escapes repository: ${rel}`);
  }
  return fullPath;
}

/** Validate a path that will be passed to git as a positional argument
 *  (worktree destinations, etc.). Rejects values that look like CLI options
 *  to prevent argument injection (`--upload-pack=...`, `-x`). */
export function assertSafeArgPath(p: unknown, op: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error(`Invalid path for ${op}`);
  }
  if (p.startsWith('-')) {
    throw new Error(`Path may not start with '-': ${p}`);
  }
  return p;
}
