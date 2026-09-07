# Loading / UI fixes — verification

Base: `8e9f2d8`. Implementation delegated to Luna; primary agent reviews the patch and verifies the production build in native VS Code. Scope is the six findings in `2026-09-07-loading-ui-review.md`, plus a visible current repository name.

## Verification cases

- Progressive repository display remains available, while incomplete commit scope cannot be committed or amended through UI or host commands. Overlapping refreshes must not unlock prematurely or remain locked forever.
- Added, deleted, renamed and initial-commit files open as read-only historical diffs. Multi-diff preserves original/modified sides; merge comparisons use the actual selected parent.
- Navigate to the fourth hunk, collapse Unstaged to leave one hunk, then navigate again. Counts remain valid and no missing DOM element is dereferenced. Repeat across inline/side-by-side and data refresh.
- Tab to the inline Open File action, press Enter/Space: open the working file, not historical Diff.
- Hide/reveal while commit files are pending: the missing reply is recovered without unbounded retry loops or stale repository results.
- Dark Modern, Light Modern and High Contrast Light: counter text and current repository remain readable at sidebar widths used in practice.

Native mutation fixtures live under `/tmp/snipcode-loading-fixes-qa/native-cases`; cat is used only for read-only navigation. The fixture has one staged and three unstaged hunks, plus separate add/delete/rename commits. The unmodified build reproduced the invalid hunk count before the fix.

## Results

Completed on macOS against the production host/webview build.

| Check | Result |
|---|---|
| Host | 185 passed, 0 failed |
| Graph | 2,463 passed, 11 skipped; all 162 files passed |
| Svelte / graph TypeScript | 0 errors; Svelte also 0 warnings |
| Existing native VS Code E2E | 7 passed |
| Packaging | VSIX created; host and every packaged webview asset byte-match the tested build |

The six findings are addressed. Luna implemented the UI changes and focused tests. During review, the primary agent simplified the backend readiness state to reuse the tree's existing SequenceGuard, completed the shared missing-side comparison, and added real-Git and provider regressions.

- **Commit scope:** readiness starts false and becomes true only after the latest complete tree snapshot is published. Both UI and host reject early Commit/Amend. The real-Git blocked-status test proves neither repo changes while the partial tree shows one repo; both can commit once the full two-repo scope is available. Separate tests cover both overlapping completion orders and a failed refresh following a successful one. Progressive display is retained.
- **Historical Diff:** native single and multi-diff now open non-root added/deleted files; rename and initial-commit comparisons also opened correctly. Empty single-diff sides use the repository's empty-tree revision, preserving `git:` read-only behavior. Multi-diff preserves the positional three-element tuple with absent sides undefined. Merge parent/path/existence is checked by real-Git regression tests; the native walkthrough used ordinary add/delete/rename/root commits.
- **Original cat reproduction:** cub-mock-gateway `55c0bc2`, `sql/seed-filegrep-route.sql`, now opens with an empty left side and SQL content on the right, replacing the previous File Not Found screen.
- **Navigation:** four-hunk fixture → last hunk → collapse Unstaged → Next produces `1/1` with Previous disabled. Expanding and switching to side-by-side produces the correct four-hunk set. No stale-target error occurred.
- **Keyboard:** Tab to the inline Open File action then Enter opened the working `added.txt` editor, without a historical hash. A focused regression also covers bubbled keyboard activation.
- **Hidden request recovery:** deterministic component tests exercise the 200ms visible-state case, one delayed retry, no repeating timer, and no resend after a reply. This timing race is covered by controlled tests, not claimed as a native delayed-Git reproduction.
- **Real mutation/refresh:** clicked Stage Hunk, then Commit in the disposable repository. Commit `0760c18` contains only the two staged changes; two working changes remain. The sidebar immediately shows the new HEAD, commit scope becomes 0/0, and the still-selected Diff updates to two remaining hunks.
- **Visual inspection:** Dark Modern, Light Modern and Default High Contrast Light were viewed natively. The HC count uses white badge text; the active repo name occupies its own ellipsized line and stays readable alongside counts at approximately 240px and 350px sidebar widths.

Artifact: `clipcode-vscode-0.3.45-loading-ui-fixes-unreleased.vsix`. Version remains 0.3.45. No tag, release, commit or push was performed for these fixes. The development host is left on cat with Dark Modern restored.

Cat was not edited or committed by this work. All 25 baseline repository HEADs and staged diffs match the pre-verification snapshot. `inv-svc-bfs-query` changed its working-tree/status during the session without this agent operating on it; the other 24 baseline repositories match. The snapshot checks do not hash untracked-file contents.
