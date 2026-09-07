# Sidebar Recent Commits — verification checkpoint

Date: 2026-09-07. Implementation by Luna, verification and follow-up fixes by the primary agent.

## Result

Added a collapsible Recent Commits view below Commit. It shows the active repository's latest 30 HEAD-history commits, graph lanes, HEAD marker, current branch, working-tree counts and upstream ahead/behind when available. Selecting a repository or refreshing the mini graph keeps the current editor/Diff visible. The full graph opens only through its explicit button.

## Completed checks

- Host: 185 passed, 0 failed.
- Full graph Vitest: 2,394 passed, 11 skipped (159 files).
- Svelte check: 0 errors, 0 warnings. Graph TypeScript check passed.
- Local VS Code E2E: 7 passed. These are the existing extension smoke tests, not full coverage of the new sidebar UI.
- VSIX packaging succeeded; packaged host and all six main/workbench/diff JS/CSS assets match the tested build.
- Native VS Code: Commit and Recent mount together; selecting a Changes repository/file updates the mini graph; opening a SQL Diff in cat keeps both visible.
- Native VS Code: fold/unfold, refresh and repository selection preserve Diff; the explicit full-graph icon opens Graph+, and closing Graph+ returns to Diff.
- Disposable Git fixtures: tracked branch displays ahead 1 / behind 0; a branch with 35 newer unrelated commits does not displace current HEAD history; a seven-parent merge fits within the compact graph rail; an unborn repository shows the no-commits state and retains a usable repository picker.
- Corrected the status summary so missing upstream does not imply a clean working tree; added a regression test. HEAD ring padding and row alignment are also covered.

## Remaining verification

The user requested a checkpoint and commit/push before the last native checks were finished. New-sidebar first-commit refresh and Light Modern / High Contrast Light / High Contrast Dark visual checks remain pending. Dark Modern was inspected natively. Do not interpret the automated passes as proof that all visual states are flawless.

Cat was used for read-only navigation; Git mutation scenarios use disposable repositories under /tmp/snipcode-live-qa/fixtures. No final claim is made that other processes left cat unchanged.

Artifact: `clipcode-vscode-0.3.42-sidebar-graph-unreleased.vsix`. Version remains 0.3.42; no release tag is created.
