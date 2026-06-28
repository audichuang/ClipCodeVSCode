// Resolved path to the git executable used for every spawned git process.
//
// Defaults to `'git'` (looked up on PATH). When git is not on PATH — common on
// Windows with portable/MSYS2 installs — the extension host resolves the
// VS Code `git.path` setting (or the built-in git extension's resolved path)
// during activation and stores it here so all spawn sites pick it up. See #18.
//
// This module is intentionally free of any `vscode` import so GitService and
// the other git callers stay unit-testable. The vscode-aware resolution lives
// in the extension entry point, which calls `setGitBinaryPath`.

let gitBinaryPath = 'git';

/** The git executable to spawn. */
export function getGitBinaryPath(): string {
  return gitBinaryPath;
}

/**
 * Set the git executable path. A nullish or blank value resets to the default
 * PATH lookup (`'git'`).
 */
export function setGitBinaryPath(p: string | undefined | null): void {
  gitBinaryPath = p && p.trim() ? p : 'git';
}
