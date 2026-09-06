# Luna UI handoff — 2026-09-07

Implemented the three scoped UI polish items from `2026-09-07-ui-usability-final.md`.

## Changes

- `graph/src/tree/changes-tree.ts`: repo rows start collapsed, retain native expansion, and show the repo's file count beside branch/ahead-behind summary. Added checked staged file counting for the commit box.
- `graph/src/tree/commit-box-view.ts`, `graph/webview-ui/src/workbench/*`, and all four locale dictionaries: commit scope now reports checked staged repo/file counts near Commit; the host replays the count after tree refresh and checkbox/filter changes.
- `graph/src/panels/DiffPanel.ts`: editor tab title is `Diff: <basename>`; the webview header and tooltip continue to carry the full path.
- `graph/webview-ui/src/components/pr/PrView.svelte`: default file-list width is 280px, directory remains secondary to basename, native diff is a neutral outlined action with tooltip/ARIA label, and PR +/- colors use VS Code theme variables.
- `graph/webview-ui/src/components/commit/FileDiffView.svelte`: hunk actions have a 26px minimum hit area and theme-neutral hover treatment.
- `graph/webview-ui/src/diff/Diff.svelte`: Staged/Unstaged +/- stats have stronger spacing/weight/contrast while using theme colors.
- Focused tests updated for the intentional repo description and commit-state payload changes.

## Verification

- `cd graph && npx vitest run src/tree/__tests__/commit-box-view.test.ts src/tree/__tests__/git-toolbar.test.ts src/tree/__tests__/build-change-tree.test.ts`
  - 3 files passed, 61 tests passed.
- `cd graph/webview-ui && npm run check`
  - `svelte-check found 0 errors and 0 warnings`.
- Follow-up focused tests after parent-suite expectation review:
  - `cd graph && npx vitest run src/panels/__tests__/DiffPanel.test.ts src/tree/__tests__/git-toolbar.test.ts`: 2 files passed, 76 tests passed.
  - `cd graph && npx vitest run --project webview webview-ui/src/components/pr/__tests__/PrView.test.ts`: 1 file passed, 71 tests passed.
  - The tree scope test covers two staged repos (3 files), unchecking one (1 repo/2 files), filtering to one repo, and the clean zero state.
- Native feedback follow-up: repo descriptions now put the file count before branch/ahead-behind text so it remains visible in a narrow sidebar; `git-toolbar.test.ts` passes 51/51.
- Native Diff follow-up: whole-hunk stage/unstage controls now show their localized labels at 0.9 opacity with 26px hit areas; SBS block controls use the same 26px area/visibility. Section +/- stats sit outside the tinted side badge on the editor background with stronger 11px bold styling.
- Final focused UI checks: FileDiffView tests 52/52 passed; `npm run check` reports 0 errors and 0 warnings.
- Updated Diff DOM assertions to locate stats in each section header after moving them outside the side badge. Focused webview run (Diff, FileDiffView lifecycle/unit, PR): 4 files passed, 150 tests passed; `svelte-check` remains 0 errors and 0 warnings.
- Commit completion now refreshes an already-open matching Diff file through `refreshIfCurrent` only after that repo's commit succeeds; failed repos and unrelated files receive no refresh. Backend focused tests: 2 files passed, 55 tests passed, including the regression case.
- `refreshIfCurrent` now reuses `show` quietly (no `reveal`) so commit refreshes cannot steal focus from another editor. DiffPanel tests assert quiet matching refresh, no unrelated refresh, and that nested full paths still reach `diffShow`; DiffPanel + ChangesWorkbench focused run: 77 tests passed.

## Limitations

Native VS Code visual verification, full build/tests, E2E, and packaging remain with the parent agent. No dependency, backend architecture, staging semantics, or date formatting changes were introduced.
