# Vendored patch ledger — `graph/` (git-graph-plus)

`graph/` is a git subtree of `the0807/git-graph-plus` (Apache-2.0). Every edit to
vendored code is framed by `/* SNIPCODE-HOOK start: <intent> */ … /* SNIPCODE-HOOK end */`
and listed here. Logic never lives in vendored code — hooks only inject types,
transfer-calls, asset-root indirection, or a menu item; the real work is in
host `src/*.ts`.

- Subtree upstream ref (Task 1): `de701eb29b0609338d2561bebf4b0a73a0287dea`
  (local squash `db821ee`), git-graph-plus `0.7.1`.
- Re-find all hooks anytime with:
  `git -c grep.lineNumber=false grep -n "SNIPCODE-HOOK" -- graph`

## After every `git subtree pull` — MANDATORY smoke

Upstream changes can move anchors or collide with a hook. After a pull, run this
checklist in order. The first three are CLI-automatable (build / package / e2e);
the fourth is the residual human F5 smoke the e2e suite can't drive.

1. **Hooks present** — `git -c grep.lineNumber=false grep -n "SNIPCODE-HOOK" -- graph`
   confirms all hooks below still present (there are 11 marked regions across 5
   files — see counts per entry); re-apply any the merge dropped (use the anchor
   strings, not line numbers — Svelte/TS line numbers drift).
2. **Build** — `rm -rf node_modules graph/node_modules
   graph/webview-ui/node_modules dist && npm ci && npm run build` exits 0 (this
   builds graph deps + Svelte webview + esbuild host bundle).
3. **Package** — `npx vsce package` exits 0; `unzip -p *.vsix
   extension/package.json | grep '"main"'` = `./dist/extension.js`; `unzip -l
   *.vsix | grep -i graph/LICENSE` shows the Apache license ships.
4. **Unit regression** — `npm run compile && node --test out/test/*.test.js`
   stays green (currently 53; was 52 — must not drop).
5. **E2E (automated runtime gate)** — `xvfb-run -a npm run test:e2e` all pass.
   This covers activation, `gitGraphPlus.open` registration, open-without-throw,
   and END-TO-END `copyFullSourceAtCommit` (MODIFIED/DELETED/MOVED/NEW).
6. **Human F5 smoke** (residual — E2E can't drive in-webview right-click): open
   the graph (`gitGraphPlus.open`), confirm webview loads with no CSP/404; reload
   + disable/enable once (no duplicate-command error); right-click a commit →
   **Copy Full Source** and a changed file → **Copy Full Source**, paste, confirm
   format matches the SCM git-copy branch (header `// file: [LABEL] path`,
   deleted marker, R/C label).

---

## Hooks (current)

### S5 — `graph/src/extension.ts`
- **Intent:** export `activateGraph(context, { assetRootUri, copyFullSourceAtCommit })`
  — host-facing adapter so the vendored extension is driven as a library, not a
  second VSIX entry (spec §4.0). Sets `MainPanel.assetRootUri` +
  `MainPanel.copyFullSourceAtCommit`, calls the original `activate(context)`
  (all disposables already flow to `context.subscriptions`), and pushes one
  disposable that clears the injected statics.
- **Anchor:** immediately ABOVE `export function activate(context: vscode.ExtensionContext) {`
  / the `const statusBar = new StatusBarManager();` line.
- **Re-apply after pull:** if the merge keeps `activate` but drops the adapter,
  re-add the `activateGraph` wrapper above `activate` (it only references
  `MainPanel`, already imported). If upstream renames `activate`, point the
  wrapper at the new name.

### MainPanel asset/handler statics — `graph/src/panels/MainPanel.ts` (top of class)
- **Intent:** declare `static assetRootUri` + `static copyFullSourceAtCommit`
  (the injected webview asset root + host copy handler). `copyFullSourceAtCommit`
  is inline-typed `(payload:{hash:string;files:unknown[]})=>Promise<void>` to keep
  vendored free of host imports; mirrors `src/graphCopy.ts` `GraphCopyPayload`.
- **Anchor:** right after the
  `private static avatarCache: AvatarCache | undefined = undefined;` line.
- **Re-apply after pull:** re-add the two statics in the static-field block.

### MainPanel localResourceRoots — `graph/src/panels/MainPanel.ts` (`createOrShow`)
- **Intent:** when `MainPanel.assetRootUri` is set, the webview's only resource
  root is `[assetRootUri]` (host ships main.js/css + codicon.css/ttf there);
  standalone fallback keeps the upstream two-root layout (for vendored unit tests).
- **Anchor:** the `localResourceRoots: [ … 'webview-ui','dist' … '@vscode','codicons','dist' … ]`
  array inside `vscode.window.createWebviewPanel(... { enableScripts:true, retainContextWhenHidden:true, … })`.
- **Re-apply after pull:** wrap the upstream array in the
  `MainPanel.assetRootUri ? [MainPanel.assetRootUri] : [<upstream array>]` ternary.

### MainPanel getHtmlForWebview asset URIs — `graph/src/panels/MainPanel.ts`
- **Intent:** resolve `scriptUri` / `styleUri` / `codiconUri` under
  `MainPanel.assetRootUri` when set (codicon → `<assetRoot>/codicon.css`);
  standalone fallback keeps `extensionUri/webview-ui/dist` + node_modules codicons.
- **Anchor:** inside `private getHtmlForWebview(webview)`, the
  `const distUri = … 'webview-ui','dist'` + the three `asWebviewUri(...)` lines.
  (CSP `<meta http-equiv="Content-Security-Policy">` line is NOT modified.)
- **Re-apply after pull:** replace `distUri` with
  `MainPanel.assetRootUri ?? vscode.Uri.joinPath(this.extensionUri,'webview-ui','dist')`
  and gate the codicon URI on `MainPanel.assetRootUri`.

### S2 — `graph/src/panels/MainPanel.ts` (`handleMessage` switch)
- **Intent:** `case 'snipcodeCopyFullSource'`: transfer-call
  `await MainPanel.copyFullSourceAtCommit?.(message.payload); return;`. No host
  logic here — just routes the message to the injected handler.
- **Anchor:** immediately BEFORE the `default:` case at the bottom of the
  `handleMessage` `switch (message.type)` (just above `default: break; } } catch`).
  (Currently MainPanel.ts:1582–1590.)
- **Re-apply after pull:** re-insert the `case` before `default:`.

### S4-fetch — `graph/src/panels/MainPanel.ts` (`handleMessage` switch, dedicated copy-files fetch)
- **Intent:** `case 'getCommitFilesForCopy'`: a fetch path **separate** from
  `getCommitDiff` so it does NOT touch `commitFilesSequence` — a T5 commit-copy and
  a CommitDetails load can be in flight at once without dropping each other. Calls
  `gitService.showCommitFiles(hash)` and posts `commitFilesForCopy` echoing the
  webview's `requestId`. No host logic — vendored fetch + correlated response.
- **Anchor:** the `case 'getCommitFilesForCopy':` block immediately AFTER the
  `getCommitDiff` `commitDiffData` post / break (currently MainPanel.ts:498–512).
- **Re-apply after pull:** re-insert the `case` after `getCommitDiff`; pairs with
  the S1 `getCommitFilesForCopy`/`commitFilesForCopy` types and the S4 webview hook.

### S1 — `graph/src/utils/message-bus.ts` (message unions — 2 marked regions)
- **Intent (webview→extension, `WebviewMessage`):** add two members:
  1. `| { type:'snipcodeCopyFullSource'; payload:{ hash:string; files:
     Array<{ repoRootFsPath; relativePath; oldRelativePath?; status }> } }` —
     inline-typed, each element mirrors `src/graphCopy.ts` `GraphCopyFile` (Task 3
     tightened it from the Task 1 dummy `files:unknown[]`) so vendored never
     imports host code.
  2. `| { type:'getCommitFilesForCopy'; payload:{ hash:string; requestId:string } }`
     — the dedicated T5 copy fetch (own `requestId`, never shares the
     `getCommitDiff`/`commitFilesSequence` latest-wins guard).
- **Intent (extension→webview, `ExtensionMessage`):** add
  `| { type:'commitFilesForCopy'; payload:{ hash:string; requestId:string; files:
  Array<{ path; status; oldPath? }> } }` — the correlated response to
  `getCommitFilesForCopy` (separate channel from `commitDiffData`; carries
  `oldPath` for rename/copy mapping).
- **Anchor:** in `WebviewMessage`, the marked block right after the
  `| { type: 'openExtensionSettings' }` member (currently message-bus.ts:127–148);
  in `ExtensionMessage`, the marked `commitFilesForCopy` line right after the
  `commitDiffData` member (currently message-bus.ts:156–158).
- **Re-apply after pull:** re-add the two `WebviewMessage` members and the one
  `ExtensionMessage` member at the marked spots.

### S3 — `graph/webview-ui/src/components/commit/CommitDetails.svelte` (file right-click menu)
- **Intent:** add a **Copy Full Source** item to the committed-view file
  right-click menu. On click it maps the selected paths (`selectedPatchFiles`,
  or `[node.path]` when none/one selected) against the loaded `files` to recover
  each `{path,status,oldPath}`, attaches `filesRepoRoot` as `repoRootFsPath`
  (one active repo per graph panel → same root for every file), and posts
  `{type:'snipcodeCopyFullSource', payload:{hash, files:GraphCopyFile[]}}`. Mirrors
  the adjacent Create Patch multi-select gate. No host logic — payload build + post.
- **Anchor (2 edits):**
  1. local `interface CommitFile { path; status }` — add `oldPath?: string`
     (already present on the `commitDiffData` wire for R/C, needed for
     `oldRelativePath`).
  2. inside the file-item `oncontextmenu` handler, the `if (commit) { … }` block
     immediately BEFORE the `// Restore from stash (stash commits only)` /
     `if (stashIndex !== null)` block (right after the Create Patch push).
- **Re-apply after pull:** re-add `oldPath?` to the local `CommitFile` interface
  and re-insert the `Copy Full Source` push before the stash-restore block.
  (`vscode` = `getVsCodeApi()`, `uiStore`, `files`, `selectedPatchFiles` all in
  scope.) Active-repo path source: a `filesRepoRoot` `$state` captured from
  `uiStore.activeRepo` at the moment `files` are set (on `commitDiffData` /
  `multiCommitSectionsData`), reset to `''` alongside `files`. This pairs the
  root with the same fetch so a repo switch can't combine a stale commit's files
  with a freshly-switched root; empty root degrades safely (host missingRepoCount).
  `uiStore.activeRepo` originates from the `repoList` message `payload.active` in
  `App.svelte`.

### S4 — `graph/webview-ui/src/components/graph/CommitGraph.svelte` (commit right-click menu)
- **Intent:** add a **Copy Full Source** item to the commit right-click menu that
  copies the **whole** commit's changed files. The graph row has the hash but NOT
  the commit's file list (it is lazy-loaded into `CommitDetails`' local state, out
  of scope here). So the handler `copyFullSourceForCommit(hash)`: mints a unique
  `requestId` (`gcopy-<n>-<ts>`), registers a one-shot `window` `message` listener
  matched on that `requestId`, posts the **dedicated** `getCommitFilesForCopy`
  (NOT `getCommitDiff` — so it never collides with the commit-details
  latest-wins guard), and on the matching `commitFilesForCopy` maps `files`
  (`{path,status,oldPath?}` wire shape) -> `GraphCopyFile[]` (attaching
  `uiStore.activeRepo` as `repoRootFsPath` — one active repo per graph panel, same
  source/mapping as the Task 4 file menu) and posts
  `{type:'snipcodeCopyFullSource', payload:{hash, files}}`. A `settled` flag +
  30s timeout tears the listener down on every path (match or timeout) so no
  listener leaks and no duplicate posts. Offered for real commits only
  (`!isStashCommit`). Replaces the Task 1 dummy item. No host logic — lazy-load +
  payload build + post.
- **Anchor (2 edits):**
  1. `copyReqCounter` + `copyFullSourceForCommit(hash)` function — immediately
     ABOVE `function onCommitContextMenu(e: MouseEvent, commit: Commit) {`
     (currently CommitGraph.svelte:742–785).
  2. the `copyGroup.push({ label:'Copy Full Source', … })` item — inside
     `onCommitContextMenu`, the `copyGroup` block right after the
     `t('graph.copySHA')` / `t('graph.copyShortSHA')` / `t('graph.copyCommitInfo')`
     items, just before `groups.push(copyGroup);` (gated on `!isStashCommit`;
     currently CommitGraph.svelte:1204–1216).
- **Re-apply after pull:** re-add `copyReqCounter` + `copyFullSourceForCommit`
  above `onCommitContextMenu` and re-insert the gated `copyGroup.push` after the
  copy-SHA items. (`vscode` = `getVsCodeApi()`, `uiStore` both already
  imported/in scope; `getCommitFilesForCopy` / `commitFilesForCopy` are the S1
  hook members; `snipcodeCopyFullSource` is the S1 hook.)
