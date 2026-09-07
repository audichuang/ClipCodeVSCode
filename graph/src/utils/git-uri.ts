/* SNIPCODE-HOOK start: sidebar commit details — toGitUri lifted out of MainPanel so the Recent
   Commits view opens the byte-identical `git:` diff. Whole file is the moved
   upstream body; upstream has no such module, hence the file-level fence. */
import * as vscode from 'vscode';

/**
 * Builds a `git:`-scheme URI in the exact format VS Code's built-in Git
 * extension understands (mirrors its internal `toGitUri`). Using the standard
 * scheme — rather than our own provider — lets the built-in content provider
 * serve the blob and, crucially, lets markdown-diff tooling recognise the
 * comparison: "Reopen editor with…" and extensions like `mddiff` only handle
 * the `git:` scheme. (#51)
 *
 * ref conventions match the built-in extension: '' → index (stage 0),
 * 'HEAD'/<sha>/<sha>~1 → that revision (`git show <ref>:<path>`). The query
 * `path` is the absolute fsPath; the URI path keeps the file extension so the
 * editor still infers the language.
 */
export function toGitUri(fullPath: string, ref: string): vscode.Uri {
  const fileUri = vscode.Uri.file(fullPath);
  return fileUri.with({
    scheme: 'git',
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}
/* SNIPCODE-HOOK end */
