# Spike Report — git-graph-plus vertical-slice integration (Task 1)

Date: 2026-06-28
Branch: `feat/git-graph-integration`
Status: **AUTO-VERIFIABLE GATE PASSED. Runtime gate OPEN — needs human F5 smoke.**

This is the HARD-GATE de-risking spike for spec §7. It proves the vertical slice
*subtree → merged build → activateGraph injection → webview message roundtrip*
is structurally sound, and pins down every `[Verify in spike]` unknown.

> **Honesty boundary:** items verifiable only from the CLI (clean build exit 0,
> `vsce package` exit 0, vsix `main`, the node:test suite) are marked
> **AUTO-VERIFIED** with their exit codes. Everything that needs a running
> Extension Development Host (open the graph, inspect the webview for CSP/404,
> reload/disable-enable, click the dummy menu) is marked
> **PENDING MANUAL SMOKE — requires human F5** and was NOT performed.

---

## Subtree reference

- Added via: `git subtree add --prefix graph https://github.com/the0807/git-graph-plus.git main --squash`
- **subtreeRef (upstream `git-subtree-split`): `de701eb29b0609338d2561bebf4b0a73a0287dea`**
- Local squash commit: `db821ee` ("Squashed 'graph/' content from commit de701eb")
- Vendored version: git-graph-plus `0.7.1` (publisher `the0807`, Apache-2.0).
- `NOTICE` added at repo root pointing to this report + the patch ledger.

---

## §7 acceptance checklist (6 items)

| # | Item | Status |
|---|------|--------|
| 1 | clean build + `vsce package` + vsix `main` | **AUTO-VERIFIED — PASS** |
| 2 | packaged: open graph, webview JS/CSS load from `assetRootUri`, no CSP/404 | **PENDING MANUAL SMOKE — requires human F5** |
| 3 | lifecycle: reload + disable/enable, no duplicate command / leak | **PENDING MANUAL SMOKE — requires human F5** |
| 4 | message roundtrip: click dummy menu → see `snipcode dummy ok` via injected handler; un-preloaded files reachable | **PENDING MANUAL SMOKE — requires human F5** (the wiring is built + structurally verified below; only the on-screen confirmation is human-only) |
| 5 | payload parity dry-run (real-commit `{hash, files[{path,status,...}]}` shape) | shape **AUTO-VERIFIED by source read** (see "commit-file shape"); live `readRefContent` dry-run **PENDING MANUAL SMOKE** |
| 6 | namespace decision | **DECIDED** (see "Namespace decision") |

### Item 1 — clean build + package (AUTO-VERIFIED, PASS)

Ran exactly per plan Step 7 from a clean checkout (deps + dist removed):

```
rm -rf node_modules graph/node_modules graph/webview-ui/node_modules dist
npm ci                       → exit 0   (/tmp/spike-npmci.txt)
npm run build                → exit 0   (/tmp/spike-build.txt)
npx vsce package             → exit 0   (/tmp/spike-package.txt)
unzip -p *.vsix extension/package.json | grep '"main"'
                             → "main": "./dist/extension.js"   (/tmp/spike-main.txt)
```

- `npm run build` is **self-contained for a clean checkout**: it installs graph +
  graph/webview-ui deps (`build:graph-deps`), builds the Svelte webview and copies
  assets (`build:graph-webview` → `scripts/copy-graph-assets.mjs`), then bundles
  the host extension with esbuild (`build:host`).
- VSIX contents: only `extension/dist/**` + `package.json` + LICENSE + NOTICE +
  readme. **0 `node_modules` entries**, **0 graph source files** — host runtime
  deps are bundled into `dist/extension.js` (327 KB), exactly as `.vscodeignore`
  requires.
- Regression suite (item 5 / §9.1): `npm run compile` exit 0, then
  `node --test out/test/*.test.js` → **tests 52, pass 52, fail 0** (45 original +
  7 Task 2 additions). `/tmp/spike-test.txt`.

### Item 2 — packaged open + asset load (PENDING MANUAL SMOKE)

Cannot be run from the CLI. A human must: install the `.vsix` (or F5), run
**Git Graph+: Open Git Graph** (`gitGraphPlus.open`), confirm the graph renders,
and open the webview DevTools console to confirm `main.js` / `main.css` /
`codicon.css` load from `dist/graph-webview` with **no CSP violation and no 404**.
Specific risk to watch: shiki ships ~39 lazily-imported language chunks under
`dist/graph-webview/assets/*.js`; they are dynamic `import()`s and the CSP is
`script-src 'nonce-…'`. This is upstream-unchanged behaviour (they lived under
`webview-ui/dist/assets` before, same CSP/nonce), but the human should confirm
syntax highlighting in a diff actually works (a CSP block here would only show
when a highlighted file is opened, not on first render).

### Item 3 — lifecycle (PENDING MANUAL SMOKE)

Cannot be run from the CLI. A human must reload the window once and
disable→enable the extension once, confirming no "command already registered"
errors and no leaked panels/watchers. Structural basis for expecting it to pass:
`activateGraph` delegates to the vendored `activate(context)`, which pushes every
disposable (status bar, 5 tree views + providers, file watcher, config listener,
all `registerCommand`s) into `context.subscriptions`; `activateGraph` adds one
more disposable that clears the injected statics (`MainPanel.assetRootUri` /
`copyFullSourceAtCommit`). The webview singleton `MainPanel.currentPanel` is torn
down in `MainPanel.dispose()` (panel + all panel disposables).

### Item 4 — message roundtrip + handler injection (wiring built; on-screen PENDING)

The full path is built and compiles/bundles clean:
`CommitGraph.svelte` dummy menu → `postMessage({type:'snipcodeCopyFullSource', payload:{hash:'x',files:[]}})`
→ `MainPanel.handleMessage` `case 'snipcodeCopyFullSource'` → `MainPanel.copyFullSourceAtCommit(payload)`
→ host-injected dummy → `vscode.window.showInformationMessage('snipcode dummy ok')`.
The handler is reached **only** through the injected `MainPanel.copyFullSourceAtCommit`
static set by `activateGraph` (no implicit import of host code into vendored).
A human must click the menu item and confirm the toast says **`snipcode dummy ok`**.

"Un-preloaded files reachable" is satisfied structurally: a commit's changed-file
list is lazy-loaded (see "Lazy-load flow") via the `getCommitDiff` message; Task 5
will issue that request and await the `commitDiffData` store update before posting.

### Item 5 — payload parity dry-run (shape AUTO-VERIFIED; live read PENDING)

The real shape the webview can produce is read directly from vendored source (see
"commit-file shape" below). The live half — confirming `repoRootFsPath` resolves
to exactly one VS Code Git API repository and `readRefContent(repo, hash, absPath)`
returns text for a non-deleted file — needs a workspace + running host, so it is
**PENDING MANUAL SMOKE**. (Task 2's `buildGraphCopyPayload` already unit-tests the
A/M/D/R/C → label mapping, deleted-marker, size guard, and missing-repo counting
against a fake repo.)

---

## webviewAssetPath (decided + documented)

- **`dist/graph-webview/`** (joined onto `context.extensionUri` by the host).
- Host build pipeline: `vite build` (in `graph/webview-ui`, outputs to
  `graph/webview-ui/dist/`) → `scripts/copy-graph-assets.mjs` copies
  `main.js`, `main.css`, the `assets/` shiki chunks, `index.html`, **plus**
  `codicon.css` + `codicon.ttf` (from `graph/node_modules/@vscode/codicons/dist`)
  into `dist/graph-webview/`. This is the *single* dir the VSIX ships for the
  webview — `.vscodeignore` keeps it (`!dist/**`) and excludes everything else.
- Vendored webview-creation wiring (the §6.2 unknowns, now pinned):
  - `MainPanel.createOrShow` set `localResourceRoots` to
    `[ extensionUri/webview-ui/dist, extensionUri/node_modules/@vscode/codicons/dist ]`.
    **SNIPCODE-HOOK** now sets it to `[ MainPanel.assetRootUri ]` only (standalone
    fallback retained for vendored unit tests).
  - `MainPanel.getHtmlForWebview` built `scriptUri`/`styleUri` from
    `extensionUri/webview-ui/dist/{main.js,main.css}` and `codiconUri` from
    `extensionUri/node_modules/.../codicon.css`. **SNIPCODE-HOOK** now resolves all
    three under `MainPanel.assetRootUri` (codicon → `<assetRoot>/codicon.css`).
  - CSP (unchanged): `default-src 'none'; style-src ${cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource};`
    — `cspSource` adapts to the resource roots, so it covers `assetRootUri`.

---

## Namespace decision (§6.3, §7.6)

- **Decision / recommendation: rename `gitGraphPlus.*` → `clipcode.gitGraph.*`**
  (commands, views, viewContainer, config keys) to avoid colliding with a
  standalone git-graph-plus install. This is the correct end state and is the
  explicit Task 6 Step 1 deliverable ("namespace 決策落地").
- **For this spike the rename is DEFERRED to Task 6.** Rationale: a full rename
  touches dozens of `gitGraphPlus.*` references across vendored
  `extension.ts` / `MainPanel.ts` / `utils/config.ts` and the `package.nls*.json`
  / `l10n` bundles — high vendored churn that fights the "add-only, mark every
  change" discipline and would bloat the spike. The spike merges contributes
  **as-is** (`gitGraphPlus.*`) so the slice builds and the graph opens; **until
  the Task 6 rename lands, coexistence with a standalone git-graph-plus install
  is NOT supported** (id collision). Existing `clipcode.*` ids are untouched.
- Manifest merge done once in host `package.json`: graph commands (literal English
  titles — no `%nls%` plumbing shipped in the spike), `scm` views (5 tree views
  appended to the existing `clipcode.history` view), `viewsWelcome`,
  `editor/title` + `scm/title` + merged `view/title` / `view/item/context` menus,
  the `gitGraphPlus.*` configuration block (host `configuration` converted to an
  array of two objects), and `onStartupFinished` added to `activationEvents`.

---

## Vendored `activate()` registration list (for the §4.0 adapter)

Read from `graph/src/extension.ts`. `activateGraph(context, opts)` sets the two
injected statics then calls this `activate(context)` verbatim, so everything below
already lands in `context.subscriptions`:

- `StatusBarManager` (status bar item) — always created.
- `MainPanel.setAvatarCacheDir(globalStorage/avatars)` — module/static state
  (avatar cache dir + lazily-built `AvatarCache`), shared across windows.
- **No-workspace branch:** registers `git-graph-plus.open` + `gitGraphPlus.open`
  (both warn), and an `onDidChangeWorkspaceFolders` reload prompt, then returns.
- **Workspace branch:**
  - module-level git binary path resolution (`setGitBinaryPath`), re-resolved on
    `git.path` config change (config listener pushed to subscriptions).
  - `GitService` (reassigned on repo auto-switch / `switchToRepo`).
  - 5 `TreeDataProvider`s (branches/remotes/tags/stashes/worktrees) + their 5
    `createTreeView` views — all pushed to subscriptions.
  - 1 `FileWatcher` (sidebar-owning; disposed via a pushed `{dispose}` and
    re-created on repo switch).
  - `onDidChangeWorkspaceFolders` listener (re-discover repos), a debounced
    sidebar-refresh timer (pushed `{dispose}` clears it), built-in `vscode.git`
    repo-selection + active-editor listeners (pushed).
  - **Module-level statics on `MainPanel`** (the singleton webview host):
    `MainPanel.currentPanel`, `onSidebarRefresh`, `onRepoChange`, `extraEnv`,
    `savedRemoteFilter`, `savedBranchFilter`, `avatarCacheDir`, `avatarCache`,
    and (NEW, SNIPCODE-HOOK) `assetRootUri`, `copyFullSourceAtCommit`.
  - ~40 `registerCommand`s under `gitGraphPlus.*` (+ legacy `git-graph-plus.open`)
    — all in one `context.subscriptions.push(...)`.
- `deactivate()` nulls `MainPanel.onSidebarRefresh` / `onRepoChange`. (Host
  `deactivate` does not currently proxy this — acceptable for the spike since the
  injected-static cleanup is handled by the disposable `activateGraph` pushes;
  flag for Task 3/6 if a leak shows in the lifecycle smoke.)

---

## commit-file shape (the §5.0 / Task 2 mapping authority)

Source of truth: `graph/src/git/git-service.ts` `showCommitFiles(hash)` →
`parseNameStatus(raw)` (line 771), driven by `git diff --name-status`.

```ts
// showCommitFiles return + the commitDiffData message payload files[] element:
{ path: string; status: string; oldPath?: string }
```

- **`path` is repo-relative, POSIX (`/`) separators** — straight from
  `git diff --name-status`. NOT absolute. Host must join it onto the repo root to
  get an absolute fsPath for `readRefContent` (graphCopy already does this via
  `joinFsPath(repoRootFsPath, relativePath)`).
- **`status` is a SINGLE LETTER**: `parseNameStatus` does
  `status = parts[0].charAt(0)`, so it is `'A' | 'M' | 'D' | 'R' | 'C'` — **never**
  `R100` / `C75` (the similarity score is dropped). Task 2's `mapGitStatusToChangeType`
  on `status.trim().charAt(0).toUpperCase()` therefore already matches; the
  `R100`/`C75` tolerance in graphCopy is belt-and-suspenders.
- **`oldPath` present only for `R`/`C`** (rename/copy): `{ path: newPath, status,
  oldPath }`. Maps to `GraphCopyFile.oldRelativePath`.
- There is **no `repoRootFsPath`** in the webview-side object. The webview only
  knows the relative path; the repo root is the panel's `repoPath` (the active
  repo `MainPanel` runs git against). Tasks 4/5 must attach `repoRootFsPath` from
  the webview's known active-repo path (sent via the existing `repoList` message:
  `{ repos:[{path,name,type}], active }`) when building the normalized payload.

The webview `commitDiffData` message (`MainPanel.handleMessage` `getCommitDiff`)
posts `{ hash, files }` with this exact shape; `CommitDetails.svelte` types it as
`interface CommitFile { path: string; status: string }` (line 43–46) and stores it
in `files = $state<CommitFile[]>([])`.

---

## Lazy-load flow (for Tasks 4/5)

- **Commit's changed-file list is lazy-loaded**, not preloaded with the graph.
  When a commit is selected, `CommitDetails.svelte` posts
  `{ type:'getCommitDiff', payload:{ hash } }` (line 263). `MainPanel` handles it
  (guarded by `commitFilesSequence`), calls `gitService.showCommitFiles(hash)`,
  and posts back `{ type:'commitDiffData', payload:{ hash, files } }`.
- The webview stores the result in `CommitDetails.svelte` local state
  `files = $state<CommitFile[]>([])` (set on the `commitDiffData` message, line
  335) — **not** a shared store. So **Task 5's commit-right-click "Copy Full
  Source"** (which fires from `CommitGraph.svelte`, where `files` is not in scope)
  must: post `getCommitDiff` for the commit, await the matching `commitDiffData`
  message (match on `payload.hash`), then build + post the normalized payload.
  (A small shared store or a one-shot message listener keyed by hash is the clean
  way; accept >1 marked hook there per spec §4.1 S4.)
- **Multi-select source (for Task 4 file-level menu):** `CommitDetails.svelte`
  `selectedPatchFiles = $state<Set<string>>(new Set())` — a set of repo-relative
  paths Ctrl/Cmd-clicked in the file list (single `selectedFile = $state<string|null>`
  tracks the focused file). Task 4's file right-click maps the selected paths (or
  `[clickedFile]` when none selected) against `files` to recover each `{path,
  status, oldPath?}` and builds the payload.
- Uncommitted changes use a separate path (`getUncommittedDiff` /
  `getUncommittedFileDiff`) — out of scope for commit copy.

---

## Files produced by Task 1

- `graph/` — git subtree (squash `db821ee`, upstream `de701eb`).
- `NOTICE` — Apache-2.0 attribution.
- `esbuild.config.mjs` — host bundle (`src/extension.ts` → `dist/extension.js`,
  node/cjs/external vscode/bundle/sourcemap).
- `scripts/copy-graph-assets.mjs` — assembles `dist/graph-webview/`.
- `package.json` — `main=./dist/extension.js`, self-contained `build` scripts,
  merged graph contributes, `onStartupFinished`, `esbuild` devDep, config-as-array.
- `package-lock.json` — regenerated (adds esbuild).
- `.vscodeignore` — ships only `dist/**`; excludes node_modules + graph source.
- `.gitignore` — adds `dist/`.
- `src/extension.ts` — lazy `require('../graph/src/extension')`, computes
  `assetRootUri = extensionUri/dist/graph-webview`, calls `activateGraph` with the
  dummy handler.
- 7 SNIPCODE-HOOK edits in `graph/` (see `patch-ledger.md`).
- `docs/superpowers/spike-report-git-graph.md` (this file) + `patch-ledger.md`.

## GATE verdict

- **Auto-verifiable gate (build + package + vsix main + regression): PASS.**
- **Runtime gate (items 2, 3, 4-onscreen, 5-live): OPEN — requires human F5 smoke.**
  Do not claim the slice fully proven until a human completes the manual smoke.
