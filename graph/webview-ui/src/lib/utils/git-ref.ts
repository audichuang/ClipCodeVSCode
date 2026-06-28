/** True when `ref` looks like an (abbreviated or full) commit hash: 7-40 hex
 *  chars. Used to pick a commit vs branch icon for a ref pill. */
export function isCommitHash(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

/** Abbreviate a full 40-char hash to 7 chars; leave branch/tag names and
 *  already-short refs untouched. */
export function shortenRef(ref: string): string {
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.substring(0, 7) : ref;
}

/**
 * Validate a git ref name (branch, tag) against git's check-ref-format rules.
 * Returns null if valid, or an error key (i18n) if invalid.
 *
 * Rules enforced (subset of `git check-ref-format` that catches the common mistakes):
 *  - Non-empty
 *  - No ASCII control chars or DEL
 *  - No whitespace
 *  - No `^ ~ : ? * [ \`
 *  - No `..`, no `@{`
 *  - Cannot start with `-` or `.`, cannot end with `.` or `/`
 *  - Cannot end with `.lock`
 *  - Cannot be exactly `@`
 *  - Per slash-separated component: non-empty, cannot start with `.`, cannot end with `.lock`
 */
export function validateGitRefName(name: string): string | null {
  if (!name || name.length === 0) { return 'gitRef.empty'; }
  if (name === '@') { return 'gitRef.atOnly'; }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(name)) { return 'gitRef.whitespaceOrControl'; }
  if (/[\^~:?*\[\\]/.test(name)) { return 'gitRef.forbiddenChars'; }
  if (name.includes('..') || name.includes('@{')) { return 'gitRef.forbiddenSequence'; }
  if (name.startsWith('-') || name.startsWith('.') || name.startsWith('/')) { return 'gitRef.badStart'; }
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) { return 'gitRef.badEnd'; }
  // Per-component checks: git rejects empty components (//), component starting
  // with `.` (foo/.bar) or ending with .lock (foo.lock/bar).
  for (const part of name.split('/')) {
    if (part.length === 0) { return 'gitRef.badEnd'; }
    if (part.startsWith('.')) { return 'gitRef.badStart'; }
    if (part.endsWith('.lock')) { return 'gitRef.badEnd'; }
  }
  return null;
}
