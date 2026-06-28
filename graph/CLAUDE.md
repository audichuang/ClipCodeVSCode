# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Git Graph Plus is a VS Code extension that provides a full-featured Git GUI — commit graph visualization, branch/tag/stash/worktree management, diff viewer, and more. It uses a **two-process architecture**: a Node.js extension host (backend) and a Svelte 5 webview (frontend).

## Build & Development Commands

```bash
# Install dependencies (both root and webview-ui)
npm install && cd webview-ui && npm install && cd ..

# Build everything (extension + webview)
npm run build

# Development mode (watches both extension and webview)
npm run dev

# Build individually
npm run build:extension    # esbuild bundles src/extension.ts → dist/extension.js
npm run build:webview      # vite builds webview-ui → webview-ui/dist

# Type checking (no emit)
npm run lint               # runs tsc --noEmit on the extension

# Webview type checking
cd webview-ui && npm run check   # runs svelte-check

# Tests
npm test                   # vitest run (all: backend + webview projects)
npm run test:watch         # vitest in watch mode
npx vitest run --project backend   # only extension-host tests
npx vitest run --project webview   # only Svelte/webview tests
npx vitest run src/git/__tests__/git-service.test.ts  # single test file

# Package for marketplace
npm run package            # vsce package → .vsix file
```

## Architecture

### Extension Host (Backend) — `src/`
- **`extension.ts`** — Entry point. Registers commands, tree views, file watcher, auto-fetch timer.
- **`git/git-service.ts`** — Core Git operations (wraps `git` CLI via child_process). This is the central hub (~90KB); nearly all git commands go through it.
- **`git/git-parser.ts`** — Parses raw git output (log, diff, branch list, etc.) into typed structures.
- **`git/git-graph-builder.ts`** — Builds the visual graph layout (rail assignment, merge lines) from parsed commits.
- **`git/patch-builder.ts`** — Builds patches for reverse-changes (undo file/hunk/line against working tree) and `.patch` export.
- **`git/git-error-formatter.ts`** — Normalizes raw git stderr into user-facing error messages.
- **`git/git-binary.ts`** — Holds the resolved path to the `git` executable (module-level, defaults to `'git'` on PATH). `extension.ts` resolves VS Code's `git.path` setting at activation and calls `setGitBinaryPath` so all spawn sites pick it up (matters on Windows portable/MSYS2 installs).
- **`git/vscode-git-bridge.ts`** — Bridges to the built-in `vscode.git` extension API (only the bits we use) to delegate credential auth on fetch/push.
- **`git/types.ts`** — Shared TypeScript types for git data structures.
- **`panels/MainPanel.ts`** — VS Code WebviewPanel host. Routes messages between the webview and GitService.
- **`utils/message-bus.ts`** — Typed message definitions for Extension ↔ Webview communication (discriminated union types).
- **`services/file-watcher.ts`** — Watches `.git/` directory for changes and triggers auto-refresh (`file-watcher-helpers.ts` resolves git dirs / classifies paths).
- **`services/repo-discovery.ts`** — Discovers git repos and submodules in the workspace.
- **`services/avatar-cache.ts`** — Caches Gravatar avatars for commit authors.
- **`views/`** — TreeDataProviders for the Activity Bar sidebar (branches, remotes, tags, stashes, worktrees).

### Webview (Frontend) — `webview-ui/`
- **Svelte 5** (runes) with Vite, outputs to `webview-ui/dist/`.
- **`src/App.svelte`** — Root component; routes between Graph, Reflog, and Stats views.
- **`src/components/graph/`** — CommitGraph, CommitNode, BranchLine — canvas-based graph rendering.
- **`src/components/commit/`** — CommitDetails panel with diff viewer (uses Shiki for syntax highlighting).
- **`src/components/modals/`** — Modal dialogs for git operations (create branch, merge, rebase, etc.).
- **`src/components/layout/`** — Toolbar and BottomPanel layout components.
- **`src/components/common/`** — Shared UI: context menus, search bar, image diff, stats view, bisect banner.
- **`src/components/rebase/`** — Interactive rebase UI with drag-to-reorder.
- **`src/lib/stores/`** — Svelte stores for shared state management.
- **`src/lib/actions/`** — Svelte `use:` actions (e.g. drag-to-rebase/merge interactions).
- **`src/lib/i18n/`** — Frontend internationalization (`en.ts`, `ko.ts`, `zh.ts`).
- **`src/lib/vscode-api.ts`** — Typed wrapper for `acquireVsCodeApi()` messaging.

### Extension ↔ Webview Communication
All communication is via `postMessage` / `onDidReceiveMessage`. Message types are defined in `src/utils/message-bus.ts` (`WebviewMessage` for webview→extension, `ExtensionMessage` for extension→webview). `MainPanel.ts` is the message router that dispatches webview requests to `GitService`.

> ⚠️ Svelte 5 `$state` values are reactive proxies. Passing one directly to `postMessage` throws `DataCloneError` (silently failing). Spread/snapshot the value (`$state.snapshot(...)` or `{ ...value }`) before posting.

### Internationalization
- Extension strings: `l10n/bundle.l10n.json` (English), `l10n/bundle.l10n.ko.json` (Korean), `l10n/bundle.l10n.zh-cn.json` (Chinese Simplified), using VS Code's `vscode.l10n.t()`.
- Webview strings: `webview-ui/src/lib/i18n/` — `en.ts`, `ko.ts`, `zh.ts`.
- Git terms (commit, merge, rebase, push, pull, fetch) are intentionally left untranslated.

## Key Conventions

- Extension is bundled with **esbuild** (CJS, Node target). Webview is bundled with **Vite** (ESM, browser target).
- `vscode` is an external dependency (not bundled) — provided by the VS Code runtime.
- **`git/` modules stay free of any `vscode` import** so GitService and parsers remain unit-testable against the real git CLI. Anything vscode-aware (settings, the built-in git extension API) lives in `extension.ts`/`panels/` or a dedicated bridge (`vscode-git-bridge.ts`) and is injected in (e.g. `setGitBinaryPath`).
- **Guard rapid async with `utils/sequence-guard.ts`** (`SequenceGuard`): `issue()` a ticket before a request, and only apply the result if the ticket `isCurrent()` after the await — prevents a late-finishing older request (rapid clicks on different commits/files) from overwriting a newer one.
- User-facing settings live under the `gitGraphPlus.*` namespace and are read via `utils/config.ts` (e.g. `timeout` seconds → `GitService.setDefaultTimeout`, initial/load-more commit counts). Add new settings to `package.json` `contributes.configuration` and read them through there.
- The extension activates on `onStartupFinished`; on activation it discovers repos in the workspace and is a no-op when none exist.
- Tests use **Vitest**, split into two projects in `vitest.config.mts`:
  - `backend` — extension-host code (`src/**/*.test.ts`), node env, runs against the **real `git` CLI**. Integration tests in `src/git/__tests__/integration/` spawn real git/git-flow/git-lfs and use a 30s timeout.
  - `webview` — Svelte components/stores (`webview-ui/src/**/*.test.ts`), happy-dom env.
  - `npm test` runs both. Coverage is uploaded to Codecov; vscode-bound modules (`extension.ts`, `panels/`, canvas/shiki webview code) are excluded from the % — see the comments in `vitest.config.mts`.
- Staging, committing, and inline blame are intentionally delegated to VS Code's built-in Source Control; Git Graph+ focuses on everything else.
