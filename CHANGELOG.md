# Changelog

## 0.3.3

- **Shift-click range selection** in the commit Changes panel: hold **Shift** and
  click a changed file (or a folder) to select the whole range from the current
  anchor to the clicked item, alongside the existing Ctrl/Cmd-click toggle. Works
  in the committed-commit view; folders extend the range across every file under
  them.
- Fix `scripts/copy-graph-assets.mjs` to resolve its own path via `fileURLToPath`
  instead of `new URL(...).pathname` — the latter produced a broken `/C:/…` path
  with percent-encoded spaces on Windows, breaking the webview asset copy step.

## 0.3.2

- **Copy Full Source** now also works when **multiple commits are selected**
  (compare / multi-commit view): the file and folder right-click menus copy each
  file at the newer end of the selection (`compareRef2`). Previously the menu item
  only appeared for a single selected commit. Single-commit and uncommitted
  behaviour is unchanged.

## 0.3.1

- **Copy Full Source** now appears consistently everywhere in the graph's Changes
  panel: committed-commit **folders**, **uncommitted** (working-tree) files, and
  **uncommitted folders** (previously the folder right-click did nothing and the
  uncommitted file menu only had Open File / Open Changes). Uncommitted copies the
  current working-tree content; committed copies the file at that commit. Folder
  copy includes every changed file under the folder.

## 0.3.0

- Bundle the [git-graph-plus](https://github.com/the0807/git-graph-plus) commit
  graph view (open with **Git Graph+: Open Git Graph**).
- Add **Copy Full Source** to the commit right-click menu (whole commit, files
  lazy-loaded) and to the changed-file right-click menu in the commit details
  (single or multi-select). Both copy the commit's file contents in the same
  clipboard format as `Copy Git Changes` — git-style labels, deleted markers, and
  rename (`[MOVED]`) labels.
- git-graph-plus ships under its original `gitGraphPlus.*` command/view ids; do
  not install the standalone git-graph-plus extension alongside Snipcode (see
  README).

## 0.2.1

- Existing ClipCode copy/restore commands.
