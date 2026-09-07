# Native Diff / F4 review

Reviewed the uncommitted changes against `f6a92fa` on 2026-09-08. Product files and user settings were not modified by this review. Disposable Git fixtures live under `/tmp/snipcode-native-f4-review`.

## Verdict

The implementation is not ready to be called fully verified. The intended shared native opener and per-side rename lookup are present, but four P2 issues remain despite the existing suite passing.

## Standards / latest-request safety

### P2 — A delayed native-open request can reclaim the editor after navigation

`graph/src/panels/DiffPanel.ts:261–262` checks the current file/generation before calling `openNativeDiff`. That method awaits status at line 487 and may await opening a document at line 514, then executes `vscode.diff` at line 526 without another guard.

Deterministic reproduction: hold A's status response after a valid F4 request, navigate the panel to B, then release A. The current file is B, but `vscode.diff` still opens A. A temporary targeted test asserted this incorrect behavior and passed; the temporary repo test file was removed. Evidence is `/tmp/snipcode-native-race-review.log` and `/tmp/snipcode-native-race-review.test.ts`.

Use a latest-request token covering the asynchronous opener and recheck the target/generation immediately before revealing. Native-default clicks also need ordering protection, not only F4 messages.

## Spec / UI

### P2 — F4 remains hardcoded despite the configurable command

`graph/webview-ui/src/diff/Diff.svelte:154–158` directly handles F4 in a window keydown listener while `package.json` also registers the command/keybinding. Removing or rebinding the VS Code shortcut therefore does not remove the webview behavior. This contradicts the configurable-shortcut requirement; there are also two potential activation routes.

Keep one command-driven route through `requestJumpToSource`, and verify the focus context as well as remapping/removal. This finding is based on the explicit source path, not a claimed native keymap-removal test.

### P2 — The first staged file in an unborn repo still cannot open

`DiffPanel.ts:493–495` always uses HEAD for the staged left side. The provider's new regex at line 100 does not cover what the actual content command returns:

```text
git show HEAD:review.txt
fatal: invalid object name 'HEAD'.
```

Native reproduction: initialize an empty repo, write and stage `review.txt`, set `snipcode.changes.defaultDiffViewer` to native, and click the staged file. VS Code displays an unexpected-error editor. The renderer log confirms `git show HEAD:review.txt` exited 128 with the error above.

The added test mocks the no-commits message emitted by a different Git command, so it does not exercise this failure. Resolve confirmed missing HEAD/absent content explicitly to the empty virtual document; do not keep expanding a broad swallow-error regex.

### P2 — Staged-only F4 assumes a working file exists

`graph/webview-ui/src/diff/messaging.ts:151` always sends `side: 'unstaged'`. For a staged-only deletion, `openNativeDiff` finds no unstaged D entry and selects a real `file:` URI even though that file was deleted.

Native reproduction: commit a file, run `git rm`, open its Staged custom Diff, and press F4. It opens `review.txt (Working Tree)` and fails with **“The editor could not be opened because the file was not found.”** For staged-only modifications it also opens index-versus-working, which can be identical rather than showing the staged change.

Define the staged-only and missing-working-file behavior explicitly. Use a readonly comparison/empty side or report that there is no editable working file; do not blindly turn every jump into an unstaged comparison.

## Verification completed

- Full graph suite: **2,488 passed, 11 skipped**, all 163 files passed.
- Svelte check: **0 errors / 0 warnings**.
- Graph TypeScript check: passed.
- Root webview/host production builds: passed.
- Real Git and native VS Code both reproduced the unborn HEAD failure.
- Native VS Code reproduced the staged-deletion F4 failure.
- Targeted deterministic test reproduced the delayed-open race.
- User settings were inspected read-only: no top-level `diffEditor.*` color overrides remain; all five are under `[Islands Dark]`; `diffEditor.renderSideBySideInlineBreakpoint` is removed. This cleanup matches the plan.

Not independently certified here: native remapping/removal of F4, exact right-editor caret placement across every rename/selection scenario, and all conflict/binary cases. Existing green tests must not be presented as coverage of those scenarios.

Totals: Standards/latest-request safety **1 P2**; Spec/UI **3 P2**. No Git mutation was performed in cat. Native failure fixtures are isolated and reusable.
