/**
 * Compare two filesystem paths for equality, tolerating the format differences
 * that arise between VS Code's `Uri.fsPath` (backslashes on Windows) and git's
 * `rev-parse --show-toplevel` output (forward slashes, lowercase drive letter).
 *
 * Without this, the repository dropdown matched the active repo by exact string
 * equality and fell back to `repos[0]` whenever the formats disagreed — showing
 * the wrong repository on Windows. See issue #30.
 */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  if (!a || !b) { return false; }
  return normalize(a) === normalize(b);
}
