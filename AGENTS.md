# AGENTS.md — ClipCodeVSCode (Snipcode)

Single source of truth for AI agents in this repo. `CLAUDE.md` imports this file
— edit here only.

**Snipcode** (`clipcode-vscode`) — VS Code extension that copies and restores
files using the **IntelliJ ClipCode clipboard format**, plus a bundled Git graph
and a **Snipcode Git** commit workbench. It is the VS Code port of the sibling
IntelliJ plugin ClipCode.

## Clipboard format — this side is the format authority

The format itself, its byte-for-byte invariants, and the fixture-regeneration flow
are **shared** with the IntelliJ sibling and live in the work-root `AGENTS.md`.
Read that before changing anything about the wire format — and note the fixtures
are generated from **this** implementation, so a format change starts here. From a
lone clone, the executable copy of the contract is
`test/fixtures/clipboard-contract.json` + `test/contract.test.ts`.

Implementation: `src/clipboardFormat.ts` — `buildPayloadInternal` + `escapeContent`
(build), `parseClipboard` + `unescapeContent` + `joinContent` (parse). The Kotlin
mirror is `ClipCode/src/main/kotlin/com/github/audichuang/clipcode/ClipboardPayloadFormatter.kt`
(build) + `ChangeTypeLabel.kt` / `ClipboardRestoreParser.kt` (labels + parse).

TS-side pins for the shared invariants:

- Header and label regexes use the explicit `ASCII_WS` class, **not** JS Unicode
  `\s` (which would treat a full-width-space-indented line as a header when Kotlin
  does not, splitting a phantom file cross-tool).
- `formatHeader` substitutes via `split('$FILE_PATH').join(...)`, never
  `replaceAll(str, str)` — a string replacement expands `$&`/`$$` and corrupts
  paths containing them, even in this tool's own round-trip.
- The `// clipcode-root:` line is emitted only for a **single-root copy context**
  (one workspace / source root, or a single-repo graph copy) — not merely "one
  VS Code window".

Beyond the frozen fixtures, round-trip is guarded by `test/clipboardFormat.test.ts`
and the e2e `test-e2e/suite/roundtrip.test.ts`.

## Roles in this repo

| Area | Role |
|---|---|
| root `src/` | Extension host: copy/restore, git-aware copy, path filters, History view, **inline blame** (`src/blame/`) |
| `graph/` | Vendored git-graph-plus **plus Snipcode Git**: commit graph webview, multi-repo **Changes** tree + commit box, full-width **Diff** tab (staged/unstaged, hunk/line stage). Own context: `graph/AGENTS.md` |

**Bundling (non-obvious):** webview assets ship via `scripts/copy-graph-assets.mjs`
into `dist/graph-webview/`. Extension-host code under `graph/src/` ships because
root `src/extension.ts` does `require('../graph/src/extension')`, so `build:host`
(esbuild) pulls it into `dist/extension.js`. To confirm a graph change shipped, grep
`dist/extension.js` (host) and/or `dist/graph-webview/{main,workbench,diff}.js`
(three classic webview bundles — see `graph/AGENTS.md`). **Do not** install the
standalone git-graph-plus extension alongside Snipcode (command/view id clash).

Snipcode-only edits inside `graph/` must be fenced with
`/* SNIPCODE-HOOK start/end */` so upstream re-syncs stay mergeable.

## Build / test

    npm run build        # graph deps + graph webview + host bundle
    npm test             # tsc compile + node --test (host unit tests)
    npm run test:e2e     # headless VS Code integration tests
    npx vsce package     # → clipcode-vscode-<version>.vsix

- `npm test` = **host** tests only. If you touch `graph/`, also run
  `cd graph && npx vitest run` (and prefer a single file when iterating).
- Judge pass/fail by the `pass N, fail 0` / `Tests …` text.

**A green test is not a spec.** Suites here have repeatedly locked the CURRENT
(buggy) behavior into their expectations — e.g. PR open/copy asserting symbolic
refs, pull asserting an unconditional stash pop — so a correct fix turns them
red. When a fix flips a test, first ask whether the assertion encoded intent or
just the status quo; invert status-quo tests in the SAME change, don't weaken
the fix to keep them green.

What `test:e2e` covers is whatever lives in `test-e2e/suite/`. What it still does
**not** exercise: git mutations (stage/commit/push), multi-repo staging, and
overwrite-conflict restore. The aspirational coverage matrix is
`docs/research/2026-07-11-e2e-test-strategy.md` §3 — **do not trust that doc's §1
"current guarantees" inventory**, it predates the boot handshake. Risk audit behind
it: `docs/research/2026-07-10-vscode-git-operations-audit.md`.

## Release

Pushing a `v<version>` tag runs `.github/workflows/publish.yml` (test → build →
e2e → `vsce publish`). **A release is not done when CI goes green** — the
Marketplace verifies and indexes the upload minutes later, so poll
`vsce show audichuang.clipcode-vscode --json` until `.versions[0].version` is the
new one before telling anyone it shipped (measured lag on real releases: 5–8
minutes after the publish step succeeded). Bump `package.json` **and**
`package-lock.json` — `npm ci` does not check the version field, so a stale
lockfile ships silently. Open VSX is not set up yet (namespace unclaimed) — VS
Code Marketplace only for now. (A `vscode-extension-release` skill automates
this, but it lives outside this repo.)

## Where to start in the code

**Copy / restore (ClipCode parity):** `src/clipboardFormat.ts`, `src/copy.ts` +
`src/restore.ts`, `src/gitCopy.ts` + `src/gitContent.ts`, `src/graphCopy.ts`,
`src/pathResolver.ts` + `src/filterMatcher.ts` + `src/settings.ts`.

**Inline blame:** `src/blame/` (toggle command + per-editor decorations; host-side,
not in the graph webview).

**Snipcode Git workbench + Diff + graph:** see `graph/AGENTS.md`. Entry points:
`graph/src/tree/changes-workbench.ts` (TreeView staging),
`graph/src/tree/commit-box-view.ts` (commit message webview),
`graph/src/panels/DiffPanel.ts` (full-width Diff tab),
`graph/src/panels/MainPanel.ts` (commit graph).

**PR compare tab** (base→head, inline diff, copy): `graph/webview-ui/src/components/pr/PrView.svelte`
+ `graph/src/git/git-service.ts` `commitsBetween` (base...HEAD three-dot). Snipcode
feature *inside* the vendored graph — fence with `SNIPCODE-HOOK`.

For full structure, read the directories — don't trust a hand-written tree.

## Permissions

Ask before publishing/tagging a release (it ships to real users) or editing
`.github/workflows/`. The `VSCE_PAT` secret lives in GitHub Actions secrets —
never put it in the repo.
