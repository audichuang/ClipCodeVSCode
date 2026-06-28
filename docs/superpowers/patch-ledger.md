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

Upstream changes can move anchors or collide with a hook. After a pull:

1. `git -c grep.lineNumber=false grep -n "SNIPCODE-HOOK" -- graph` — confirm all
   hooks below still present; re-apply any that the merge dropped (use the anchor
   strings, not line numbers — Svelte/TS line numbers drift).
2. `npm run compile && node --test out/test/*.test.js` — host regression
   (must stay 52+ green).
3. Clean build + package: `rm -rf node_modules graph/node_modules
   graph/webview-ui/node_modules dist && npm ci && npm run build && npx vsce package`
   — both exit 0; vsix `main` = `./dist/extension.js`.
4. **Human F5 smoke** (CLI cannot do these): open the graph
   (`gitGraphPlus.open`), confirm webview loads with no CSP/404; reload +
   disable/enable once (no duplicate-command error); right-click a commit →
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
- **Re-apply after pull:** re-insert the `case` before `default:`.

### S1 — `graph/src/utils/message-bus.ts` (`WebviewMessage` union)
- **Intent:** add `| { type:'snipcodeCopyFullSource'; payload:{ hash:string; files:
  Array<{ repoRootFsPath; relativePath; oldRelativePath?; status }> } }` to the
  webview→extension message union. Inline-typed — each element mirrors
  `src/graphCopy.ts` `GraphCopyFile` (Task 3 tightened it from the Task 1 dummy
  `files:unknown[]` to the real GraphCopyPayload shape) so vendored never imports
  host code.
- **Anchor:** end of the `export type WebviewMessage = …` union, right after the
  `| { type: 'openExtensionSettings' }` member (the hook replaces its trailing `;`).
- **Re-apply after pull:** re-add the union member at the end of `WebviewMessage`.

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
  of scope here). So the handler `copyFullSourceForCommit(hash)`: registers a
  one-shot `window` `message` listener keyed by `payload.hash`, posts the existing
  `getCommitDiff`, and on the matching `commitDiffData` maps `files` (`{path,
  status,oldPath?}` wire shape) -> `GraphCopyFile[]` (attaching
  `uiStore.activeRepo` as `repoRootFsPath` — one active repo per graph panel, same
  source/mapping as the Task 4 file menu) and posts
  `{type:'snipcodeCopyFullSource', payload:{hash, files}}`. Offered for real
  commits only (`!isStashCommit`). Replaces the Task 1 dummy item. No host logic —
  lazy-load + payload build + post.
- **Anchor (2 edits):**
  1. `copyFullSourceForCommit(hash)` function — immediately ABOVE
     `function onCommitContextMenu(e: MouseEvent, commit: Commit) {`.
  2. the `copyGroup.push({ label:'Copy Full Source', … })` item — inside
     `onCommitContextMenu`, the `copyGroup` block right after the
     `t('graph.copySHA')` / `t('graph.copyShortSHA')` / `t('graph.copyCommitInfo')`
     items, just before `groups.push(copyGroup);` (gated on `!isStashCommit`).
- **Re-apply after pull:** re-add `copyFullSourceForCommit` above
  `onCommitContextMenu` and re-insert the gated `copyGroup.push` after the copy-SHA
  items. (`vscode` = `getVsCodeApi()`, `uiStore` both already imported/in scope;
  `getCommitDiff` / `commitDiffData` are existing message-bus members; the
  `snipcodeCopyFullSource` type is the S1 hook.)
