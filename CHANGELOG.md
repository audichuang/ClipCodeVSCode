# Changelog

## 0.3.10

- **Paste & Restore handles an off-by-one folder level.** If a bundle was copied
  from a different folder depth than the current workspace (e.g. copied with the
  repo as root but restored into the parent that contains it, or vice-versa),
  restore now detects the consistent level offset by matching the paths against
  folders that already exist, and **asks you to confirm** before adjusting every
  path ("Adjust Paths" / "Use As-Is" / cancel). It only suggests a change when it's
  confident and unambiguous, and never moves files silently. Single-root
  workspaces only.

## 0.3.9

- **Hardening for the batched Copy Full Source (from a code audit).** A repo path
  containing a line break could misalign the `git cat-file --batch` request/response
  stream and copy wrong content; such paths are now excluded from the batch and read
  individually. And when a file-count limit is set, the batch no longer reads the
  whole commit's blobs past the limit. No user-visible behaviour change otherwise.

## 0.3.8

- **Much faster "Copy Full Source" for many files.** Content for every file in a
  commit is now read in a single `git cat-file --batch` process instead of one
  `git show` per file. VS Code's Git API serializes per-repo reads, so the earlier
  concurrency didn't fully help — ~86 files took ~5s. Batching collapses that to a
  single read pass. Falls back to per-file reads if the batch process can't start;
  output is unchanged.

## 0.3.7

- **No spurious Git error on first open in a parent-folder workspace.** When the
  workspace root isn't itself a git repo (the real repo is a subfolder, e.g.
  `inv-svc-console/`), Git Graph+'s initial remote-name lookup briefly ran
  `git remote` in the non-repo parent and surfaced `not a git repository` until
  repo discovery switched to the child repo. That transient lookup failure is now
  silent (empty remote list); the commit graph, diffs, and `git log` are
  unaffected.

## 0.3.6

- **Stop showing a spurious Git LFS error in the graph.** Some TFS / Azure DevOps
  LFS endpoints reject HTTP/2 on the lock-status API and return
  `HTTP_1_1_REQUIRED`. Opening a commit's details runs `git lfs locks`, so that
  reply used to surface as a Git Graph+ error. It is now treated as a benign,
  ignorable LFS lock-query failure — it only affects the LFS lock badge, never the
  commit graph, diffs, or `git log`.

## 0.3.5

- **Reliable copy → restore round-trip.** A file whose own content contained a
  line that looked like a ClipCode header (e.g. a literal `// file: …`) used to be
  split into a phantom file on paste; such lines are now escaped on copy and
  restored verbatim. Pasting recreates exactly what was copied. (The clipboard
  format is shared with the IntelliJ ClipCode plugin; both sides were updated in
  lock-step.)
- **Restore preserves content whitespace.** Restoring no longer trims a file's own
  leading indentation / interior blank lines (only the structural blank lines the
  format inserts between files are dropped).
- **Faster multi-file restore.** Restoring many files now writes them with bounded
  concurrency instead of one at a time (mirrors the earlier copy-side speedup);
  files that depend on each other (same path / parent dir) still write in order.
- Added an end-to-end copy→restore round-trip test.

## 0.3.4

- **Faster copying of many files.** "Copy Full Source" (from the graph) and
  "Copy Git Changes" used to read each file's content with one `git show`
  subprocess at a time, run strictly one after another — copying ~90 files took
  10+ seconds. Those reads now run with bounded concurrency (16 at a time), so a
  large selection copies in ~1–2s. Output (order, content, labels, limits) is
  unchanged.

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
