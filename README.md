# ClipCode for VS Code

ClipCode copies and restores files with the same clipboard format used by the IntelliJ ClipCode plugin.

## Commands

- `ClipCode: Copy to Clipboard`
- `ClipCode: Copy All Open Editors`
- `ClipCode: Copy Git Changes`
- `ClipCode: Paste and Restore Files`

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
