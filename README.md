# Snipcode

VS Code extension for **copy / restore** using the same clipboard format as the
IntelliJ [ClipCode](https://github.com/audichuang/ClipCode) plugin, plus a
bundled commit graph and a multi-repo **Snipcode Git** workbench.

Marketplace id: `audichuang.clipcode-vscode` · package name: `clipcode-vscode`

## Features

### Clipboard (ClipCode-compatible)

- **Copy** selected files, all open editors, or git changes (with
  `[NEW]` / `[MODIFIED]` / `[DELETED]` / `[MOVED]` labels)
- **Paste & restore** files from that clipboard text (including cross-tool:
  copy in IntelliJ ClipCode → restore here, and the reverse)
- Path filters, size/count limits, token-estimate notifications
- **Copy Full Source** from the graph (at a commit or uncommitted view)

### Snipcode Git

Activity Bar container **Snipcode Git**:

- Multi-repo **Changes** tree (Staged / Unstaged) with real stage / unstage / commit
- Shared **Commit** box (one message across selected repos; amend when single-repo)
- Full-width **Diff** tab: unified staged+unstaged, hunk/line stage, word-level
  highlighting, open full-file diff
- **Fetch / Pull / Push all repos** from the view toolbar, with ahead/behind badges
- Multi-select, filter repos, right-click **Copy as ClipCode**

### Graph & more

- Bundled **[git-graph-plus](https://github.com/the0807/git-graph-plus)** commit graph
  (**Git Graph+: Open Git Graph**)
- **PR compare** tab inside the graph (base…head three-dot)
- **Inline blame** (toggle on the active editor; reveal commit in the graph)

> **Do not install the standalone `git-graph-plus` extension alongside Snipcode.**
> Snipcode ships it under the original `gitGraphPlus.*` command/view ids — both
> installed at once causes command/view id collisions.

## Commands (selection)

| Command | Title |
|---|---|
| `clipcode.copyToClipboard` | Snipcode: Copy to Clipboard |
| `clipcode.copyAllOpenEditors` | Snipcode: Copy All Open Editors |
| `clipcode.copyGitChanges` | Snipcode: Copy Git Changes |
| `clipcode.pasteAndRestoreFiles` | Snipcode: Paste and Restore Files |
| `clipcode.blame.toggle` | Snipcode: Toggle Inline Blame |
| `snipcode.git.fetchAll` / `pullAll` / `pushAll` | Snipcode Git: Fetch/Pull/Push All Repos |
| `gitGraphPlus.open` | Git Graph+: Open Git Graph |

## Install

- **VS Code Marketplace:** search **Snipcode** or open
  [audichuang.clipcode-vscode](https://marketplace.visualstudio.com/items?itemName=audichuang.clipcode-vscode)
- **Local VSIX:**

```bash
npx @vscode/vsce package
code --install-extension clipcode-vscode-<version>.vsix
```

## Format (shared with IntelliJ ClipCode)

```text
// file: src/example.ts
export const value = 1;
```

Git-style labels from `Copy Git Changes` / graph Copy Full Source:

```text
// file: [DELETED] src/old.ts
// This file has been deleted in this change
```

Optional single-root metadata (parsers drop it; restore uses it for folder align):

```text
// clipcode-root: my-project
// file: src/example.ts
```

Content lines that look like headers are escaped with `//clipcode-esc: ` so they
round-trip instead of splitting into phantom files.

In multi-root workspaces, sibling roots use a root label in the path, e.g.:

```text
// file: shared-lib/src/example.ts
```

## Development

See `AGENTS.md` (and `graph/AGENTS.md` for the vendored graph + Snipcode Git).

```bash
npm run build        # graph deps + webviews + host bundle
npm test             # host unit tests
cd graph && npx vitest run   # graph/webview tests (when you touch graph/)
npm run test:e2e     # headless VS Code integration tests
```

## Release

Pushing a `v*` tag runs `.github/workflows/publish.yml` → Marketplace.
A release is **not** done when CI goes green — poll until the new version is
live on the Marketplace (see the `vscode-extension-release` skill in the
workspace). Open VSX is not published yet.

## License

MIT — see `LICENSE.txt`. Vendored git-graph-plus retains its own license under
`graph/`.
