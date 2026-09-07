# Sidebar Recent Commits handoff — 2026-09-07

Implemented the requested compact, read-only commit graph in the Snipcode Git sidebar.

## Behavior

- Added the native `snipcode.recentCommits` WebviewView under the owned Snipcode Git container, titled Recent Commits / 近期提交 and given a compact initial flex size.
- Reused the self-contained `workbench.js` bundle with a body view discriminator, so the commit box and recent graph do not share listeners or acquire a second VS Code API instance.
- The provider reads real `GitService` data for the active repo: the latest 30 commits from explicit `HEAD` ancestry, branches/ref decorations, graph geometry from `buildFullGraph`, ahead/behind, and existing staged/unstaged/conflict counts.
- The compact SVG shows rails, dots, the HEAD ring, short hashes, subjects, and up to two local/remote refs. It labels the scope as HEAD history so excluded branch history is clear.
- The renderer reuses the shared 12-color graph palette and CSS light/HC-light rail darkening rules, with graph-builder row centers mapped at `y * 24` (first dot geometry is asserted at `0.5`). Rail width is capped dynamically and the subject column keeps priority over ref text.
- Layout follow-up: Changes/Commit/Recent use initial flex weights 3/1/2; Recent fills its pane and scrolls only the commit list. Synthetic UNCOMMITTED/stash rows are filtered from the 30-entry HEAD history, local branch repetition is kept in the header, and remote/tag refs are limited to one compact badge.
- Final renderer follow-up: rail scaling includes path/dot/link X bounds with at least 6px edge padding; a compact HEAD marker and row emphasis remain visible even when HEAD is not the first ref; ahead/behind is shown only for a known non-gone upstream. The component test asserts first-dot alignment and ring bounds in the narrow view.
- Refresh is handshake/manual/visible-only and sequence-gated. Existing Changes tree events trigger refreshes, including successful commits. Selecting a Changes repo/file synchronizes the active repo through the existing `switchToRepo` flow; opening the custom Diff therefore follows the selected repo without relying on an active editor.
- Repo selection is explicit in the sidebar view. Only the Open Full Graph button calls `MainPanel.createOrShow`; refresh, scrolling, and repo selection do not reveal or replace the full graph/editor.

## Verification

- `cd graph && npx vitest run src/__tests__/extension.test.ts src/tree/__tests__/recent-commits-view.test.ts src/tree/__tests__/git-toolbar.test.ts`: 3 files passed, 69 tests passed.
- `cd graph && npx vitest run --project webview webview-ui/src/workbench/__tests__/entry.test.ts webview-ui/src/workbench/__tests__/messaging.test.ts`: 2 files passed, 12 tests passed; the entry test confirms the recent view acquires the VS Code API once.
- `cd graph/webview-ui && npm run check`: 0 errors and 0 warnings.
- Layout/renderer component check: RecentCommits alignment and narrow multi-lane scaling test passed; entry and messaging isolation tests remain 12/12 passed.
- `npx tsc --noEmit -p graph/tsconfig.json`: passed.
- `git diff --check`: clean.

## Limitations

The parent agent owns the full build, E2E, packaging, and native VS Code verification. The mini view intentionally follows explicit `HEAD` ancestry rather than presenting every branch's history, while branch/ref indications remain visible when they decorate those commits. Refresh responses are rejected when the active repo path changed during the request; errors retain discovered repo choices so the picker remains usable.
