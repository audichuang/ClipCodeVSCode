# Commit Workbench B-2d — Line-level staging + Word-level diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Snipcode's full-tab commit diff closer to IntelliJ by adding (A) per-line stage/unstage inside a hunk and (C) intraline word-level highlighting of the changed characters.

**Architecture:** A is the load-bearing, testable feature and ships first: a new `buildForwardPatchLines` mirrors the existing `buildReversePatch` (old/new sides swapped) to emit a single-hunk `git apply --cached` patch narrowed to selected `+/-` lines; `GitService.stageLines/unstageLines` reuse it exactly like `stageHunks/unstageHunks`; the existing FileDiffView gutter line-selection UI (built for `onReverseLines`) is wired to a new `onStageLines` hook. C is layered on afterward: a pure LCS word-diff util computes changed char ranges per delete/add line pair, then a Shiki-aware overlay splits Shiki's colored token spans at those range boundaries so a `word-diff` background class highlights only changed characters without breaking syntax colors.

**Tech Stack:** TypeScript, Node `child_process` git CLI (extension host, no `vscode` import in `git/`), Svelte 5 runes webview, Shiki syntax highlighter, Vitest (backend real-git + webview happy-dom projects), three self-contained Vite webview bundles (graph / workbench / diff).

## Global Constraints

- **`git/` modules must not import `vscode`** — keep `patch-builder.ts` / `git-service.ts` unit-testable against the real git CLI.
- **Every edit inside `graph/webview-ui` or `graph/src` that is a Snipcode addition must be fenced** with `/* SNIPCODE-HOOK start … */ … /* SNIPCODE-HOOK end */` (or a single-line `/* SNIPCODE-HOOK (B-2d): … */`) so an upstream git-graph-plus re-sync can find it. Follow the 6+ existing fences in `FileDiffView.svelte` and the `onStageHunk` precedent.
- **Each webview bundle stays self-contained** — no new top-level `import` that would split a shared chunk. New pure utils (`word-diff.ts`) are plain modules bundled into `diff.js` via the existing single-entry Vite builds; do not add a new entry.
- **`lineIndices` index into a hunk's `DiffLine[]`** exactly as `parseDiff` (git-parser) produces them and exactly as `FileDiffView` renders them — the same convention `buildReversePatch` documents. Never renumber.
- **Preserve B-2c**: per-hunk Stage/Unstage (`onStageHunk` / `stageHunks` / `unstageHunks` / `diffStageHunk`) must keep working unchanged.
- **Test commands** (run from repo root `/home/audichuang/research/IntellijPlugin/ClipCodeVSCode`):
  - Backend unit/integration: `cd graph && npx vitest run <path> --project backend`
  - Webview: `cd graph && npx vitest run <path> --project webview`
  - Build all three bundles + host: `cd graph && npm run build`
  - Typecheck host: `cd graph && npm run lint`
- **Scope fence v1 — DO:** A (line stage/unstage end-to-end + tests) and C (word-diff compute + Shiki overlay). **DO NOT (v2):** IntelliJ `»`/`«` gutter arrow styling, Staged↔Local two-way move view model, image/binary intraline diff, changelists, dynamic repo.

---

## File Structure

**A — backend:**
- `graph/src/git/patch-builder.ts` — add `buildForwardPatchLines(rawFileDiff, hunkIndex, lineIndices?)`.
- `graph/src/git/__tests__/patch-builder.test.ts` — pure unit tests for the new builder.
- `graph/src/git/git-service.ts` — add `stageLines` / `unstageLines`; import the new builder.
- `graph/src/git/__tests__/integration/line-staging.integration.test.ts` — real-git integration (new file).

**A — wiring + UI:**
- `graph/src/tree/changes-workbench.ts` — add `stageLines` / `unstageLines`.
- `graph/src/panels/DiffPanel.ts` — handle a new `diffStageLines` webview message.
- `graph/webview-ui/src/components/commit/FileDiffView.svelte` — add `onStageLines` prop + Stage/Unstage Selected Lines button; let gutter line-selection turn on for the staging view.
- `graph/webview-ui/src/diff/messaging.ts` — add `postStageLines`; broaden the error handler.
- `graph/webview-ui/src/diff/Diff.svelte` — pass `onStageLines`.
- `graph/webview-ui/src/lib/i18n/{en,ko,zh}.ts` — `file.stageLines` / `file.unstageLines`.
- `graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts` — webview test for the hook.

**C — word diff:**
- `graph/webview-ui/src/lib/utils/word-diff.ts` — pure LCS word diff + hunk pairing (new file).
- `graph/webview-ui/src/lib/utils/__tests__/word-diff.test.ts` — unit tests (new file).
- `graph/webview-ui/src/lib/utils/highlighter.ts` — add `highlightLineWithRanges`.
- `graph/webview-ui/src/components/commit/FileDiffView.svelte` — compute per-line ranges, overlay in the highlight effect, add CSS.

---

## Task 1: `buildForwardPatchLines` — forward (stage) line-level patch

**Files:**
- Modify: `graph/src/git/patch-builder.ts` (append a new exported function; reuse existing `parseFileDiff`, `rewriteHunkHeader`, `normalizeWholeFileHeader`, `NO_NEWLINE_MARKER`, and the `PatchEntry` / `BodyLine` types already in the file)
- Test: `graph/src/git/__tests__/patch-builder.test.ts`

**Interfaces:**
- Produces: `export function buildForwardPatchLines(rawFileDiff: string, hunkIndex: number, lineIndices?: number[]): string`
- Consumes: existing `parseFileDiff`, `rewriteHunkHeader`, `normalizeWholeFileHeader`, `NO_NEWLINE_MARKER`, interfaces `PatchEntry`, `BodyLine` (all already defined in `patch-builder.ts`).

**Forward line-level semantics (baseline = the current index; patch applied with `git apply --cached`), the mirror of `buildReversePatch` with old/new swapped:**
- selected `+` → keep `+` (added to index) — same as reverse.
- **unselected `+` → OMIT entirely** (not in index, not being staged). NOT demoted to context — a context line must exist in the index baseline and an unstaged addition does not. *(This is the one line that differs from reverse, which demotes unselected adds to context.)*
- selected `-` → keep `-` (removed from index) — same as reverse.
- unselected `-` → demote to context ` ` (stays in index). *(Reverse drops unselected deletes; forward keeps them.)*
- The OLD side (index) always reaches EOF (deletions never dropped); the NEW side (staged result) can lose a trailing line when an unselected trailing addition is omitted — so no-newline handling mirrors `buildReversePatch` with sides swapped.

- [ ] **Step 1: Write the failing pure unit tests**

Append to `graph/src/git/__tests__/patch-builder.test.ts`. `SAMPLE` and `parseDiff` are already imported at the top of that file (the `buildReversePatch` block uses them). Add the import for the new builder to the existing top import line so it reads:

```typescript
import { buildReversePatch, buildForwardPatch, buildForwardPatchLines } from '../patch-builder';
```

Then append this describe block at the end of the file:

```typescript
describe('buildForwardPatchLines', () => {
  // SAMPLE (declared at the top of this file):
  //   @@ -1,4 +1,5 @@
  //    line1        (ctx, idx 0)
  //   -line2        (del, idx 1)
  //   +line2-changed(add, idx 2)
  //   +line2b       (add, idx 3)
  //    line3        (ctx, idx 4)
  //    line4        (ctx, idx 5)

  it('stages the whole hunk verbatim (recounted) when no lines are given', () => {
    // Selecting every changed line reproduces the hunk with a recounted header.
    const patch = buildForwardPatchLines(SAMPLE, 0);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,5 @@',
        ' line1',
        '-line2',
        '+line2-changed',
        '+line2b',
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('omits unselected additions (does NOT demote them to context)', () => {
    // Stage only the deletion (idx 1) and the first addition (idx 2); the second
    // addition (idx 3, line2b) is UNSELECTED → dropped entirely, not demoted.
    const patch = buildForwardPatchLines(SAMPLE, 0, [1, 2]);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,4 @@', // old 4 (ctx+ctx+ctx+del), new 4 (ctx+add+ctx+ctx)
        ' line1',
        '-line2',
        '+line2-changed',
        // line2b omitted — neither `+` nor context
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('demotes unselected deletions to context', () => {
    // Stage only the two additions (idx 2,3); the deletion (idx 1) is UNSELECTED
    // → demoted to context so it stays in the index.
    const patch = buildForwardPatchLines(SAMPLE, 0, [2, 3]);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,6 @@', // old: line1,line2(ctx),line3,line4 = 4; new: +2 adds = 6
        ' line1',
        ' line2', // unselected delete → context
        '+line2-changed',
        '+line2b',
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('keeps a whole-new-file /dev/null header when staging a subset of its adds', () => {
    // A brand-new file's additions never create context on the old side, so the
    // old side stays empty and the `--- /dev/null` header remains valid.
    const NEW_FILE = [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+a',
      '+b',
      '+c',
      '',
    ].join('\n');
    // Stage only the first and third additions (idx 0 and 2).
    const patch = buildForwardPatchLines(NEW_FILE, 0, [0, 2]);
    expect(patch).toBe(
      [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..abc1234',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+c', // b omitted; still a pure /dev/null add of two lines
        '',
      ].join('\n'),
    );
  });

  it('preserves no-newline markers on both sides when staging the whole hunk', () => {
    const noEof = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const patch = buildForwardPatchLines(noEof, 0);
    expect(patch).toContain('-old\n\\ No newline at end of file');
    expect(patch).toContain('+new\n\\ No newline at end of file');
  });

  it('throws for an out-of-range hunk index', () => {
    expect(() => buildForwardPatchLines(SAMPLE, 5)).toThrow(/not found/);
  });

  it('throws when the selection contains no changed lines', () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const ctxIdx = hunk.lines.findIndex((l) => l.type === 'context');
    expect(() => buildForwardPatchLines(SAMPLE, 0, [ctxIdx])).toThrow(/No changed lines/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd graph && npx vitest run src/git/__tests__/patch-builder.test.ts --project backend`
Expected: FAIL — `buildForwardPatchLines is not a function` (not yet exported).

- [ ] **Step 3: Implement `buildForwardPatchLines`**

Append to `graph/src/git/patch-builder.ts` (after `buildForwardPatch`):

```typescript
/**
 * Build a single-hunk patch that stages ONLY the selected changed lines of one
 * hunk from an index→working diff, for `git apply --cached`.
 *
 * Selection semantics (forward / stage direction; baseline = the current index):
 *  - omitted lineIndices → stage every changed (+/-) line in the hunk;
 *  - provided → stage only the listed +/- lines:
 *     - selected `+` → kept as `+` (added to the index);
 *     - UNSELECTED `+` → OMITTED entirely (not in the index, not being staged).
 *       It does NOT demote to context — unlike reverse — because a context line
 *       must exist in the baseline/index and an unstaged addition does not;
 *     - selected `-` → kept as `-` (removed from the index);
 *     - UNSELECTED `-` → demoted to context ` ` (it stays in the index).
 *
 * This is the mirror image of {@link buildReversePatch} with the old/new sides
 * swapped: here the OLD side (the index baseline) always reaches EOF because
 * deletions are never dropped, while the NEW side (the staged result) can lose a
 * trailing line when an unselected trailing addition is omitted — so the
 * no-newline re-anchoring mirrors buildReversePatch with sides swapped.
 *
 * @throws if the hunk index is out of range or nothing stageable is selected.
 */
export function buildForwardPatchLines(rawFileDiff: string, hunkIndex: number, lineIndices?: number[]): string {
  const { header, hunks } = parseFileDiff(rawFileDiff);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found in diff`);
  }

  const selected = lineIndices ? new Set(lineIndices) : null;
  const isStaging = (idx: number, kind: PatchEntry['kind']): boolean =>
    kind !== 'context' && (selected ? selected.has(idx) : true);

  // Each side's original EOF-newline state, from the ORIGINAL hunk markers
  // (identical derivation to buildReversePatch).
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const entry of hunk.entries) {
    if (entry.markers.length === 0) { continue; }
    if (entry.kind === 'context') { oldNoNewline = true; newNoNewline = true; }
    else if (entry.kind === 'delete') { oldNoNewline = true; }
    else { newNoNewline = true; }
  }

  // Whether the hunk's final NEW-side entry survives onto the new side of our
  // reconstruction (so the new side still reaches new-EOF). Context always
  // survives; a trailing add survives only if selected. Deletions aren't on the
  // new side, so scan past them. (Mirror of buildReversePatch's oldReachesEof.)
  let newReachesEof = false;
  for (let i = hunk.entries.length - 1; i >= 0; i--) {
    const entry = hunk.entries[i];
    if (entry.kind === 'context') { newReachesEof = true; break; }
    if (entry.kind === 'add') { newReachesEof = isStaging(i, 'add'); break; }
    // 'delete' — not on the new side; keep scanning.
  }

  const bodyLines: BodyLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let stagedAny = false;

  for (let i = 0; i < hunk.entries.length; i++) {
    const entry = hunk.entries[i];

    if (entry.kind === 'context') {
      bodyLines.push({ text: entry.text, onOld: true, onNew: true });
      oldCount++;
      newCount++;
    } else if (entry.kind === 'add') {
      if (isStaging(i, 'add')) {
        // Keep as an addition (new side only); apply --cached adds it to the index.
        bodyLines.push({ text: entry.text, onOld: false, onNew: true });
        newCount++;
        stagedAny = true;
      }
      // Unselected addition: OMIT it — not in the index and we aren't staging it.
    } else {
      if (isStaging(i, 'delete')) {
        // Keep as a removal (old side only); apply --cached removes it from the index.
        bodyLines.push({ text: entry.text, onOld: true, onNew: false });
        oldCount++;
        stagedAny = true;
      } else {
        // Demote to context: the line stays in the index (both sides).
        bodyLines.push({ text: ' ' + entry.text.slice(1), onOld: true, onNew: true });
        oldCount++;
        newCount++;
      }
    }
  }

  if (!stagedAny) {
    throw new Error('No changed lines selected to stage');
  }

  // Re-attach no-newline markers from the RECONSTRUCTED body (mirror of reverse,
  // old/new swapped).
  let lastOld = -1;
  let lastNew = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].onOld) { lastOld = i; }
    if (bodyLines[i].onNew) { lastNew = i; }
  }

  // Old side always reaches old-EOF (deletions never dropped: selected stay `-`,
  // unselected demote to context — both remain on the old side). It ends
  // unterminated iff the old file did.
  const oldEndsNoNewline = oldNoNewline && lastOld !== -1;

  // New side (the staged result). Mirror of buildReversePatch's oldEndsNoNewline.
  let newEndsNoNewline = false;
  if (lastNew !== -1) {
    if (lastNew === lastOld) {
      newEndsNoNewline = oldNoNewline || (newNoNewline && newReachesEof);
    } else if (lastNew > lastOld) {
      // Kept additions trail the last shared/old line → new side reaches new-EOF.
      newEndsNoNewline = newNoNewline && newReachesEof;
    } else {
      // Kept deletions (old-only) trail the new side's last line. Removing them on
      // the new side leaves that shared line last, so the result ends iff old did.
      newEndsNoNewline = oldNoNewline;
    }
  }

  const body: string[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const ln = bodyLines[i];
    const isOldTerm = oldEndsNoNewline && i === lastOld;
    const isNewTerm = newEndsNoNewline && i === lastNew;

    if (isOldTerm && isNewTerm) {
      // Same shared trailing line terminates both sides → one marker.
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isNewTerm && i < lastOld && ln.onOld && ln.onNew) {
      // Shared line that is the new-side terminator but old-only (kept-delete)
      // lines follow: split so the marker terminates the new side without
      // truncating the old. The split contributes one old + one new line — the
      // same as the context line it replaces — so the running counts are unchanged.
      const content = ln.text.slice(1);
      body.push('+' + content, NO_NEWLINE_MARKER, '-' + content);
    } else if (isNewTerm) {
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isOldTerm) {
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else {
      body.push(ln.text);
    }
  }

  const headerLine = rewriteHunkHeader(hunk.headerLine, oldCount, newCount);
  const finalHeader = normalizeWholeFileHeader(header, oldCount, newCount);
  return [...finalHeader, headerLine, ...body].join('\n') + '\n';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd graph && npx vitest run src/git/__tests__/patch-builder.test.ts --project backend`
Expected: PASS (all `buildForwardPatchLines` tests green; the existing `buildReversePatch` / `buildForwardPatch` tests still green).

- [ ] **Step 5: Typecheck**

Run: `cd graph && npm run lint`
Expected: no errors (judge by the absence of `error TS…` lines, not `$?`).

- [ ] **Step 6: Commit**

```bash
git add graph/src/git/patch-builder.ts graph/src/git/__tests__/patch-builder.test.ts
git commit -m "feat(graph): 新增 buildForwardPatchLines 支援逐行 stage patch"
```

---

## Task 2: `GitService.stageLines` / `unstageLines` — real-git line staging

**Files:**
- Modify: `graph/src/git/git-service.ts` (import line 17; add two methods near `stageHunks`/`unstageHunks` around line 2319; reuse `workingFileDiffRaw`, `stagedFileDiffRaw`, `assertHunkStageable`)
- Test: `graph/src/git/__tests__/integration/line-staging.integration.test.ts` (new file)

**Interfaces:**
- Consumes: `buildForwardPatchLines` (Task 1); existing private `workingFileDiffRaw(file): Promise<string>`, `stagedFileDiffRaw(file): Promise<string>`, module-level `assertHunkStageable(rawFileDiff, file)`.
- Produces:
  - `async stageLines(file: string, hunkIndex: number, lineIndices: number[]): Promise<void>`
  - `async unstageLines(file: string, hunkIndex: number, lineIndices: number[]): Promise<void>`

**Why real git is the gate:** the no-newline / count logic in Task 1 is only fully proven by `git apply --cached` succeeding and producing the intended index. These integration tests assert the resulting index/working state, not exact patch bytes.

- [ ] **Step 1: Write the failing integration tests**

Create `graph/src/git/__tests__/integration/line-staging.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

// A single hunk with two adjacent changed lines so `lineIndices` selects a
// subset WITHIN one hunk (unlike hunk-staging which selects whole hunks).
//   base:    L1 / A / B / L4
//   changed: L1 / A2 / B2 / L4   → one hunk: -A +A2 -B +B2 (indices 1,2,3,4)
const BASE = 'L1\nA\nB\nL4\n';
const CHANGED = 'L1\nA2\nB2\nL4\n';

describe('GitService integration — stageLines / unstageLines', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    writeFile(repo.path, 'f.txt', CHANGED); // one unstaged hunk, nothing staged
  });
  afterEach(() => repo.cleanup());

  it('stages only the A→A2 change, leaving B→B2 unstaged', async () => {
    // The hunk parses as: 0 ctx L1, 1 del A, 2 add A2, 3 del B, 4 add B2, 5 ctx L4.
    // Stage just the A→A2 lines (indices 1 and 2).
    await svc.stageLines('f.txt', 0, [1, 2]);

    // Index now has A2 but NOT B2.
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+A2');
    expect(cached).not.toContain('+B2');

    // The index blob has A2 (staged) but still old B (unstaged part not applied).
    const indexBlob = runGit(repo.path, ['show', ':f.txt']);
    expect(indexBlob).toContain('\nA2\n');
    expect(indexBlob).toContain('\nB\n');

    // The working tree is untouched — still has both edits.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');
  });

  it('unstages only the A→A2 change, leaving B→B2 staged', async () => {
    runGit(repo.path, ['add', 'f.txt']); // stage the whole file (both changes)
    await svc.unstageLines('f.txt', 0, [1, 2]);

    // Index keeps B2 but drops A2 back to unstaged.
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+B2');
    expect(cached).not.toContain('+A2');
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim().slice(0, 2)).toBe('MM');
  });

  it('stages a subset of a file that ends without a trailing newline', async () => {
    // no-EOF file: base "P\nQ" (no final newline) → working "P2\nQ2" (no final
    // newline). Stage only P→P2. Must apply cleanly and keep Q's original value
    // in the index, still unterminated.
    commit(repo.path, 'noeof-base', { 'g.txt': 'P\nQ' });   // no trailing newline
    writeFile(repo.path, 'g.txt', 'P2\nQ2');                 // no trailing newline
    // Hunk: 0 del P, 1 add P2, 2 del Q, 3 add Q2. Stage P→P2 (indices 0,1).
    await svc.stageLines('g.txt', 0, [0, 1]);
    const cached = runGit(repo.path, ['diff', '--cached', 'g.txt']);
    expect(cached).toContain('+P2');
    expect(cached).not.toContain('+Q2');
    const indexBlob = runGit(repo.path, ['show', ':g.txt']);
    expect(indexBlob).toBe('P2\nQ'); // P2 staged, Q unchanged, still no trailing newline
  });

  it('throws when the file has no unstaged changes', async () => {
    runGit(repo.path, ['checkout', '--', 'f.txt']);
    await expect(svc.stageLines('f.txt', 0, [1, 2])).rejects.toThrow(/no unstaged changes/);
  });

  it('throws when the file has no staged changes', async () => {
    await expect(svc.unstageLines('f.txt', 0, [1, 2])).rejects.toThrow(/no staged changes/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd graph && npx vitest run src/git/__tests__/integration/line-staging.integration.test.ts --project backend`
Expected: FAIL — `svc.stageLines is not a function`.

- [ ] **Step 3: Import the new builder**

In `graph/src/git/git-service.ts`, change the import on line 17 from:

```typescript
import { buildReversePatch, buildForwardPatch } from './patch-builder';
```

to:

```typescript
import { buildReversePatch, buildForwardPatch, buildForwardPatchLines } from './patch-builder';
```

- [ ] **Step 4: Add `stageLines` / `unstageLines`**

In `graph/src/git/git-service.ts`, immediately after the `unstageHunks` method (it ends at the line `await this.exec(['apply', '--cached', '--reverse'], { stdin: patch });` around line 2319), insert:

```typescript
  /**
   * Stage ONLY the selected changed lines of ONE hunk of a file's unstaged
   * (index→working) diff into the index — the line-level counterpart of
   * stageHunks. Builds a narrowed forward patch from the SAME diff the Diff
   * webview rendered (workingFileDiffRaw) and `git apply --cached`s it.
   * `hunkIndex`/`lineIndices` index that diff's parsed hunk/DiffLine list.
   */
  async stageLines(file: string, hunkIndex: number, lineIndices: number[]): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.workingFileDiffRaw(file);
    if (!raw.trim()) { throw new Error(`no unstaged changes to stage for ${file}`); }
    assertHunkStageable(raw, file);
    const patch = buildForwardPatchLines(raw, hunkIndex, lineIndices);
    // exec routes 'apply' through withMutationLock; --cached stages into the index only.
    await this.exec(['apply', '--cached'], { stdin: patch });
  }

  /**
   * Unstage ONLY the selected changed lines of ONE hunk of a file's staged
   * (HEAD→index) diff back to the working tree — the line-level counterpart of
   * unstageHunks. Builds a narrowed forward patch from the STAGED diff and
   * reverse-applies it to the index (`git apply --cached --reverse`).
   */
  async unstageLines(file: string, hunkIndex: number, lineIndices: number[]): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.stagedFileDiffRaw(file);
    if (!raw.trim()) { throw new Error(`no staged changes to unstage for ${file}`); }
    assertHunkStageable(raw, file);
    const patch = buildForwardPatchLines(raw, hunkIndex, lineIndices);
    await this.exec(['apply', '--cached', '--reverse'], { stdin: patch });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd graph && npx vitest run src/git/__tests__/integration/line-staging.integration.test.ts --project backend`
Expected: PASS (5 tests). If the no-EOF test fails on `git apply`, the marker branch in Task 1 is the suspect — debug with `superpowers:systematic-debugging` by printing the patch and running `git apply --cached --check` manually.

- [ ] **Step 6: Run the hunk-staging suite to confirm no regression**

Run: `cd graph && npx vitest run src/git/__tests__/integration/hunk-staging.integration.test.ts --project backend`
Expected: PASS (B-2c per-hunk staging untouched).

- [ ] **Step 7: Commit**

```bash
git add graph/src/git/git-service.ts graph/src/git/__tests__/integration/line-staging.integration.test.ts
git commit -m "feat(graph): GitService 新增 stageLines/unstageLines 逐行 stage"
```

---

## Task 3: Host wiring — ChangesWorkbench + DiffPanel `diffStageLines`

**Files:**
- Modify: `graph/src/tree/changes-workbench.ts` (after `unstageHunks`, ~line 222; reuse `runExclusive`, `svcFor`, `refresh`, `diffPanel.refreshIfCurrent`)
- Modify: `graph/src/panels/DiffPanel.ts` (add a message branch in the `onDidReceiveMessage` handler, ~line 90)

**Interfaces:**
- Consumes: `GitService.stageLines/unstageLines` (Task 2); existing `ChangesWorkbench.stageHunks` pattern.
- Produces:
  - `ChangesWorkbench.stageLines(repoPath, file, hunkIndex, lineIndices: number[]): Promise<void>`
  - `ChangesWorkbench.unstageLines(repoPath, file, hunkIndex, lineIndices: number[]): Promise<void>`
  - DiffPanel handles webview message `{ type: 'diffStageLines', payload: { repoPath, file, side: 'staged'|'unstaged', hunkIndex, lineIndices } }`.

*(No backend unit test here — this layer is thin passthrough proven end-to-end by Task 2's integration + Task 4's webview test. `npm run lint` + `npm run build` are the gates. This is why setup wiring is folded into one task rather than split.)*

- [ ] **Step 1: Add `stageLines` / `unstageLines` to ChangesWorkbench**

In `graph/src/tree/changes-workbench.ts`, immediately after the `unstageHunks` method (ends `this.diffPanel?.refreshIfCurrent(repoPath, file, 'staged');`, ~line 222), insert:

```typescript
  /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage, mirrors stageHunks. */
  /** Stage the selected changed lines of one hunk of an unstaged file. */
  async stageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageLines(file, hunkIndex, lineIndices));
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file, 'unstaged');
  }

  /** Unstage the selected changed lines of one hunk of a staged file. */
  async unstageLines(repoPath: string, file: string, hunkIndex: number, lineIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageLines(file, hunkIndex, lineIndices));
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file, 'staged');
  }
  /* SNIPCODE-HOOK end */
```

- [ ] **Step 2: Handle `diffStageLines` in DiffPanel**

In `graph/src/panels/DiffPanel.ts`, inside `panel.webview.onDidReceiveMessage`, immediately BEFORE the existing `if (msg?.type !== 'diffStageHunk') { return; }` guard (~line 90), insert a new branch:

```typescript
      /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage. */
      if (msg?.type === 'diffStageLines') {
        const { repoPath, file, side, hunkIndex, lineIndices } = msg.payload ?? {};
        const idx = Number(hunkIndex);
        const lines = Array.isArray(lineIndices) ? lineIndices.map(Number) : [];
        try {
          if (side === 'unstaged') {
            await this.workbench.stageLines(String(repoPath), String(file), idx, lines);
          } else {
            await this.workbench.unstageLines(String(repoPath), String(file), idx, lines);
          }
          // stageLines/unstageLines call refreshIfCurrent → re-push the new diff.
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message } });
          void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
        }
        return;
      }
      /* SNIPCODE-HOOK end */
```

- [ ] **Step 3: Typecheck the host**

Run: `cd graph && npm run lint`
Expected: no `error TS…` output. (`workbench` is typed `ChangesWorkbench`, so the new methods resolve.)

- [ ] **Step 4: Commit**

```bash
git add graph/src/tree/changes-workbench.ts graph/src/panels/DiffPanel.ts
git commit -m "feat(graph): DiffPanel 與 ChangesWorkbench 串接 diffStageLines"
```

---

## Task 4: Webview — FileDiffView `onStageLines` + Diff wiring + i18n

**Files:**
- Modify: `graph/webview-ui/src/components/commit/FileDiffView.svelte`
- Modify: `graph/webview-ui/src/diff/messaging.ts`
- Modify: `graph/webview-ui/src/diff/Diff.svelte`
- Modify: `graph/webview-ui/src/lib/i18n/en.ts`, `ko.ts`, `zh.ts`
- Test: `graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts`

**Interfaces:**
- Produces: FileDiffView prop `onStageLines?: (target: { file: string; hunkIndex: number; lineIndices: number[] }) => void`; `postStageLines(hunkIndex: number, lineIndices: number[]): void` in messaging.
- Consumes: existing gutter line-selection state (`lineSel`, `selectedChangedIndices`, `startLineSelect`, `isHunkComplete`), existing `onStageHunk` / `stageBusy` props, host message `diffStageLines` (Task 3).

- [ ] **Step 1: Write the failing webview test**

Append to `graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts` (the file already imports `render, cleanup, fireEvent` from `@testing-library/svelte`, `vi`, and defines `sampleDiff()`; add `screen` to the testing-library import and `i18n` is already imported). Add this test — set the locale to English first so the button label is deterministic:

```typescript
  it('offers Stage Selected Lines and posts the changed indices (unstaged view)', async () => {
    i18n.setLocale('en');
    const onStageLines = vi.fn();
    const { container } = render(FileDiffView, {
      diff: sampleDiff(),
      staged: false,
      onStageHunk: vi.fn(),   // turns the staging view on (canStage)
      onStageLines,
    });

    // sampleDiff hunk 0 lines: 0 ctx a, 1 del b, 2 add b2, 3 ctx c, 4 add d1, 5 add d2, 6 ctx e.
    // Select the delete line (index 1) by a left mousedown on its gutter.
    const gutters = container.querySelectorAll('.line-gutter');
    await fireEvent.mouseDown(gutters[1], { button: 0 });

    // The "Stage Selected Lines (1)" button now appears; click it.
    const btn = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.includes('Stage Selected Lines'),
    );
    expect(btn).toBeTruthy();
    await fireEvent.click(btn!);

    expect(onStageLines).toHaveBeenCalledWith({ file: 'src/foo.ts', hunkIndex: 0, lineIndices: [1] });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd graph && npx vitest run src/components/commit/__tests__/FileDiffView.test.ts --project webview`
Expected: FAIL — the "Stage Selected Lines" button is not found (no `onStageLines` handling yet).

- [ ] **Step 3: Add i18n keys**

In `graph/webview-ui/src/lib/i18n/en.ts`, after the `'file.unstageHunk'` line (~666), add:

```typescript
  'file.stageLines': 'Stage Selected Lines',
  'file.unstageLines': 'Unstage Selected Lines',
```

In `graph/webview-ui/src/lib/i18n/ko.ts`, after its `'file.unstageHunk'` (~667):

```typescript
  'file.stageLines': '선택한 줄 스테이지',
  'file.unstageLines': '선택한 줄 스테이지 해제',
```

In `graph/webview-ui/src/lib/i18n/zh.ts`, after its `'file.unstageHunk'` (~667):

```typescript
  'file.stageLines': '暂存选定行',
  'file.unstageLines': '取消暂存选定行',
```

- [ ] **Step 4: Add the `onStageLines` prop, action, and button to FileDiffView**

In `graph/webview-ui/src/components/commit/FileDiffView.svelte`:

(a) In the `Props` interface, right after the `onStageHunk?` block (the `/* SNIPCODE-HOOK ... no onStageLines */` comment, ~line 62), replace that trailing sentence and add the new prop. Change the comment block ending `...so there is no onStageLines. */` to `...per-hunk. Line-level staging (B-2d) is onStageLines below. */` and add:

```typescript
    /* SNIPCODE-HOOK (B-2d): line-level staging. Fires with the file + hunk index
       + the gutter-selected changed line indices, mirroring onReverseLines. */
    onStageLines?: (target: { file: string; hunkIndex: number; lineIndices: number[] }) => void;
```

(b) Add `onStageLines` to the `$props()` destructure (~line 71):

```typescript
  let { diff, commitHash, staged = false, stacked = false, heading, onReverse, onReverseHunk, onReverseLines, onStageHunk, onStageLines, diffMode: diffModeProp, hideModeToggle = false, stageBusy }: Props = $props();
```

(c) In the staging hook block (~line 80-87), add a `canSelectLines` derived and a `stageSelectedLines` action:

```typescript
  /* SNIPCODE-HOOK start (B-2c): staging affordance gate + action. */
  const canStage = $derived(!!onStageHunk);
  /* SNIPCODE-HOOK (B-2d): gutter line-selection turns on for the reverse view
     (canReverse) OR the staging view (canStage). */
  const canSelectLines = $derived(canReverse || canStage);

  function stageHunk(hunkIndex: number) {
    if (!onStageHunk || !isHunkComplete(hunkIndex)) return;
    onStageHunk({ file: diff.file, hunkIndex });
  }

  /* SNIPCODE-HOOK (B-2d): stage/unstage just the gutter-selected changed lines. */
  function stageSelectedLines(hunkIndex: number) {
    if (!onStageLines || !lineSel || lineSel.hunkIdx !== hunkIndex) return;
    const indices = selectedChangedIndices;
    if (!indices.length || !isHunkComplete(hunkIndex)) return;
    onStageLines({ file: diff.file, hunkIndex, lineIndices: indices });
  }
  /* SNIPCODE-HOOK end */
```

(d) Enable gutter selection for the staging view. In `startLineSelect` (~line 145), change the guard from `if (!canReverse || !isHunkComplete(hunkIdx)) return;` to:

```typescript
    if (!canSelectLines || !isHunkComplete(hunkIdx)) return;
```

(e) In the inline hunk header, add the Stage-lines button inside the existing `canStage` block. Replace the SNIPCODE-HOOK inline stage block (~lines 449-459) with:

```svelte
                <!-- SNIPCODE-HOOK start (B-2c/B-2d): inline per-hunk + per-line Stage/Unstage -->
                {#if canStage && isHunkComplete(hunkIdx)}
                  {#if onStageLines && lineSel?.hunkIdx === hunkIdx && selectedChangedIndices.length > 0}
                    <button class="hunk-action-btn hunk-stage-lines-btn" onclick={() => stageSelectedLines(hunkIdx)}
                            disabled={stageBusy}
                            aria-label={staged ? t('file.unstageLines') : t('file.stageLines')}
                            title={staged ? t('file.unstageLines') : t('file.stageLines')}>
                      <i class="codicon {staged ? 'codicon-remove' : 'codicon-add'}"></i>
                      <span>{staged ? t('file.unstageLines') : t('file.stageLines')} ({selectedChangedIndices.length})</span>
                    </button>
                  {/if}
                  <button class="hunk-action-btn hunk-stage-btn" onclick={() => stageHunk(hunkIdx)}
                          disabled={stageBusy}
                          aria-label={staged ? t('file.unstageHunk') : t('file.stageHunk')}
                          title={staged ? t('file.unstageHunk') : t('file.stageHunk')}>
                    <i class="codicon {staged ? 'codicon-remove' : 'codicon-add'}"></i>
                    <span>{staged ? t('file.unstageHunk') : t('file.stageHunk')}</span>
                  </button>
                {/if}
                <!-- SNIPCODE-HOOK end -->
```

*(Note: the side-by-side pane has no hunk header row, so the Stage-lines button lives in the inline view only — matching the existing Reverse-Selected-Lines button which is also inline-only. Line selection works in inline mode, the mode where the gutter is draggable.)*

- [ ] **Step 5: Wire `postStageLines` in messaging.ts**

In `graph/webview-ui/src/diff/messaging.ts`:

(a) Broaden the error branch to cover the new source. Change:

```typescript
      case 'error':
        if (msg.payload?.source === 'diffStageHunk') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        diffStore.busy = false;
        break;
```

to:

```typescript
      case 'error':
        if (msg.payload?.source === 'diffStageHunk' || msg.payload?.source === 'diffStageLines') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        diffStore.busy = false;
        break;
```

(b) After `postStageHunk`, add:

```typescript
/** Post the gutter-selected changed lines of one hunk to the host; side decides
 *  stage vs unstage. Gated on `busy` for the same index-shift reason as
 *  postStageHunk (applying re-parses the diff and renumbers later hunks/lines). */
export function postStageLines(hunkIndex: number, lineIndices: number[]): void {
  if (diffStore.busy) { return; }
  if (!diffStore.diff) { return; }
  diffStore.error = null;
  diffStore.busy = true;
  vscode.postMessage({
    type: 'diffStageLines',
    payload: {
      repoPath: diffStore.repoPath,
      file: diffStore.file,
      side: diffStore.side,
      hunkIndex,
      lineIndices,
    },
  });
}
```

- [ ] **Step 6: Pass `onStageLines` from Diff.svelte**

In `graph/webview-ui/src/diff/Diff.svelte`:

(a) Update the import (~line 4):

```svelte
  import { postStageHunk, postStageLines } from './messaging';
```

(b) Add the handler to the `<FileDiffView>` usage (~line 34), after `onStageHunk`:

```svelte
      onStageHunk={({ hunkIndex }) => postStageHunk(hunkIndex)}
      onStageLines={({ hunkIndex, lineIndices }) => postStageLines(hunkIndex, lineIndices)}
```

- [ ] **Step 7: Run the webview test to verify it passes**

Run: `cd graph && npx vitest run src/components/commit/__tests__/FileDiffView.test.ts --project webview`
Expected: PASS (new test green; existing FileDiffView tests still green).

- [ ] **Step 8: Add a messaging unit test and run it**

Append to `graph/webview-ui/src/diff/__tests__/messaging.test.ts`:

```typescript
  it('postStageLines posts diffStageLines with the current file + side + indices', () => {
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageLines(0, [1, 2]);
    expect(globalThis.__postedMessages).toContainEqual({
      data: {
        type: 'diffStageLines',
        payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 0, lineIndices: [1, 2] },
      },
    });
  });
```

Add `postStageLines` to the existing top import: `import { listenForHostMessages, postStageHunk, postStageLines } from '../messaging';`

Run: `cd graph && npx vitest run src/diff/__tests__/messaging.test.ts --project webview`
Expected: PASS.

- [ ] **Step 9: Build all three bundles (regression gate) + typecheck**

Run: `cd graph && npm run build && npm run lint`
Expected: build succeeds (all three webview bundles emit; judge by `BUILD` success text) and no `error TS…`.

- [ ] **Step 10: Commit**

```bash
git add graph/webview-ui/src/components/commit/FileDiffView.svelte \
        graph/webview-ui/src/diff/messaging.ts graph/webview-ui/src/diff/Diff.svelte \
        graph/webview-ui/src/lib/i18n/en.ts graph/webview-ui/src/lib/i18n/ko.ts graph/webview-ui/src/lib/i18n/zh.ts \
        graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts \
        graph/webview-ui/src/diff/__tests__/messaging.test.ts
git commit -m "feat(graph): Diff 分頁逐行 stage/unstage UI 與訊息串接"
```

- [ ] **Step 11: Manual verification (record result, do not skip)**

A is now end-to-end. Verify in a real VS Code Extension Host (F5): open a file with multiple changes in one hunk in the Diff tab, drag-select a subset of changed lines in the inline gutter, click "Stage Selected Lines (N)", confirm only those lines move to the staged side (the tree shows MM) and the panel re-renders the smaller unstaged diff. Repeat from the staged side for "Unstage Selected Lines". This is the F5 checkpoint the plan cannot automate.

---

## Task 5 (C1): Word-diff computation — pure LCS util

**Files:**
- Create: `graph/webview-ui/src/lib/utils/word-diff.ts`
- Test: `graph/webview-ui/src/lib/utils/__tests__/word-diff.test.ts` (new file)

**Interfaces:**
- Produces:
  - `export interface Range { start: number; end: number }` (`[start, end)` char offsets)
  - `export interface DiffLineLite { type: 'add' | 'delete' | 'context'; content: string }`
  - `export function computeWordDiff(oldLine: string, newLine: string): { delRanges: Range[]; addRanges: Range[] }`
  - `export function pairHunkWordDiffs(lines: DiffLineLite[]): Map<number, { ranges: Range[]; kind: 'add' | 'delete' }>`
- Consumes: nothing (pure, DOM-free).

- [ ] **Step 1: Write the failing unit tests**

Create `graph/webview-ui/src/lib/utils/__tests__/word-diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeWordDiff, pairHunkWordDiffs, type DiffLineLite } from '../word-diff';

describe('computeWordDiff', () => {
  it('highlights only the changed trailing word (Audi Mac → Audi asdsadadMac)', () => {
    const { delRanges, addRanges } = computeWordDiff('Audi Mac', 'Audi asdsadadMac');
    // "Audi " (0..5) is common; the last token differs.
    expect(delRanges).toEqual([{ start: 5, end: 8 }]);        // "Mac"
    expect(addRanges).toEqual([{ start: 5, end: 16 }]);       // "asdsadadMac"
  });

  it('returns no ranges for identical lines', () => {
    expect(computeWordDiff('same', 'same')).toEqual({ delRanges: [], addRanges: [] });
  });

  it('marks the whole added line changed when the old line is empty', () => {
    expect(computeWordDiff('', 'hello')).toEqual({ delRanges: [], addRanges: [{ start: 0, end: 5 }] });
  });

  it('merges adjacent changed tokens into one range', () => {
    // "a b c" → "a X Y" : tokens b and c both change but are separated by a
    // space that stays; each changed word is its own range (space unchanged).
    const { addRanges } = computeWordDiff('a b c', 'a X Y');
    expect(addRanges).toEqual([{ start: 2, end: 3 }, { start: 4, end: 5 }]);
  });

  it('falls back to whole-line ranges for very long lines', () => {
    const long = 'x'.repeat(500);
    const { delRanges, addRanges } = computeWordDiff(long, long + 'y');
    expect(delRanges).toEqual([{ start: 0, end: 500 }]);
    expect(addRanges).toEqual([{ start: 0, end: 501 }]);
  });
});

describe('pairHunkWordDiffs', () => {
  it('pairs the k-th delete with the k-th add in a replace block', () => {
    const lines: DiffLineLite[] = [
      { type: 'context', content: 'ctx' },
      { type: 'delete', content: 'Audi Mac' },
      { type: 'delete', content: 'foo bar' },
      { type: 'add', content: 'Audi asdsadadMac' },
      { type: 'add', content: 'foo baz' },
      { type: 'context', content: 'end' },
    ];
    const map = pairHunkWordDiffs(lines);
    // del idx 1 ↔ add idx 3
    expect(map.get(1)).toEqual({ ranges: [{ start: 5, end: 8 }], kind: 'delete' });
    expect(map.get(3)).toEqual({ ranges: [{ start: 5, end: 16 }], kind: 'add' });
    // del idx 2 ↔ add idx 4 ("bar" → "baz")
    expect(map.get(2)?.kind).toBe('delete');
    expect(map.get(4)?.kind).toBe('add');
  });

  it('does not pair a pure addition block (no matching deletes)', () => {
    const lines: DiffLineLite[] = [
      { type: 'context', content: 'a' },
      { type: 'add', content: 'brand new' },
    ];
    expect(pairHunkWordDiffs(lines).size).toBe(0);
  });

  it('pairs only min(dels, adds) lines when the block is uneven', () => {
    const lines: DiffLineLite[] = [
      { type: 'delete', content: 'one' },
      { type: 'add', content: 'ONE' },
      { type: 'add', content: 'extra' }, // no delete to pair with
    ];
    const map = pairHunkWordDiffs(lines);
    expect(map.has(0)).toBe(true);   // del one ↔ add ONE
    expect(map.has(1)).toBe(true);
    expect(map.has(2)).toBe(false);  // extra add unpaired
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd graph && npx vitest run src/lib/utils/__tests__/word-diff.test.ts --project webview`
Expected: FAIL — cannot resolve `../word-diff`.

- [ ] **Step 3: Implement word-diff.ts**

Create `graph/webview-ui/src/lib/utils/word-diff.ts`:

```typescript
// Intraline (word-level) diff for the diff viewer: given a removed line and the
// added line that replaced it, return the character ranges that actually changed
// on each side, so only the changed words are highlighted (matching IntelliJ)
// instead of the whole line. Pure + framework-free — unit-tested without a DOM.

/** Half-open char range [start, end) into a single line. */
export interface Range { start: number; end: number }

export interface DiffLineLite { type: 'add' | 'delete' | 'context'; content: string }

export interface WordDiffResult { delRanges: Range[]; addRanges: Range[] }

// Longest line pair we bother diffing. Beyond this an O(n*m) LCS over a
// minified/generated line is not worth the cost and the highlight is noise, so
// callers fall back to whole-line coloring.
// ponytail: fixed cap; make it configurable only if a real file needs it.
const MAX_LEN = 400;

// Split a line into tokens: runs of word chars, runs of whitespace, and single
// other chars. Keeping delimiters as their own tokens means the joined tokens
// reproduce the line exactly, so accumulated token lengths give exact offsets.
function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

// Convert per-token changed flags into merged char ranges over the joined line.
function tokensToRanges(tokens: string[], changed: boolean[]): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  for (let k = 0; k < tokens.length; k++) {
    const len = tokens[k].length;
    if (changed[k]) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === offset) { last.end = offset + len; } // merge adjacent
      else { ranges.push({ start: offset, end: offset + len }); }
    }
    offset += len;
  }
  return ranges;
}

export function computeWordDiff(oldLine: string, newLine: string): WordDiffResult {
  if (oldLine.length > MAX_LEN || newLine.length > MAX_LEN) {
    return {
      delRanges: oldLine.length ? [{ start: 0, end: oldLine.length }] : [],
      addRanges: newLine.length ? [{ start: 0, end: newLine.length }] : [],
    };
  }

  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const n = a.length;
  const m = b.length;

  // LCS length DP: dp[i][j] = LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the LCS: tokens NOT on the common subsequence are "changed".
  const delChanged = new Array<boolean>(n).fill(false);
  const addChanged = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { delChanged[i] = true; i++; }
    else { addChanged[j] = true; j++; }
  }
  while (i < n) { delChanged[i] = true; i++; }
  while (j < m) { addChanged[j] = true; j++; }

  return {
    delRanges: tokensToRanges(a, delChanged),
    addRanges: tokensToRanges(b, addChanged),
  };
}

/**
 * For each line index in a hunk, the intraline ranges to highlight. Only lines
 * inside a delete-block immediately followed by an add-block (the classic
 * "replace" shape IntelliJ word-highlights) get ranges; the k-th deleted line is
 * paired with the k-th added line of that block. Pure/index-in.
 */
export function pairHunkWordDiffs(
  lines: DiffLineLite[],
): Map<number, { ranges: Range[]; kind: 'add' | 'delete' }> {
  const out = new Map<number, { ranges: Range[]; kind: 'add' | 'delete' }>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'delete') { i++; continue; }
    let d = i;
    while (d < lines.length && lines[d].type === 'delete') { d++; }
    let a = d;
    while (a < lines.length && lines[a].type === 'add') { a++; }
    const dels = d - i;      // delete lines [i, d)
    const adds = a - d;      // add lines    [d, a)
    const pairs = Math.min(dels, adds);
    for (let k = 0; k < pairs; k++) {
      const delIdx = i + k;
      const addIdx = d + k;
      const { delRanges, addRanges } = computeWordDiff(lines[delIdx].content, lines[addIdx].content);
      if (delRanges.length) { out.set(delIdx, { ranges: delRanges, kind: 'delete' }); }
      if (addRanges.length) { out.set(addIdx, { ranges: addRanges, kind: 'add' }); }
    }
    // Advance past the whole block; guarantee forward progress.
    i = a > i ? a : i + 1;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd graph && npx vitest run src/lib/utils/__tests__/word-diff.test.ts --project webview`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add graph/webview-ui/src/lib/utils/word-diff.ts graph/webview-ui/src/lib/utils/__tests__/word-diff.test.ts
git commit -m "feat(graph): 新增 word-diff LCS 逐字差異計算工具"
```

---

## Task 6 (C2): Overlay word-diff on Shiki output in FileDiffView

**Files:**
- Modify: `graph/webview-ui/src/lib/utils/highlighter.ts` (add `highlightLineWithRanges`; export)
- Modify: `graph/webview-ui/src/components/commit/FileDiffView.svelte` (compute per-line ranges, use them in the highlight effect, add CSS)
- Test: `graph/webview-ui/src/lib/utils/__tests__/word-diff.test.ts` is C1's; the overlay is validated by build + `verify-webview-ui` (Shiki + DOM), not a unit assertion. Add one small highlighter unit test for the plain-text (no-grammar) overlay path.

**Interfaces:**
- Produces: `export function highlightLineWithRanges(h: HighlighterCore, content: string, lang: string, ranges: Range[], kind: 'add' | 'delete', theme?: 'dark-plus' | 'light-plus'): string`
- Consumes: `computeWordDiff` / `pairHunkWordDiffs` / `Range` (Task 5); existing `highlightLineSync`, `escapeHtml`, `activeShikiTheme`, the Shiki `HighlighterCore`.

**Feasibility / trade-off (this is C's hard point — see Self-Review):** `highlightLineSync` emits, per Shiki token, `<span style="color:…">escapedText</span>`. To overlay word-diff we tokenize the same way, then within each token split its characters into in-range / out-of-range runs and wrap the in-range runs in `<span class="word-diff-…">`. Because syntax color is an inline `style` on the outer span and the word-diff highlight is a `background` on an inner `class` span, the two compose cleanly (nested spans) with no conflict. When the language has no Shiki grammar (or Shiki throws) we fall back to a single uncolored token, so word-diff still shows on plain text. **Known v1 gap:** the highlight `$effect` early-returns when `lang === ''`, when the diff exceeds `MAX_HIGHLIGHT_LINES`, or when the grammar fails to load — in those cases `highlightedLines` is empty and lines render via `escapeHtml` with no word-diff. That is acceptable (huge/plain diffs), documented, and can be lifted in v2 by routing the fallback path through `highlightLineWithRanges` too.

- [ ] **Step 1: Write the failing highlighter unit test (plain-text overlay path)**

Create `graph/webview-ui/src/lib/utils/__tests__/highlighter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { highlightLineWithRanges } from '../highlighter';
import type { HighlighterCore } from 'shiki';

// A stub highlighter with no loaded languages: highlightLineWithRanges must fall
// back to plain (uncolored) tokens and still wrap the changed range.
const stubHl = { getLoadedLanguages: () => [] as string[] } as unknown as HighlighterCore;

describe('highlightLineWithRanges', () => {
  it('wraps only the changed char range on a plain-text (no-grammar) line', () => {
    // "Audi Mac", range [5,8) = "Mac".
    const html = highlightLineWithRanges(stubHl, 'Audi Mac', '', [{ start: 5, end: 8 }], 'delete');
    expect(html).toBe('Audi <span class="word-diff-del">Mac</span>');
  });

  it('escapes HTML inside and outside the range', () => {
    const html = highlightLineWithRanges(stubHl, 'a<b', '', [{ start: 1, end: 3 }], 'add');
    expect(html).toBe('a<span class="word-diff-add">&lt;b</span>');
  });

  it('returns plain highlighting when there are no ranges', () => {
    const html = highlightLineWithRanges(stubHl, 'abc', '', [], 'add');
    expect(html).toBe('abc'); // escapeHtml fallback, no word-diff span
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd graph && npx vitest run src/lib/utils/__tests__/highlighter.test.ts --project webview`
Expected: FAIL — `highlightLineWithRanges` is not exported.

- [ ] **Step 3: Implement `highlightLineWithRanges`**

In `graph/webview-ui/src/lib/utils/highlighter.ts`, add the import at the top (after the existing `import type` line):

```typescript
import type { Range } from './word-diff';
```

Then add, before the final `export { escapeHtml };` line:

```typescript
/**
 * Like {@link highlightLineSync} but overlays a word-diff `background` class on
 * the given char ranges without disturbing Shiki's syntax colors. Splits each
 * colored token at range boundaries so an inner `word-diff-*` span wraps only the
 * changed characters. Falls back to a single uncolored token (plain text) when
 * the grammar is unavailable, so word-diff still shows without highlighting.
 */
export function highlightLineWithRanges(
  h: HighlighterCore,
  content: string,
  lang: string,
  ranges: Range[],
  kind: 'add' | 'delete',
  theme: 'dark-plus' | 'light-plus' = activeShikiTheme(),
): string {
  if (ranges.length === 0) { return highlightLineSync(h, content, lang, theme); }
  const cls = kind === 'add' ? 'word-diff-add' : 'word-diff-del';

  // Colored tokens as {text, color}; a single uncolored token when Shiki can't
  // tokenize (no grammar / error) so word-diff still works on plain text.
  let tokens: Array<{ text: string; color?: string }>;
  try {
    const loaded = !!lang && h.getLoadedLanguages().includes(lang as never);
    if (loaded) {
      const res = h.codeToTokens(content, { lang: lang as never, theme });
      tokens = (res.tokens[0] ?? []).map((tk) => ({ text: tk.content, color: tk.color }));
    } else {
      tokens = [{ text: content }];
    }
  } catch {
    tokens = [{ text: content }];
  }
  if (tokens.length === 0) { tokens = [{ text: content }]; }

  const inRange = (pos: number): boolean => ranges.some((r) => pos >= r.start && pos < r.end);

  let html = '';
  let offset = 0;
  for (const tk of tokens) {
    const open = tk.color ? `<span style="color:${tk.color}">` : '';
    const close = tk.color ? '</span>' : '';
    html += open;
    // Split the token into runs of same in/out-of-range, wrapping only the
    // changed runs so the surrounding syntax color is preserved.
    let run = '';
    let runInRange = tk.text.length > 0 ? inRange(offset) : false;
    for (let c = 0; c < tk.text.length; c++) {
      const here = inRange(offset + c);
      if (here !== runInRange) {
        html += runInRange ? `<span class="${cls}">${escapeHtml(run)}</span>` : escapeHtml(run);
        run = '';
        runInRange = here;
      }
      run += tk.text[c];
    }
    if (run) { html += runInRange ? `<span class="${cls}">${escapeHtml(run)}</span>` : escapeHtml(run); }
    html += close;
    offset += tk.text.length;
  }
  return html;
}
```

- [ ] **Step 4: Run the highlighter test to verify it passes**

Run: `cd graph && npx vitest run src/lib/utils/__tests__/highlighter.test.ts --project webview`
Expected: PASS.

- [ ] **Step 5: Wire word-diff into FileDiffView's highlight effect**

In `graph/webview-ui/src/components/commit/FileDiffView.svelte`:

(a) Extend the highlighter import (~line 5) and add the word-diff import right after it:

```typescript
  import { detectLanguage, highlightLineSync, highlightLineWithRanges, getHighlighter, ensureLanguage, activeShikiTheme, escapeHtml } from '../../lib/utils/highlighter';
  /* SNIPCODE-HOOK (B-2d): intraline word-level diff. */
  import { pairHunkWordDiffs } from '../../lib/utils/word-diff';
```

(b) Add a derived map from the SAME cache key the highlight effect uses (`${hunk.oldStart}-${lineIndex}`) to its word-diff ranges. Insert right after the `renderHunks` derived block (~line 295, before `const MAX_HIGHLIGHT_LINES`):

```typescript
  /* SNIPCODE-HOOK start (B-2d): per-line word-diff ranges, keyed like the
     highlight cache so the effect can overlay them on the Shiki output. */
  const wordDiffByKey = $derived.by(() => {
    const map = new Map<string, { ranges: import('../../lib/utils/word-diff').Range[]; kind: 'add' | 'delete' }>();
    for (const hunk of renderHunks) {
      const paired = pairHunkWordDiffs(hunk.lines);
      for (const [lineIdx, entry] of paired) {
        map.set(`${hunk.oldStart}-${lineIdx}`, entry);
      }
    }
    return map;
  });
  /* SNIPCODE-HOOK end */
```

(c) In the highlight `$effect`, replace the single line that fills the map (currently `newMap.set(flat[j].key, highlightLineSync(h, flat[j].content, lang, theme));`, ~line 359) with a branch that overlays ranges when present:

```typescript
            const wd = wordDiffByKey.get(flat[j].key);
            newMap.set(
              flat[j].key,
              wd
                ? highlightLineWithRanges(h, flat[j].content, lang, wd.ranges, wd.kind, theme)
                : highlightLineSync(h, flat[j].content, lang, theme),
            );
```

*(The effect already re-runs when `renderHunks` / `shikiTheme` change; reading `wordDiffByKey` inside it registers the dependency so a diff change refreshes the overlay.)*

(d) Add the word-diff CSS. In the `<style>` block, near the other SNIPCODE-HOOK styles, add:

```css
  /* SNIPCODE-HOOK start (B-2d): intraline word-diff highlight. Sits on top of
     the whole-line add/delete background; uses a stronger tint so the changed
     characters stand out (IntelliJ-style). Inherits the Shiki syntax color. */
  :global(.word-diff-del) {
    background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.35));
    border-radius: 2px;
  }
  :global(.word-diff-add) {
    background: var(--vscode-diffEditor-insertedTextBackground, rgba(0, 255, 0, 0.30));
    border-radius: 2px;
  }
  /* SNIPCODE-HOOK end */
```

*(`:global` is required — the spans are injected via `{@html}`, so Svelte's scoped-class hashing does not reach them.)*

- [ ] **Step 6: Build all three bundles + typecheck**

Run: `cd graph && npm run build && npm run lint`
Expected: build succeeds (three webview bundles) and no `error TS…`. This confirms the word-diff util bundles into `diff.js` without splitting a shared chunk (Global Constraint).

- [ ] **Step 7: Run the whole webview + backend test suites (regression)**

Run: `cd graph && npx vitest run --project webview && npx vitest run --project backend`
Expected: PASS across the board (no B-2c / reverse regressions).

- [ ] **Step 8: Commit**

```bash
git add graph/webview-ui/src/lib/utils/highlighter.ts \
        graph/webview-ui/src/lib/utils/__tests__/highlighter.test.ts \
        graph/webview-ui/src/components/commit/FileDiffView.svelte
git commit -m "feat(graph): Diff 分頁字級 word-diff 高亮疊加 Shiki"
```

- [ ] **Step 9: Visual verification (record result, do not skip)**

Word-diff has a visual surface, so run the `verify-webview-ui` skill to render the Diff tab headless and screenshot a replace hunk (e.g. `Audi Mac` → `Audi asdsadadMac`): confirm only `Mac` / `asdsadadMac` are background-highlighted, the rest of the line keeps its syntax colors, and both light and dark themes look right. Then F5 in a real Extension Host on a real code file to confirm Shiki colors are intact under the overlay. This is the checkpoint the plan cannot automate.

---

## Self-Review

**1. Spec coverage (A + C):**
- **A — line-level buildForwardPatch:** Task 1 (`buildForwardPatchLines`, pure, mirror-of-reverse semantics, no-EOF handling, unit tests). ✔
- **A — git-service stageLines/unstageLines:** Task 2 (methods + real-git integration incl. no-EOF + MM assertions). ✔
- **A — FileDiffView existing line-selection wired to stage:** Task 4 (`onStageLines` mirrors `onReverseLines`, `canSelectLines` turns the gutter on for the staging view, `lineIndices` aligned to `DiffLine[]`). ✔
- **A — host串接:** Task 3 (ChangesWorkbench + DiffPanel `diffStageLines`) + Task 4 (messaging `postStageLines`, Diff.svelte). ✔
- **A — tests:** patch-builder pure unit (Task 1), real-git integration (Task 2), webview hook test + messaging test (Task 4). ✔
- **C — word-diff compute (testable):** Task 5 (`computeWordDiff` LCS + `pairHunkWordDiffs`, unit tests including the `Audi Mac` example). ✔
- **C — overlay on Shiki (visual):** Task 6 (`highlightLineWithRanges` + FileDiffView effect + CSS, plain-text unit test, verify-webview-ui). ✔
- **B-2c preserved:** Tasks touch new hooks/methods only; per-hunk paths (`stageHunks`/`onStageHunk`/`diffStageHunk`) unchanged; Task 2 Step 6 and Task 6 Step 7 re-run the existing suites. ✔
- **C split into C1/C2:** The task allows splitting; here C1 = Task 5 (pure, fully unit-tested) and C2 = Task 6 (Shiki overlay, build + verify-webview-ui). Documented in Task 6's feasibility note.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step carries complete, runnable code including the full `buildForwardPatchLines`, `stageLines`/`unstageLines`, the FileDiffView hook diff, the LCS `computeWordDiff`, and the `highlightLineWithRanges` overlay. The only non-code steps are the two mandatory manual F5 / verify-webview-ui checkpoints, which are recorded results, not deferred work.

**3. Type consistency:**
- `buildForwardPatchLines(rawFileDiff, hunkIndex, lineIndices?)` — same shape as `buildReversePatch`; imported in git-service (Task 2 Step 3) and patch-builder test (Task 1 Step 1). ✔
- `stageLines/unstageLines(file, hunkIndex, lineIndices)` — same arg order everywhere: GitService (Task 2) → ChangesWorkbench (Task 3) → DiffPanel payload (Task 3) → `postStageLines(hunkIndex, lineIndices)` (Task 4). ✔
- `onStageLines` target `{ file, hunkIndex, lineIndices }` matches the Diff.svelte handler destructure and the webview test assertion. ✔
- `Range` = `{ start; end }`, `DiffLineLite`, `pairHunkWordDiffs` return `{ ranges; kind }`, `highlightLineWithRanges(h, content, lang, ranges, kind, theme?)` — consistent across word-diff.ts, highlighter.ts, and FileDiffView's `wordDiffByKey`. ✔
- `diffStageLines` message `type`/`payload` identical in messaging.ts (post), DiffPanel (receive), and the error `source` string in both. ✔

**4. Deferred to v2 (out of scope, unchanged from the fence):** IntelliJ `»`/`«` gutter arrow styling (B, pure polish); Staged↔Local two-way move view model; image/binary intraline diff; changelists; dynamic repo; and the C fallback for plain-text/huge/grammar-less diffs (word-diff currently shows only when the Shiki highlight effect runs — see Task 6 feasibility note).

**Key investigation conclusions (relayed to the requester):**
- **Forward line-level patch semantics:** confirmed against `buildReversePatch`. Forward (stage, `apply --cached`, baseline = index) is the exact mirror of reverse with old/new swapped: selected `+`/`-` kept; **unselected `+` omitted entirely** (NOT demoted — the one asymmetry vs reverse, which demotes adds); unselected `-` demoted to context. The old side always reaches EOF (deletes never dropped) so the no-newline "always-terminates" side flips from new (reverse) to old (forward); the marker re-anchoring loop and the shared-line split are mirrored accordingly. Correctness of the no-EOF branches is gated by real-git integration (`git apply --cached` + index assertions), matching how reverse was validated.
- **Word-diff overlaying Shiki: feasible and clean.** `highlightLineSync` emits per-token `<span style="color:…">` spans; splitting each token at word-diff range boundaries and wrapping changed runs in a `class` span (background) composes with the inline color style with no conflict. Fallback to uncolored tokens keeps word-diff working on grammarless/plain lines. The only compromise is the effect's early-return paths (empty lang / >MAX_HIGHLIGHT_LINES / grammar load failure) where no overlay renders — a documented v1 gap, not a blocker.

**Uncertain points needing F5 / verify-webview-ui (cannot be unit-verified):**
1. The no-EOF + trailing-kept-delete split branch in `buildForwardPatchLines` (`+content` / marker / `-content` ordering) — Task 2's no-EOF integration test exercises the common case; an exotic mixed no-EOF hunk should be spot-checked with a real `git apply --cached`.
2. The Diff tab's line-selection → "Stage/Unstage Selected Lines" end-to-end (Task 4 Step 11 F5): drag-select subset, confirm MM state and panel re-render.
3. Word-diff visual correctness and theme behavior (Task 6 Step 9 verify-webview-ui + F5): only changed characters highlighted, syntax colors intact, light + dark.
