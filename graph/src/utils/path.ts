/**
 * Compare two filesystem paths for equality, tolerating the format differences
 * that arise between VS Code's `Uri.fsPath` (backslashes on Windows, and a
 * possibly different drive-letter case) and git's `rev-parse --show-toplevel`
 * output (forward slashes, lowercase drive). Without this, comparing the two by
 * exact string — or by `path.resolve`, which normalizes separators but not case
 * — silently fails on Windows and points the UI at the wrong repository.
 *
 * Mirrors the case-insensitive normalization already used for repo de-duplication
 * in RepoDiscoveryService. See issue #30.
 */
function canonical(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  if (!a || !b) { return false; }
  return canonical(a) === canonical(b);
}
