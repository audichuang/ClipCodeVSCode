# ClipCode for VS Code

ClipCode copies and restores files with the same clipboard format used by the IntelliJ ClipCode plugin.

## Commands

- `ClipCode: Copy to Clipboard`
- `ClipCode: Copy All Open Editors`
- `ClipCode: Copy Git Changes`
- `ClipCode: Paste and Restore Files`

## Git graph

Snipcode bundles the [git-graph-plus](https://github.com/the0807/git-graph-plus)
commit-graph view (open it with **Git Graph+: Open Git Graph**). Right-click a
commit, or a changed file in the commit details, and choose **Copy Full Source**
to copy that commit's file contents in the same clipboard format as
`Copy Git Changes` (git-style labels, deleted markers, rename labels).

> **Do not install the standalone `git-graph-plus` extension alongside Snipcode.**
> Snipcode ships git-graph-plus under its original `gitGraphPlus.*` command/view
> ids, so having both installed causes command-id collisions. Use one or the
> other, not both.

Install from a local package with:

```bash
code --install-extension clipcode-vscode-0.1.0.vsix
```

## Format

```text
// file: src/example.ts
export const value = 1;
```

Git-style labels are produced by `Copy Git Changes` and understood during restore:

```text
// file: [DELETED] src/old.ts
// This file has been deleted in this change
```

In multi-root workspaces, files from sibling roots use a root label such as:

```text
// file: shared-lib/src/example.ts
```
