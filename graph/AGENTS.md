# AGENTS.md — git-graph-plus (vendored inside Snipcode)

> **Vendored sub-project**, not a standalone install. Bundled into Snipcode
> (`clipcode-vscode`); host wiring and marketplace release live in `../AGENTS.md`.
> This file is the single source of truth for **this folder** — `CLAUDE.md` is
> just `@AGENTS.md`. (Upstream ships notes as `CLAUDE.md`; on re-sync, port doc
> changes **into this file**.)

## What this folder is

Upstream **Git Graph Plus**: commit graph, branch/tag/stash/worktree management,
and related git GUI — Node extension host + **Svelte 5** webview.

**Snipcode adds on top of that** (do **not** re-delegate these to built-in SCM;
do **not** reintroduce `CommitWorkbenchViewProvider` / native `SnipcodeScmManager`
without a design decision — those are dead paths that only remain in old plans):

| Feature | Live path |
|---|---|
| Multi-repo **Changes** tree (real stage/unstage/commit) | **Owner:** `src/tree/changes-workbench.ts` (+ `build-change-tree.ts`, `changes-tree.ts`). Ops: `GitService.stagePaths` / `unstagePaths` / `commitIndex` / `stageHunks` / `unstageHunks` / `stageLines` / `unstageLines` |
| **Commit** message box (one shared message across repos) | `src/tree/commit-box-view.ts` (`CommitBoxViewProvider`) → `workbench.js` → `ChangesWorkbench.commit()` |
| Full-width **Diff** tab (unified staged+unstaged, hunk/line stage, word-diff) | `src/panels/DiffPanel.ts` → `diff.js` |
| Fetch / Pull / Push all repos + ↓↑ badges | `ChangesWorkbench.fetchAll` / `pullAll` / `pushAll` + root `package.json` `view/title` menus when `view == snipcode.changes`; badges from `GitService.aheadBehind` on tree repo nodes — **not** the graph webview `Toolbar.svelte` |
| PR compare tab | `webview-ui/.../pr/PrView.svelte` + `GitService.commitsBetween` |
| **Inline blame** | Host `../src/blame/` (not this folder) |

Fence every Snipcode-only edit with `/* SNIPCODE-HOOK start/end */` for upstream re-sync.

## Build & test (from this folder)

Prefer **root** `npm run build` when shipping with Snipcode. Inside `graph/`:

```bash
npm test                                      # vitest: backend + webview
npx vitest run --project backend              # extension-host only
npx vitest run --project webview              # Svelte/webview only
npx vitest run src/git/__tests__/git-service.test.ts   # single file
cd webview-ui && npm run check                # svelte-check
```

Standalone `npm run build` / `npm run package` still exist for upstream-style
dev; Snipcode packaging is always from the **repo root**.

## Roles (not a file tree)

| Area | Role |
|---|---|
| `src/git/git-service.ts` | Central git CLI hub; almost all ops go through it |
| `src/git/patch-builder.ts` | Patches for reverse-changes and forward stage/unstage hunks/lines. **Byte-safe:** patch reconstruction + fingerprints read raw `Buffer` stdout (`exec(..., {encoding:'buffer'})`), never a decoded string — quoted-path/UTF-8/mixed-EOF fidelity |
| `src/utils/message-bus.ts` | Graph webview ↔ host message types + **live** `MESSAGE_EFFECTS` gate |
| `src/panels/MainPanel.ts` | Commit-graph WebviewPanel; message router + mutation transactions |
| `src/panels/DiffPanel.ts` | Snipcode Diff tab (classic `diff.js` bundle) |
| `src/tree/*` | **Live** Snipcode Git: Changes TreeView + `CommitBoxViewProvider` |
| `src/workbench/*` | **Mostly orphaned B-2a leftovers** (`getWorkbenchStatus` / `commitAcrossRepos` / `WORKBENCH_MESSAGE_EFFECTS`) — only used by their own tests. Live multi-repo commit is `ChangesWorkbench.commit()`. Do not wire new features through these helpers unless resurrecting that protocol. |
| `webview-ui/` | Svelte 5 UI: graph, modals, PR view, commit-box + diff entries |
| `l10n/` + `webview-ui/src/lib/i18n/` | Host vs webview strings (`en`/`ko`/`zh`) |

Full structure: read the tree or search the code — do not maintain a hand-written inventory here.

## Three webview bundles (hard constraint)

Each bundle **must be self-contained** (no shared chunk, no top-level `import`).
Hosts load them as **classic** `<script nonce src>` (CSP `script-src 'nonce-…'`,
**not** `type="module"`). A top-level `import` → parse fail → blank panel →
handshake timeout (`sent no message within 15000ms`).

| Bundle | Vite config | Loaded by |
|---|---|---|
| `main.js` | `webview-ui/vite.config.ts` | `MainPanel` (graph) |
| `workbench.js` | `vite.workbench.config.ts` (`inlineDynamicImports`) | `CommitBoxViewProvider` |
| `diff.js` | `vite.diff.config.ts` | `DiffPanel` |

`webview-ui`'s `build` runs these **three single-entry** builds back-to-back.
**Do not** merge into one multi-entry Vite build (shared Svelte runtime chunk →
all three boot blank). Root `scripts/copy-graph-assets.mjs` asserts all three
`.js`/`.css` pairs exist.

## Key conventions (踩雷)

- **`git/` modules stay free of `vscode` imports** — sole exception
  `git/vscode-git-bridge.ts` — so GitService/parsers stay unit-testable
  against real git. Other VS Code-aware bits live in `extension.ts` /
  `panels/`.
- **`SequenceGuard`** (`utils/sequence-guard.ts`): `issue()` before async work;
  apply results only if `isCurrent()` — stops late clicks overwriting newer UI.
- **Two lock layers (do not confuse them):**
  1. **`GitService.withMutationLock`** — per-command **and** per-`GitService`
     instance. `exec()` routes worktree/index mutations through it;
     network-only `fetch`/`push` stay unlocked (`pull` is locked — it can
     merge/rebase). Raw `spawn` that mutates (e.g. interactive rebase) must
     take the lock and `clearReadCache()` itself.
  2. **`runExclusive(repoPath)`** (`services/mutation-coordinator.ts`) —
     module-level, path-keyed. Used by **Changes/Diff** staging so two
     panels cannot race the same repo via different `GitService` instances.
     **MainPanel graph mutations do not call `runExclusive`** — they rely on
     instance lock + the MESSAGE_EFFECTS transaction below.
- **Repo-switch transaction:** `MainPanel.handleMessage` runs mutating graph
  messages as one transaction — a repo switch waits until the transaction
  (including terminal refresh/error handling) finishes, or later steps hit the
  wrong `gitService`. Classification is **`MESSAGE_EFFECTS`** in
  `message-bus.ts`, exhaustive over `WebviewMessage['type']` — **a new type
  without a class is a compile error**. That is the **live** gate.
  `WORKBENCH_MESSAGE_EFFECTS` in `src/workbench/workbench-messages.ts` is the
  same technique for a **legacy** workbench protocol; the live commit box does
  **not** consult it (it only handles `workbenchCommit` → `ChangesWorkbench.commit`).
- **Svelte 5 `$state` is a proxy** — never `postMessage` it raw (`DataCloneError`,
  often silent). Use `$state.snapshot(...)` or a plain copy.
- **Repo switch posts only `repoList`** (updates `active`), **not** `repoChanged`
  (file-watcher-only). Views that re-fetch on repo change should watch
  `uiStore.activeRepo`, not listen for `repoChanged`.
- **Mutating-op refresh order:** handlers post `operationComplete` **before**
  `await refreshAll()`; the graph repaints on `fullRefresh` / `logData`. UI that
  means “op done **and** graph updated” must key off those (plus
  `error`/`operationPaused`/`conflictData`), never bare `operationComplete`.
- **Request→response can fail or vanish.** On handler error the host posts
  `{type:'error', payload:{message, source:<request type>}}`; some reads drop
  the reply if the active repo switched mid-request. Waiters must handle
  matching `error` (`payload.source`) **and** a timeout, or spinners hang
  forever (squash-modal family). Correlate reused reply types with a key
  (`base`, `requestId`; the Diff stage/unstage family threads an
  `operationId` — `diff-${pageId}-${n}`, unique across pages, inherited when
  the same file is re-pushed — and drops non-matching `diffData`/replies).
- Settings namespace: `gitGraphPlus.*` via `utils/config.ts`. Locales differ
  on git terms: `zh` translates them (拉取/推送/变基), `ko` is mixed
  (당겨오기 alongside English "Push"), `en` is source — match the existing
  style of the locale file you touch, don't impose a blanket rule.
- **Vitest** (`vitest.config.mts`): `backend` (real git CLI; integration under
  `src/git/__tests__/integration/`, 30s timeout) + `webview` (happy-dom).
  Deterministic race tests use `git-shim.ts` via `setGitBinaryPath()` — restore
  in `afterEach`; POSIX-only; don't run shim suites concurrent with other
  real-git suites.

## Permissions

Release / marketplace / workflow edits: follow **`../AGENTS.md`**. Visual
changes under `webview-ui/**` should go through the work-root
`verify-webview-ui` skill before claiming the UI is done.
