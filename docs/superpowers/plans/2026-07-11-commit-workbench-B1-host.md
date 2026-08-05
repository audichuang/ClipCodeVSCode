# Commit Workbench — Slice B-1 Host Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the host-only git foundation for the multi-repo commit workbench — a forward (hunk-selecting) patch builder, repo-operation-state gating, an index-safe `commitSelected`, and a per-repo mutation serializer — with zero webview/UI.

**Architecture:** All work lands in the vendored `graph/` sub-project's pure host layer. `patch-builder.ts` gains a forward-selection twin of the existing `buildReversePatch` (reusing its private `parseFileDiff` / `normalizeWholeFileHeader`). `git-service.ts` gains `getRepoOperationState()` (D4 gate) and `commitSelected()` which, under the existing per-instance mutation lock, verifies a clean index (D1) and a clean repo state (D4), stages only the selected hunks via `git apply --cached`, commits, and self-heals the index on failure. A new module-level `mutation-coordinator.ts` (D2) provides a per-repo-path serializer that B-2 will wrap around every mutating handler.

**Tech Stack:** TypeScript (ESM), Node child_process (`git` CLI), Vitest (backend + integration projects), real `git` binary in integration tests.

## Global Constraints

- **`git/` modules MUST NOT import `vscode`** — GitService and parsers stay unit-testable against the real git CLI. (`graph/AGENTS.md`)
- **Code comments in English; ESM modules.**
- **Tests use Vitest, not `node:test`.** Backend/integration files are `src/**/*.test.ts`; integration tests live in `src/git/__tests__/integration/*.integration.test.ts`, spawn real git, and get a 30s timeout from the vitest config.
- **Test command:** `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run <relative-path>`. Judge pass/fail by the Vitest summary TEXT (`Tests  N passed`), never a piped exit code.
- **Scope fence — B-1 is host only:** no webview, no message-bus types, no MainPanel wiring, no porcelain-v2 structured status model (D3 stays deferred to B-2 — reuse existing `getUncommittedDiff` / `getUncommittedFileDiff`). Line-level (`lineIndices`) hunk selection is explicitly **v2**, not built here.
- **Commit style:** Traditional-Chinese commit messages (repo convention); no attribution/Co-Authored-By lines.

---

## File Structure

- `graph/src/git/patch-builder.ts` — **modify.** Add and export `buildForwardPatch`. Reuses the existing private `parseFileDiff` and `normalizeWholeFileHeader` in the same file.
- `graph/src/git/git-service.ts` — **modify.** Add `getRepoOperationState()`, `commitSelected()`, and a private `workingFileDiffRaw()` helper. Import `buildForwardPatch`.
- `graph/src/services/mutation-coordinator.ts` — **create.** Module-level per-repo-path serializer (`runExclusive`). No `vscode` import.
- `graph/src/git/__tests__/patch-builder.test.ts` — **modify.** Add a `buildForwardPatch` describe block.
- `graph/src/git/__tests__/integration/repo-operation-state.integration.test.ts` — **create.** Real-git tests for `getRepoOperationState`.
- `graph/src/git/__tests__/integration/commit-selected.integration.test.ts` — **create.** Real-git tests for `commitSelected` (happy path + D1 + D4 gates).
- `graph/src/services/__tests__/mutation-coordinator.test.ts` — **create.** Unit tests for `runExclusive`.

---

## Task 1: Forward patch builder (`buildForwardPatch`)

Pure function. HEAD→working diff is a set of independent hunks; `git apply --cached` of a subset stages exactly those hunks. So the builder emits the selected hunks **verbatim** (original header line + entries + no-newline markers), drops the rest, and passes the file header through `normalizeWholeFileHeader` (a no-op for hunk-level selection, kept for whole-file `/dev/null` diffs and parity with the reverse builder).

**Files:**
- Modify: `graph/src/git/patch-builder.ts` (append a new exported function after `buildReversePatch`)
- Test: `graph/src/git/__tests__/patch-builder.test.ts`

**Interfaces:**
- Consumes (already private in `patch-builder.ts`): `parseFileDiff(rawFileDiff: string): { header: string[]; hunks: Array<{ headerLine: string; entries: Array<{ kind: 'context'|'add'|'delete'; text: string; markers: string[] }> }> }`; `normalizeWholeFileHeader(header: string[], oldCount: number, newCount: number): string[]`.
- Produces: `export function buildForwardPatch(rawFileDiff: string, selectedHunkIndices: number[]): string` — throws on empty selection or an out-of-range index; returns a patch appliable with `git apply --cached`.

- [ ] **Step 1: Write the failing tests**

Add to the top imports of `graph/src/git/__tests__/patch-builder.test.ts`:

```typescript
import { buildForwardPatch } from '../patch-builder';
```

Append this describe block to the same file:

```typescript
// Two well-separated hunks (line 2 and line 14) — the shape a HEAD→working
// diff hands to the forward builder for per-hunk staging.
const TWO_HUNK = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' alpha',
  '-beta',
  '+beta2',
  ' gamma',
  '@@ -13,3 +13,3 @@',
  ' nu',
  '-xi',
  '+xi2',
  ' omicron',
  '',
].join('\n');

// A whole-new-file diff: `--- /dev/null` side, one pure-addition hunk.
const NEW_FILE = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..abc1234',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  '',
].join('\n');

describe('buildForwardPatch', () => {
  it('emits only the selected hunk, dropping the others', () => {
    const patch = buildForwardPatch(TWO_HUNK, [0]);
    expect(patch).toBe([
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+beta2',
      ' gamma',
      '',
    ].join('\n'));
  });

  it('emits multiple selected hunks in ascending file order', () => {
    // Pass them out of order to prove the builder sorts to file order for apply.
    const patch = buildForwardPatch(TWO_HUNK, [1, 0]);
    expect(patch).toBe([
      'diff --git a/f.txt b/f.txt',
      'index 1111111..2222222 100644',
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,3 +1,3 @@',
      ' alpha',
      '-beta',
      '+beta2',
      ' gamma',
      '@@ -13,3 +13,3 @@',
      ' nu',
      '-xi',
      '+xi2',
      ' omicron',
      '',
    ].join('\n'));
  });

  it('reconstructs the whole diff verbatim when every hunk is selected', () => {
    expect(buildForwardPatch(TWO_HUNK, [0, 1])).toBe(TWO_HUNK);
  });

  it('stages a whole new file (keeps the /dev/null side) when its only hunk is selected', () => {
    expect(buildForwardPatch(NEW_FILE, [0])).toBe(NEW_FILE);
  });

  it('throws when the selection is empty', () => {
    expect(() => buildForwardPatch(TWO_HUNK, [])).toThrow('No hunks selected');
  });

  it('throws when a selected hunk index is out of range', () => {
    expect(() => buildForwardPatch(TWO_HUNK, [5])).toThrow('Hunk 5 not found');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/patch-builder.test.ts`
Expected: FAIL — `buildForwardPatch` is not exported (`buildForwardPatch is not a function` / import resolves to undefined).

- [ ] **Step 3: Implement `buildForwardPatch`**

Append to `graph/src/git/patch-builder.ts` (after `buildReversePatch`, end of file):

```typescript
/**
 * Build a patch that stages ONLY the selected hunks of a HEAD→working-tree
 * file diff, for `git apply --cached`. Each hunk of a HEAD→working diff is an
 * independent region, so staging a subset just means emitting those hunks
 * verbatim (original header line + entries + no-newline markers) and dropping
 * the rest — no line-count rewriting is needed because whole hunks keep their
 * own already-correct `@@` counts.
 *
 * Hunk-level only (v1). Per-line selection (lineIndices) is intentionally left
 * to v2. `selectedHunkIndices` index into the parsed hunk list exactly as
 * `parseFileDiff`/`parseDiff` produce it; they are de-duplicated and applied in
 * ascending file order (git apply wants hunks in file order).
 *
 * `normalizeWholeFileHeader` runs for parity with the reverse builder and to
 * cover the whole-file `/dev/null` cases (new/deleted file selected in full);
 * for ordinary modification diffs and verbatim hunk selection it is a no-op.
 *
 * @throws if nothing is selected or a selected index is out of range.
 */
export function buildForwardPatch(rawFileDiff: string, selectedHunkIndices: number[]): string {
  if (selectedHunkIndices.length === 0) {
    throw new Error('No hunks selected to stage');
  }
  const { header, hunks } = parseFileDiff(rawFileDiff);
  const ordered = [...new Set(selectedHunkIndices)].sort((a, b) => a - b);

  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (const idx of ordered) {
    const hunk = hunks[idx];
    if (!hunk) {
      throw new Error(`Hunk ${idx} not found in diff`);
    }
    body.push(hunk.headerLine);
    for (const entry of hunk.entries) {
      body.push(entry.text, ...entry.markers);
      if (entry.kind === 'context') { oldCount++; newCount++; }
      else if (entry.kind === 'delete') { oldCount++; }
      else { newCount++; }
    }
  }

  const finalHeader = normalizeWholeFileHeader(header, oldCount, newCount);
  return [...finalHeader, ...body].join('\n') + '\n';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/patch-builder.test.ts`
Expected: PASS — all `buildForwardPatch` tests green, existing `buildReversePatch` tests still green.

- [ ] **Step 5: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph
git add src/git/patch-builder.ts src/git/__tests__/patch-builder.test.ts
git commit -m "feat(git): 新增 buildForwardPatch 逐 hunk 選取正向 patch"
```

---

## Task 2: Repo operation-state gate (`getRepoOperationState`)

D4 needs a single "is this repo mid-operation?" check that `commitSelected` can gate on. The existing `getOperationState()` already detects merge/rebase/cherry-pick/revert (and squash) but returns `{ type }` and does **not** check bisect. Wrap it into a flat verdict and add the bisect check.

**Files:**
- Modify: `graph/src/git/git-service.ts` (add method near `getOperationState`, ~line 2168)
- Test: `graph/src/git/__tests__/integration/repo-operation-state.integration.test.ts`

**Interfaces:**
- Consumes: existing `GitService.getOperationState(): Promise<{ type: 'merge'|'rebase'|'cherry-pick'|'revert'|'squash'|null }>`; existing private `gitDir(): string`; `existsSync`, `join` (already imported in the file).
- Produces: `async getRepoOperationState(): Promise<'clean' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'>`.

- [ ] **Step 1: Write the failing tests**

Create `graph/src/git/__tests__/integration/repo-operation-state.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

describe('GitService integration — getRepoOperationState', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('returns "clean" on a normal repo with a commit', async () => {
    commit(repo.path, 'init', { 'a.txt': 'base\n' });
    expect(await svc.getRepoOperationState()).toBe('clean');
  });

  it('returns "merge" while a conflicting merge is in progress', async () => {
    commit(repo.path, 'init', { 'a.txt': 'base\n' });
    runGit(repo.path, ['checkout', '-b', 'left']);
    commit(repo.path, 'left', { 'a.txt': 'left\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'right', { 'a.txt': 'right\n' });

    // Conflicting merge parks MERGE_HEAD until resolved.
    await expect(svc.merge('left')).rejects.toThrow();
    expect(await svc.getRepoOperationState()).toBe('merge');
  });

  it('returns "bisect" while a bisect session is active', async () => {
    commit(repo.path, 'init', { 'a.txt': 'one\n' });
    runGit(repo.path, ['bisect', 'start']);
    expect(await svc.getRepoOperationState()).toBe('bisect');
    runGit(repo.path, ['bisect', 'reset']);
    expect(await svc.getRepoOperationState()).toBe('clean');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/integration/repo-operation-state.integration.test.ts`
Expected: FAIL — `svc.getRepoOperationState is not a function`.

- [ ] **Step 3: Implement `getRepoOperationState`**

In `graph/src/git/git-service.ts`, immediately after `getOperationState()` (after its closing `}` near line 2168), insert:

```typescript
  /**
   * Flat operation verdict for the commit workbench's D4 gate. Reuses
   * getOperationState() for merge/rebase/cherry-pick/revert and adds the bisect
   * check it lacks. A leftover SQUASH_MSG (getOperationState → 'squash') is not
   * an active operation that blocks committing, so it maps to 'clean' here.
   */
  async getRepoOperationState(): Promise<'clean' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'> {
    const { type } = await this.getOperationState();
    if (type === 'merge' || type === 'rebase' || type === 'cherry-pick' || type === 'revert') {
      return type;
    }
    // BISECT_LOG exists for the lifetime of a bisect session (removed by
    // `git bisect reset`); getOperationState() does not look at it.
    if (existsSync(join(this.gitDir(), 'BISECT_LOG'))) {
      return 'bisect';
    }
    return 'clean';
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/integration/repo-operation-state.integration.test.ts`
Expected: PASS — clean/merge/bisect verdicts correct.

- [ ] **Step 5: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph
git add src/git/git-service.ts src/git/__tests__/integration/repo-operation-state.integration.test.ts
git commit -m "feat(git): 新增 getRepoOperationState 供提交工作台 D4 守門"
```

---

## Task 3: Index-safe selective commit (`commitSelected`)

The core D1+D4 transaction. Under the existing per-instance mutation lock, verify the repo is clean (D4) and the index is empty (D1), stage each file's selected hunks via `git apply --cached`, commit, and return the new hash. The working tree is never touched, so unselected hunks stay as uncommitted working changes and no reset of the tree is needed; a mid-apply failure resets the index back to clean before rethrowing.

> **Deadlock note for the implementer:** `commitSelected` runs its whole body inside `this.withMutationLock(...)`. `GitService.exec()` *also* takes that lock for mutating commands, so calling `this.exec(['apply', ...])` from inside the locked body would deadlock. Mutating git commands here therefore call `this.execUnlocked(...)` directly (private, same class) — which still clears the read cache on success. Read-only commands (`diff`, `ls-files`, `rev-parse`) go through `this.exec()` normally: `exec()` routes reads straight to `execUnlocked` without taking the lock, so they are safe inside the locked body.

**Files:**
- Modify: `graph/src/git/git-service.ts` (add `commitSelected` and a private `workingFileDiffRaw`; extend the `patch-builder` import)
- Test: `graph/src/git/__tests__/integration/commit-selected.integration.test.ts`

**Interfaces:**
- Consumes: `buildForwardPatch` (Task 1); `getRepoOperationState` (Task 2); existing private `withMutationLock`, `execUnlocked`, `exec`, `assertSafePath`; existing `GitError` (has `.exitCode`).
- Produces:
  - `async commitSelected(message: string, files: Array<{ path: string; hunkIndices: number[] }>): Promise<string>` — new commit hash; throws on non-clean repo state (D4), non-empty index (D1), or apply/commit failure (index reset first).
  - private `async workingFileDiffRaw(file: string): Promise<string>` — raw HEAD→working unified diff text for one file (tracked or untracked), for feeding `buildForwardPatch`.

- [ ] **Step 1: Write the failing tests**

Create `graph/src/git/__tests__/integration/commit-selected.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit, writeFile } from './helpers';

// Base with two edit sites far apart (line 2 and line 14) so git keeps them in
// two separate hunks; only the working tree is changed (not committed).
const BASE = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';

describe('GitService integration — commitSelected', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    // Working-tree edit only (two hunks), left uncommitted and unstaged.
    writeFile(repo.path, 'f.txt', CHANGED);
  });
  afterEach(() => repo.cleanup());

  it('commits only the selected hunk, leaving the other hunk in the working tree and the index clean', async () => {
    const before = head(repo.path);
    const newHash = await svc.commitSelected('只提交第一個 hunk', [{ path: 'f.txt', hunkIndices: [0] }]);

    // A new commit was created and returned.
    expect(newHash).not.toBe(before);
    expect(newHash).toBe(head(repo.path));

    // The commit contains hunk 0 (beta→beta2) but NOT hunk 1 (xi→xi2).
    const committed = runGit(repo.path, ['show', 'HEAD:f.txt']);
    expect(committed).toContain('\nbeta2\n');
    expect(committed).toContain('\nxi\n');
    expect(committed).not.toContain('\nxi2\n');

    // Hunk 1 is still an unstaged working-tree change.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('M f.txt');

    // Index is clean (== HEAD): `git diff --cached --quiet` exits 0.
    expect(() => runGit(repo.path, ['diff', '--cached', '--quiet'])).not.toThrow();
  });

  it('D1: refuses to commit when the index already has staged changes', async () => {
    // Dirty the index with an unrelated staged file.
    writeFile(repo.path, 'other.txt', 'staged\n');
    runGit(repo.path, ['add', 'other.txt']);

    await expect(
      svc.commitSelected('should not run', [{ path: 'f.txt', hunkIndices: [0] }]),
    ).rejects.toThrow('index already has staged changes');
  });

  it('D4: refuses to commit while a merge is in progress', async () => {
    // Build a conflicting merge so MERGE_HEAD is parked.
    runGit(repo.path, ['checkout', '-b', 'left']);
    commit(repo.path, 'left', { 'g.txt': 'left\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'right', { 'g.txt': 'right\n' });
    // Recreate the conflicting content on both sides to force a real conflict.
    runGit(repo.path, ['checkout', '-b', 'left2', 'left']);
    writeFile(repo.path, 'g.txt', 'left-conflict\n');
    runGit(repo.path, ['commit', '-am', 'left conflict']);
    runGit(repo.path, ['checkout', 'main']);
    writeFile(repo.path, 'g.txt', 'main-conflict\n');
    runGit(repo.path, ['commit', '-am', 'main conflict']);
    expect(() => runGit(repo.path, ['merge', 'left2'])).toThrow();

    await expect(
      svc.commitSelected('should not run', [{ path: 'f.txt', hunkIndices: [0] }]),
    ).rejects.toThrow('in-progress merge');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/integration/commit-selected.integration.test.ts`
Expected: FAIL — `svc.commitSelected is not a function`.

- [ ] **Step 3a: Extend the patch-builder import**

In `graph/src/git/git-service.ts`, change the existing import (line ~17):

```typescript
import { buildReversePatch } from './patch-builder';
```

to:

```typescript
import { buildReversePatch, buildForwardPatch } from './patch-builder';
```

- [ ] **Step 3b: Implement `commitSelected` and `workingFileDiffRaw`**

In `graph/src/git/git-service.ts`, insert immediately after `getRepoOperationState()` (from Task 2):

```typescript
  /**
   * Raw HEAD→working-tree unified diff for a single file (no color), the text
   * `buildForwardPatch` parses. Mirrors getUncommittedFileDiff's command
   * selection but returns the raw string instead of a parsed DiffData: tracked
   * files use `git diff -- file`; an untracked new file uses
   * `git diff --no-index /dev/null file` (which exits 1 when it finds the
   * additions — normal, its stdout carries the diff).
   */
  private async workingFileDiffRaw(file: string): Promise<string> {
    this.assertSafePath(file, 'diff');
    const isTracked = await this.exec(['ls-files', '--error-unmatch', '--', file])
      .then(() => true)
      .catch(() => false);
    if (!isTracked) {
      return this.exec(['diff', '--no-color', '--no-index', '--', '/dev/null', file])
        .catch(err => (err instanceof GitError && err.exitCode === 1) ? err.stdout : '');
    }
    return this.exec(['diff', '--no-color', '--', file]).catch(() => '');
  }

  /**
   * Stage and commit ONLY the selected hunks of the given files, in one atomic
   * unit under the mutation lock (D1 + D4).
   *
   * Preconditions enforced here:
   *  - D4: the repo is not mid merge/rebase/cherry-pick/revert/bisect and has no
   *    unmerged index entries — else throw.
   *  - D1: the index is empty (nothing already staged) — else throw. With a
   *    clean index the flow is simply apply --cached → commit; no staged/unstaged
   *    reconciliation.
   *
   * The working tree is never modified, so unselected hunks remain as
   * uncommitted working changes and no tree reset is needed. On a mid-apply
   * failure the (partially staged) index is reset back to clean before the error
   * is rethrown, so a failed call never leaves the repo polluted.
   *
   * NOTE: runs inside withMutationLock, so all MUTATING git commands use
   * execUnlocked directly (exec would re-enter the lock and deadlock). Read-only
   * commands use exec, which does not take the lock for reads.
   */
  async commitSelected(message: string, files: Array<{ path: string; hunkIndices: number[] }>): Promise<string> {
    return this.withMutationLock(async () => {
      // D4: no in-progress operation.
      const opState = await this.getRepoOperationState();
      if (opState !== 'clean') {
        throw new Error(`repo has an in-progress ${opState}; resolve it first`);
      }
      // D4: no unmerged (conflicted) index entries.
      const unmerged = await this.exec(['ls-files', '--unmerged']).catch(() => '');
      if (unmerged.trim().length > 0) {
        throw new Error('repo has unmerged paths; resolve conflicts first');
      }

      // D1: the index must be clean. `git diff --cached --quiet` exits 0 when
      // nothing is staged, 1 when something is.
      const indexClean = await this.exec(['diff', '--cached', '--quiet'], { silent: true })
        .then(() => true)
        .catch(err => {
          if (err instanceof GitError && err.exitCode === 1) { return false; }
          throw err;
        });
      if (!indexClean) {
        throw new Error('index already has staged changes; commit or reset them first');
      }

      try {
        for (const { path, hunkIndices } of files) {
          const raw = await this.workingFileDiffRaw(path);
          if (!raw.trim()) {
            throw new Error(`no working-tree changes to stage for ${path}`);
          }
          const patch = buildForwardPatch(raw, hunkIndices);
          // `git apply` reads the patch from stdin when no path argument is given
          // (same as reverseCommitChanges); --cached stages into the index only.
          await this.execUnlocked(['apply', '--cached'], { stdin: patch });
        }
        await this.execUnlocked(['commit', '-m', message]);
      } catch (err) {
        // Undo any partial staging so a failed commit leaves a clean index; the
        // working tree was never touched, so a mixed reset restores the
        // pre-call state exactly.
        await this.execUnlocked(['reset', '--quiet']).catch(() => { /* best-effort cleanup */ });
        throw err;
      }

      return (await this.exec(['rev-parse', 'HEAD'])).trim();
    });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/git/__tests__/integration/commit-selected.integration.test.ts`
Expected: PASS — selective commit isolates hunk 0, hunk 1 stays unstaged, index clean; D1 and D4 gates throw.

- [ ] **Step 5: Typecheck the modified host file**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npm run lint`
Expected: `tsc --noEmit` completes with no errors (confirms the import extension and new signatures typecheck).

- [ ] **Step 6: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph
git add src/git/git-service.ts src/git/__tests__/integration/commit-selected.integration.test.ts
git commit -m "feat(git): 新增 commitSelected 逐 hunk 選取提交（D1 乾淨 index、D4 守門）"
```

---

## Task 4: Per-repo mutation coordinator (`runExclusive`)

D2 needs a host-level, repo-path-keyed serializer shared across panels. The existing `withMutationLock` is per-`GitService`-instance; this is a module-level lock so two panels (Graph + Workbench) holding different `GitService` instances for the *same* repo still serialize. B-1 only delivers the tested module; B-2 wraps mutating handlers with it.

**Files:**
- Create: `graph/src/services/mutation-coordinator.ts`
- Test: `graph/src/services/__tests__/mutation-coordinator.test.ts`

**Interfaces:**
- Produces: `export function runExclusive<T>(repoPath: string, fn: () => Promise<T>): Promise<T>` — same `repoPath` runs strictly one-at-a-time in call order (next starts only after the previous settles, success or failure); different `repoPath`s run concurrently.

- [ ] **Step 1: Write the failing tests**

Create `graph/src/services/__tests__/mutation-coordinator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { runExclusive } from '../mutation-coordinator';

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('runExclusive', () => {
  it('serializes calls on the same repo path (no interleaving)', async () => {
    const events: string[] = [];
    const first = runExclusive('/repo-a', async () => {
      events.push('1-enter');
      await tick(20);
      events.push('1-exit');
    });
    const second = runExclusive('/repo-a', async () => {
      events.push('2-enter');
      events.push('2-exit');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['1-enter', '1-exit', '2-enter', '2-exit']);
  });

  it('runs different repo paths concurrently', async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const aBlocked = new Promise<void>(r => { releaseA = r; });

    const pa = runExclusive('/repo-a', async () => {
      events.push('a-enter');
      await aBlocked; // stay inside until B has entered
      events.push('a-exit');
    });
    const pb = runExclusive('/repo-b', async () => {
      events.push('b-enter');
      releaseA(); // B entered while A was still blocked -> proves parallelism
    });

    await Promise.all([pa, pb]);
    expect(events).toEqual(['a-enter', 'b-enter', 'a-exit']);
  });

  it('a rejecting call does not break the chain for the next call', async () => {
    const boom = runExclusive('/repo-c', async () => { throw new Error('boom'); });
    await expect(boom).rejects.toThrow('boom');
    const after = await runExclusive('/repo-c', async () => 'ok');
    expect(after).toBe('ok');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/services/__tests__/mutation-coordinator.test.ts`
Expected: FAIL — cannot resolve `../mutation-coordinator`.

- [ ] **Step 3: Implement the coordinator**

Create `graph/src/services/mutation-coordinator.ts`:

```typescript
// Module-level, repo-path-keyed mutation serializer (design decision D2).
//
// GitService.withMutationLock is per-instance and per-command; it cannot make
// an apply→commit sequence atomic across panels. Two panels (the Graph view and
// the commit workbench) may hold different GitService instances for the SAME
// repo, so a per-instance lock lets them race on .git/index.lock. This module
// keeps one promise chain per repo path: same-path callers queue strictly in
// arrival order (the next starts only after the previous settles), while
// different paths proceed in parallel.
//
// B-2 wraps every mutating webview handler (Graph + workbench) in runExclusive;
// B-1 only delivers this tested module.
//
// ponytail: chains are never pruned from the Map — one entry per repo path
// touched this session, bounded by the workspace's repo count. Add eviction
// only if that ever becomes a real footprint problem.

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively with respect to other runExclusive calls for the same
 * `repoPath`. Calls with the same path never overlap and run in call order;
 * calls with different paths run concurrently. Rejection of one call does not
 * stall the queue — the next queued call still runs.
 */
export function runExclusive<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(repoPath) ?? Promise.resolve();
  // .then(fn, fn): chain onto the previous settle whether it resolved OR
  // rejected, so one failure never wedges the queue.
  const run = prev.then(fn, fn);
  // Swallow the result/error for the CHAIN pointer only; callers still see the
  // real outcome through the returned `run`.
  chains.set(repoPath, run.then(() => undefined, () => undefined));
  return run;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run src/services/__tests__/mutation-coordinator.test.ts`
Expected: PASS — same-path serialized, different-path concurrent, chain survives a rejection.

- [ ] **Step 5: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph
git add src/services/mutation-coordinator.ts src/services/__tests__/mutation-coordinator.test.ts
git commit -m "feat(services): 新增 per-repo mutation coordinator（D2 地基）"
```

---

## Final verification

- [ ] **Run the full backend + integration suite to confirm nothing regressed**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run --project backend`
Expected: all suites PASS, including the pre-existing `patch-builder`, `git-service`, and operation-state tests.

---

## Self-Review

**1. Spec coverage (against the design doc D1–D6 + Slice B host):**

| Spec item | Covered by | Notes |
|---|---|---|
| **D1** — commit only on a clean index; block + specific error when staged content exists | Task 3 (`commitSelected` `git diff --cached --quiet` gate + D1 integration test) | ✅ |
| **D2** — host-level, repo-path-keyed mutation coordinator shared across panels | Task 4 (`mutation-coordinator.ts` + unit tests) | ✅ module delivered; B-2 wires MainPanel/workbench through it (noted, out of B-1 scope) |
| **D3** — structured porcelain-v2 status model | **Intentionally deferred** to B-2 per the task brief | B-1 reuses existing `getUncommittedDiff` / `getUncommittedFileDiff` for the change list and per-file diff. `commitSelected` needs only raw per-file diff text, obtained via the new private `workingFileDiffRaw`. No gap for B-1's scope — see note below. |
| **D4** — block commit on merge/rebase/cherry-pick/revert/bisect-in-progress or unmerged index | Task 2 (`getRepoOperationState` incl. bisect) + Task 3 (unmerged-index guard + D4 integration test) | ✅ detached-HEAD "allow with warning" and unborn-HEAD "allow" are UX/warning behaviors deferred to B-2's panel layer; B-1's gate does not falsely block them (both report `'clean'`). |
| Slice B host — `buildForwardPatch` forward-selection patch builder | Task 1 | ✅ hunk-level; line-level explicitly v2 |
| Slice B host — `commitSelected`: apply --cached → commit, index self-heal on failure | Task 3 | ✅ no tree reset needed (working tree untouched); failure path resets index |
| Slice B host — commit-selected integration (part hunk committed, rest in worktree, index clean) | Task 3 test 1 | ✅ |

**2. Placeholder scan:** No `TODO`/`TBD`/"add error handling"/"similar to Task N"/prose-only code steps. Every code step carries complete, runnable code. Every referenced symbol is either defined in an earlier task (`buildForwardPatch`, `getRepoOperationState`, `workingFileDiffRaw`) or already exists in the codebase and was read during planning (`parseFileDiff`, `normalizeWholeFileHeader`, `getOperationState`, `withMutationLock`, `execUnlocked`, `exec`, `assertSafePath`, `gitDir`, `GitError`, test helpers `createTempRepo`/`commit`/`runGit`/`writeFile`/`head`).

**3. Type consistency:** `buildForwardPatch(rawFileDiff: string, selectedHunkIndices: number[]): string` — identical signature in Task 1 definition, Task 3 call site, and the Interfaces blocks. `getRepoOperationState(): Promise<'clean'|'merge'|'rebase'|'cherry-pick'|'revert'|'bisect'>` — the same union in Task 2, the Task 3 gate (`opState !== 'clean'`, `${opState}`), and the error message. `commitSelected(message: string, files: Array<{ path: string; hunkIndices: number[] }>): Promise<string>` — consistent across the Interfaces block, implementation, and every test call. `runExclusive<T>(repoPath: string, fn: () => Promise<T>): Promise<T>` — consistent between definition and tests.

**4. Deviations flagged for the implementer / reviewer:**

- **`getUncommittedFileDiff` returns parsed `DiffData`, not raw text.** The task brief said to reuse `getUncommittedFileDiff(path, false)` to get the raw HEAD→working diff, but that method parses into `DiffData` (`{ file, hunks, isBinary, isImage }`) — it has no raw field. `buildForwardPatch` needs the raw unified-diff string. Task 3 therefore adds a tiny private `workingFileDiffRaw` that mirrors `getUncommittedFileDiff`'s exact command selection (tracked → `git diff -- file`; untracked → `git diff --no-index /dev/null file`) but returns the raw string. This is the smallest honest way to satisfy the requirement; the alternative (refactoring `getUncommittedFileDiff` to split raw/parse) is a larger blast radius left out of B-1.
- **Reentrancy of the mutation lock.** `commitSelected` uses `execUnlocked` for `apply`/`commit`/`reset` because `exec()` re-enters `withMutationLock` and would deadlock inside the locked body. This is called out in a boxed note in Task 3 so the implementer does not "simplify" it back to `exec`.
- **`--recount` deliberately omitted** on `git apply --cached`. The reverse builder needs `--recount` because it rewrites hunk line counts; the forward builder emits hunks verbatim with their original correct counts, so omitting `--recount` keeps `apply` strict (a miscounted patch fails loudly instead of being silently fixed up).

**Spec-coverage gaps intentionally NOT closed in B-1 (by task-brief scope):** D3 structured status model; detached/unborn HEAD warning UX; pre-commit-hook tree comparison (D4's "hook changed tree → report anomaly"); stale-selection fingerprint validation; multi-repo orchestration and per-repo partial-failure reporting; ClipCode snapshot接點 (D6); all webview/UI. These belong to B-2 and later slices; none is required for the four host primitives B-1 delivers.
