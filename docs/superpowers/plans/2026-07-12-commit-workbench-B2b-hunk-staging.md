# Commit Workbench B-2b — 逐 Hunk Partial Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有的「Snipcode Git」提交工作台加一個 webview「Diff」view —— 點 Changes 樹的檔案就把該檔 diff 渲染在 Diff 面板，每個 hunk 一個 checkbox，用「Stage 選取 / Unstage 選取」把選中的 hunk stage/unstage 進真實 index。

**Architecture:** host 端在 `GitService` 加 `stageHunks` / `unstageHunks`，兩者都複用既有的 `buildForwardPatch`（不碰 `buildReversePatch`）：stage 走 unstaged raw（`git diff -- file`）→ `git apply --cached`；unstage 走 staged raw（`git diff --cached -- file`）→ `git apply --cached --reverse`。webview 是一個**新的獨立 WebviewViewProvider**（viewType `snipcode.diff`），照 `commit-box-view.ts` 的 CSP/nonce/asset 樣板，載入一個**新的 vite 單入口** bundle（`diff.js`/`diff.css`）。點檔案節點的樹命令改成驅動 Diff view；stage/unstage 後刷新 Changes 樹並重送該檔最新 hunks。全部 mutation 走 `runExclusive(repoPath)`。

**Tech Stack:** TypeScript（extension host, `graph/src/`）、Svelte 5 runes（webview, `graph/webview-ui/`）、Vite（webview bundle）、Vitest（backend 真 git + webview happy-dom）、esbuild（host bundle，由 root build 拉入）。

## Scope Fence（v1）

**做（this plan）:**
- 新 Diff webview view（viewType `snipcode.diff`，第三個 view 進 `snipcode-git` 容器）。
- 點 Changes 樹的檔案 → 在 Diff 面板顯示該檔 diff。
- 每個 hunk 一個 checkbox；全選 / 清空。
- 「Stage 選取」（unstaged 側）/「Unstage 選取」（staged 側）按鈕。
- host `GitService.stageHunks` / `unstageHunks`（複用 `buildForwardPatch` 雙向）。
- stage/unstage 後刷新 Changes 樹 + 重送 Diff view 該檔最新 hunks。
- 新 `vite.diff.config.ts` 單入口 + `copy-graph-assets.mjs` 收 `diff.js`/`diff.css`。

**不做（留後續，v2）:**
- 逐行 line-level 選取（`lineIndices`）。
- Shiki 語法上色（v1 用簡單 diff CSS）。
- stale 指紋防護（v1 host 在 stage/unstage 時**重取** raw 再 `buildForwardPatch`，接受「檔案在期間變動時 hunk index 可能對不上」為已知限制）。
- changelist 命名分組。
- `copyAsClipCode` 改成複製 diff。
- 動態 repo 增減 re-wiring（沿用現況：activation 時一次性 discover）。

## Global Constraints

以下每一條都隱含在**每個** Task 的要求裡（逐字照抄自現有慣例）：

- **`git/` 模組不得 import `vscode`。** `GitService` 與 parser 必須能對真 git CLI 做 unit test。任何 vscode-aware 的東西（settings、內建 git 擴充 API）留在 `extension.ts`/`panels/`/`tree/` 或 bridge。
- **每個 webview bundle 必須 self-contained（無 shared chunk、無 top-level `import`）。** host 用 classic `<script nonce src>`（CSP `script-src 'nonce-…'`，**不是** `type="module"`）。所以 graph（`vite.config.ts`）、Commit Workbench（`vite.workbench.config.ts`）、以及本計畫的 Diff（`vite.diff.config.ts`）各自是**獨立單入口** build，背靠背跑。**絕不可**併成多入口 vite build（多入口會把共用 Svelte runtime 拆成 chunk 讓 webview 開空白、handshake timeout）。
- **新增的 webview asset 必須被 `scripts/copy-graph-assets.mjs` 收進 `dist/graph-webview/`**，否則 VSIX 不會 ship，view 會開空白。
- **新命令要同時進 `package.json` 的 `contributes.commands`（＋需要的 `menus`）並在 host 端 `registerCommand`。** 新 view 要進 `contributes.views`。
- **Mutating git 指令序列化**：host 端每個 repo 的 mutation 走 `runExclusive(repoPath, fn)`（`graph/src/services/mutation-coordinator.ts`）。`GitService.exec()` 對 `apply` 這種 mutation 已自動走 `withMutationLock`（見 `reverseCommitChanges` 用 `this.exec(['apply', ...])`）。
- **Svelte 5 `$state` 值是 reactive proxy**：要 `postMessage` 前先 snapshot / 展開（host 端送的是 host 自己組的 plain object，不受此限；webview 端若要回送 `$state` 陣列請先 `[...set]` 攤平）。
- **`$state<Set>` 的更新用「重建再指派」**（`this.checked = new Set(...)`），不要原地 mutate，否則 Svelte 不重繪。
- **commit / PR 訊息一律繁體中文，且不得有任何 attribution 行**（無 `Co-Authored-By`）。程式碼註解用英文。

---

## Task 1: `GitService.stageHunks` / `unstageHunks`（host，可測）

在 `GitService` 加逐 hunk stage/unstage，複用既有 `buildForwardPatch`（已 import 於檔案頂端 line 17）。這是唯一可直接對真 git 做整合測試的部分，先做。

**Files:**
- Modify: `graph/src/git/git-service.ts`（在 `workingFileDiffRaw`（~line 2248）/ `commitSelected`（~line 2280）附近新增三個 method）
- Test: `graph/src/git/__tests__/integration/hunk-staging.integration.test.ts`（新增）

**Interfaces:**
- Consumes（既有，不要重寫）:
  - `private async workingFileDiffRaw(file: string): Promise<string>` — tracked 檔回 `git diff --no-color -- file`（index→working，即 unstaged raw）；untracked 新檔回 `git diff --no-color --no-index /dev/null file`。**這就是 stage 側要的 raw。**
  - `export function buildForwardPatch(rawFileDiff: string, selectedHunkIndices: number[]): string`（`graph/src/git/patch-builder.ts`）—— 從 raw 抽出選中的 hunk 逐字輸出成 patch。hunk-level（v1）。
  - `private exec(args, options?)` / `private execUnlocked(args, options?)`：`options` 含 `{ stdin?, timeout?, silent?, maxBufferBytes? }`。`exec` 會對 `apply` 這類 mutation 自動走 `withMutationLock`。
  - `private assertSafePath(filePath: string, context: string): void`。
  - `async getUncommittedFileDiff(file: string, staged: boolean): Promise<DiffData | null>`（read path，Task 3 的 webview 讀 hunks 用；與此處 raw 用同一組 git 指令，故 hunk 順序對齊）。
- Produces（Task 3 依賴）:
  - `async stageHunks(file: string, hunkIndices: number[]): Promise<void>`
  - `async unstageHunks(file: string, hunkIndices: number[]): Promise<void>`

- [ ] **Step 1: 寫失敗的整合測試**

Create `graph/src/git/__tests__/integration/hunk-staging.integration.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

// Two edit sites far apart (line 2 and line 14) so git keeps them in two
// separate hunks. hunk 0 = beta→beta2, hunk 1 = xi→xi2.
const BASE = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\n';
const CHANGED = 'alpha\nbeta2\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi2\nomicron\npi\n';

describe('GitService integration — stageHunks / unstageHunks', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    commit(repo.path, 'base', { 'f.txt': BASE });
    writeFile(repo.path, 'f.txt', CHANGED); // two unstaged hunks, nothing staged
  });
  afterEach(() => repo.cleanup());

  it('stageHunks([0]) stages only hunk 0, leaving hunk 1 unstaged (MM)', async () => {
    await svc.stageHunks('f.txt', [0]);

    // Index holds hunk 0 (beta2) but NOT hunk 1 (xi2).
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+beta2');
    expect(cached).not.toContain('+xi2');

    // The file is now BOTH staged (hunk 0) and unstaged (hunk 1): porcelain MM.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('MM');

    // The working tree is untouched — still carries both edits.
    const wt = runGit(repo.path, ['show', ':f.txt']); // index version has hunk0 only
    expect(wt).toContain('\nbeta2\n');
    expect(wt).toContain('\nxi\n'); // index still has old xi (hunk1 not staged)
  });

  it('unstageHunks([0]) unstages only hunk 0, leaving hunk 1 staged (MM)', async () => {
    // Stage the whole file first (both hunks in the index).
    runGit(repo.path, ['add', 'f.txt']);
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('M ');

    await svc.unstageHunks('f.txt', [0]);

    // Index keeps hunk 1 (xi2) but NOT hunk 0 (beta2).
    const cached = runGit(repo.path, ['diff', '--cached', 'f.txt']);
    expect(cached).toContain('+xi2');
    expect(cached).not.toContain('+beta2');

    // hunk 0 is now unstaged again while hunk 1 stays staged: porcelain MM.
    expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('MM');
  });

  it('stageHunks throws when the file has no unstaged changes', async () => {
    runGit(repo.path, ['checkout', '--', 'f.txt']); // discard working edits
    await expect(svc.stageHunks('f.txt', [0])).rejects.toThrow(/no unstaged changes/);
  });

  it('unstageHunks throws when the file has no staged changes', async () => {
    await expect(svc.unstageHunks('f.txt', [0])).rejects.toThrow(/no staged changes/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd graph && npx vitest run src/git/__tests__/integration/hunk-staging.integration.test.ts --project backend`
Expected: FAIL —— `svc.stageHunks is not a function` / `svc.unstageHunks is not a function`（method 尚未存在）。

- [ ] **Step 3: 實作三個 method**

在 `graph/src/git/git-service.ts` 的 `workingFileDiffRaw`（~line 2248）之後、`commitSelected` 之前插入：

```ts
  /**
   * Raw HEAD→index (staged) unified diff for one file (no color) — the text
   * buildForwardPatch parses to reverse-stage selected hunks. Mirrors
   * getUncommittedFileDiff(file, true)'s command so the parsed hunk order lines
   * up with the diff the webview rendered.
   */
  private async stagedFileDiffRaw(file: string): Promise<string> {
    this.assertSafePath(file, 'diff');
    return this.exec(['diff', '--no-color', '--cached', '--', file]).catch(() => '');
  }

  /**
   * Stage ONLY the selected hunks of a file's unstaged (index→working) diff into
   * the index, leaving the working tree and every other hunk untouched. Reuses
   * buildForwardPatch (hunk-level, v1) on the SAME diff the Diff webview rendered
   * (workingFileDiffRaw == getUncommittedFileDiff(file, false)'s command), then
   * `git apply --cached`. `hunkIndices` index into that diff's parsed hunk list.
   * v1 re-fetches the raw here; if the file changed since the webview rendered,
   * the indices may not line up (accepted limitation — stale fingerprint is v2).
   */
  async stageHunks(file: string, hunkIndices: number[]): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.workingFileDiffRaw(file);
    if (!raw.trim()) { throw new Error(`no unstaged changes to stage for ${file}`); }
    const patch = buildForwardPatch(raw, hunkIndices);
    // exec routes 'apply' through withMutationLock (it is a mutation); stdin
    // feeds the patch (same as reverseCommitChanges). --cached stages only.
    await this.exec(['apply', '--cached'], { stdin: patch });
  }

  /**
   * Unstage ONLY the selected hunks of a file's staged (HEAD→index) diff back to
   * the working tree, leaving other staged hunks in the index. Builds a forward
   * patch of the chosen hunks from the STAGED diff and reverse-applies it to the
   * index (`git apply --cached --reverse`) — the `git reset -p` direction.
   * `hunkIndices` index into getUncommittedFileDiff(file, true)'s hunk list.
   */
  async unstageHunks(file: string, hunkIndices: number[]): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.stagedFileDiffRaw(file);
    if (!raw.trim()) { throw new Error(`no staged changes to unstage for ${file}`); }
    const patch = buildForwardPatch(raw, hunkIndices);
    await this.exec(['apply', '--cached', '--reverse'], { stdin: patch });
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd graph && npx vitest run src/git/__tests__/integration/hunk-staging.integration.test.ts --project backend`
Expected: PASS（4 個 test 全綠；判斷依 `Tests …` 文字，不看管線 exit code）。

- [ ] **Step 5: 型別檢查**

Run: `cd graph && npm run lint`
Expected: `tsc --noEmit` 無錯。

- [ ] **Step 6: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/src/git/git-service.ts graph/src/git/__tests__/integration/hunk-staging.integration.test.ts
git commit -m "feat(git): 加逐 hunk stageHunks/unstageHunks（複用 buildForwardPatch 雙向）"
```

---

## Task 2: Diff webview（store + 元件 + 獨立 vite 單入口 + asset 管線）

新增 Diff webview 的前端：store（可測）、Svelte 元件、entry、`diff.html`、`vite.diff.config.ts`、messaging，並把新 bundle 接進 build script 與 `copy-graph-assets.mjs`。這個 Task 的 deliverable 是 `dist/graph-webview/diff.js` + `diff.css` 真的被產出。

**Files:**
- Create: `graph/webview-ui/src/diff/diff-store.svelte.ts`
- Create: `graph/webview-ui/src/diff/messaging.ts`
- Create: `graph/webview-ui/src/diff/Diff.svelte`
- Create: `graph/webview-ui/src/diff.ts`（entry）
- Create: `graph/webview-ui/diff.html`
- Create: `graph/webview-ui/vite.diff.config.ts`
- Create: `graph/webview-ui/src/diff/__tests__/diff-store.test.ts`
- Modify: `graph/webview-ui/package.json`（`build` script 尾巴再加一個 vite build）
- Modify: `scripts/copy-graph-assets.mjs`（required 清單加 `diff.js` / `diff.css`）

**Interfaces:**
- Consumes（Task 3 host 送來的 postMessage）:
  - host → webview：`{ type: 'diffShow', payload: { repoPath: string; file: string; side: 'staged' | 'unstaged'; hunks: DiffHunkView[] } }`
  - host → webview：`{ type: 'error', payload: { source: 'diffStageHunks'; message: string } }`
  - `DiffHunkView = { header: string; lines: Array<{ type: 'context' | 'add' | 'delete'; content: string }> }`（是 host `DiffHunk` 的可序列化子集：只用到 `header` 與 `lines[].{type,content}`）。
- Produces（webview → host，Task 3 消費）:
  - `{ type: 'diffStageHunks', payload: { repoPath: string; file: string; side: 'staged' | 'unstaged'; hunkIndices: number[] } }`

- [ ] **Step 1: 寫失敗的 store 測試**

Create `graph/webview-ui/src/diff/__tests__/diff-store.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore, type DiffHunkView } from '../diff-store.svelte';

const HUNKS: DiffHunkView[] = [
  { header: '@@ -1,2 +1,2 @@', lines: [{ type: 'delete', content: 'a' }, { type: 'add', content: 'a2' }] },
  { header: '@@ -9,2 +9,2 @@', lines: [{ type: 'delete', content: 'b' }, { type: 'add', content: 'b2' }] },
];

beforeEach(() => diffStore.reset());

describe('DiffStore', () => {
  it('setDiff selects every hunk by default', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    expect(diffStore.file).toBe('f.txt');
    expect(diffStore.side).toBe('unstaged');
    expect(diffStore.selectedIndices).toEqual([0, 1]);
    expect(diffStore.canApply).toBe(true);
  });

  it('toggle flips a single hunk', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    diffStore.toggle(0);
    expect(diffStore.selectedIndices).toEqual([1]);
    diffStore.toggle(0);
    expect(diffStore.selectedIndices).toEqual([0, 1]);
  });

  it('clear empties the selection and blocks apply; selectAll restores it', () => {
    diffStore.setDiff('/repo', 'f.txt', 'staged', HUNKS);
    diffStore.clear();
    expect(diffStore.selectedIndices).toEqual([]);
    expect(diffStore.canApply).toBe(false);
    diffStore.selectAll();
    expect(diffStore.selectedIndices).toEqual([0, 1]);
    expect(diffStore.canApply).toBe(true);
  });

  it('actionLabel reflects the side', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    expect(diffStore.actionLabel).toBe('Stage 選取');
    diffStore.setDiff('/repo', 'f.txt', 'staged', HUNKS);
    expect(diffStore.actionLabel).toBe('Unstage 選取');
  });

  it('busy blocks apply (guards double-submit)', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    diffStore.busy = true;
    expect(diffStore.canApply).toBe(false);
  });

  it('an empty diff cannot apply', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', []);
    expect(diffStore.canApply).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/diff-store.test.ts --project webview`
Expected: FAIL —— 找不到 `../diff-store.svelte`（模組尚未存在）。

- [ ] **Step 3: 實作 store**

Create `graph/webview-ui/src/diff/diff-store.svelte.ts`：

```ts
// Webview-side state for the Diff view: the current file's hunks + which hunks
// are checked to be staged/unstaged. Its own bundle/context (self-contained
// diff.js), separate from the graph and the commit box.

export type DiffSide = 'staged' | 'unstaged';

export interface DiffHunkView {
  header: string;
  lines: Array<{ type: 'context' | 'add' | 'delete'; content: string }>;
}

class DiffStore {
  repoPath = $state('');
  file = $state('');
  side = $state<DiffSide>('unstaged');
  hunks = $state<DiffHunkView[]>([]);
  /** Hunk indices the user has checked to apply. Reassigned (never mutated) so
   *  Svelte repaints. */
  checked = $state<Set<number>>(new Set());
  /** True while a stage/unstage round-trip is in flight (disables the button). */
  busy = $state(false);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.side = 'unstaged';
    this.hunks = [];
    this.checked = new Set();
    this.busy = false;
    this.error = null;
  }

  setDiff(repoPath: string, file: string, side: DiffSide, hunks: DiffHunkView[]): void {
    this.repoPath = repoPath;
    this.file = file;
    this.side = side;
    this.hunks = hunks;
    this.checked = new Set(hunks.map((_, i) => i)); // default: every hunk selected
    this.busy = false;
    this.error = null;
  }

  toggle(i: number): void {
    const next = new Set(this.checked);
    if (next.has(i)) { next.delete(i); } else { next.add(i); }
    this.checked = next;
  }

  selectAll(): void {
    this.checked = new Set(this.hunks.map((_, i) => i));
  }

  clear(): void {
    this.checked = new Set();
  }

  get selectedIndices(): number[] {
    return [...this.checked].sort((a, b) => a - b);
  }

  get canApply(): boolean {
    return this.hunks.length > 0 && this.checked.size > 0 && !this.busy;
  }

  get actionLabel(): string {
    return this.side === 'staged' ? 'Unstage 選取' : 'Stage 選取';
  }
}

export const diffStore = new DiffStore();
```

- [ ] **Step 4: 跑 store 測試確認通過**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/diff-store.test.ts --project webview`
Expected: PASS（6 個 test 全綠）。

- [ ] **Step 5: 實作 messaging（host ↔ webview）**

Create `graph/webview-ui/src/diff/messaging.ts`：

```ts
// Host <-> webview messaging for the Diff view, split out of diff.ts so
// Diff.svelte can import postStageHunks without a circular entry import.
// Mirrors workbench/messaging.ts: this bundle has its own vscode api context.
import { diffStore } from './diff-store.svelte';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

// Bound wait so a disposed/reloaded view mid-apply doesn't leave the button
// stuck disabled forever (the squash-modal stuck-forever bug family — AGENTS.md).
const APPLY_TIMEOUT_MS = 30_000;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

function clearApplyTimer(): void {
  if (applyTimer !== null) {
    clearTimeout(applyTimer);
    applyTimer = null;
  }
}

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        // A fresh diff arrived (initial click OR a re-render after apply) — the
        // apply round-trip, if any, is done.
        clearApplyTimer();
        diffStore.setDiff(msg.payload.repoPath, msg.payload.file, msg.payload.side, msg.payload.hunks);
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunks') {
          clearApplyTimer();
          diffStore.busy = false;
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        break;
    }
  });
}

/** Post the checked hunks to the host; side decides stage vs unstage. */
export function postStageHunks(): void {
  if (!diffStore.canApply) { return; }
  diffStore.busy = true;
  diffStore.error = null;
  clearApplyTimer();
  applyTimer = setTimeout(() => {
    applyTimer = null;
    diffStore.busy = false;
    diffStore.error = '操作逾時，未收到結果，請重新整理後確認狀態。';
  }, APPLY_TIMEOUT_MS);
  vscode.postMessage({
    type: 'diffStageHunks',
    payload: {
      repoPath: diffStore.repoPath,
      file: diffStore.file,
      side: diffStore.side,
      hunkIndices: diffStore.selectedIndices, // already a plain number[]
    },
  });
}
```

- [ ] **Step 6: 實作 Diff.svelte（簡單 diff CSS，無 Shiki）**

Create `graph/webview-ui/src/diff/Diff.svelte`：

```svelte
<script lang="ts">
  import { diffStore } from './diff-store.svelte';
  import { postStageHunks } from './messaging';

  const store = diffStore;
</script>

<div class="diff-view">
  {#if store.hunks.length === 0}
    <p class="empty">點左側 Changes 的檔案以檢視 diff。</p>
  {:else}
    <div class="header">
      <span class="codicon codicon-diff-single"></span>
      <span class="file" title={store.file}>{store.file}</span>
      <span class="side {store.side}">{store.side === 'staged' ? 'Staged' : 'Unstaged'}</span>
    </div>

    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}

    <div class="toolbar">
      <button class="link" onclick={() => store.selectAll()}>全選</button>
      <button class="link" onclick={() => store.clear()}>清空</button>
      <button class="btn primary" disabled={!store.canApply} onclick={() => postStageHunks()}>
        {#if store.busy}<span class="codicon codicon-loading spin"></span>{/if}
        {store.actionLabel}
      </button>
    </div>

    <div class="hunks">
      {#each store.hunks as hunk, i (i)}
        <div class="hunk">
          <label class="hunk-head">
            <input type="checkbox" checked={store.checked.has(i)} onchange={() => store.toggle(i)} />
            <span class="hunk-header">{hunk.header}</span>
          </label>
          <div class="lines">
            {#each hunk.lines as line}
              <div class="line {line.type}">{line.content}</div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-view {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--vscode-foreground);
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .empty { padding: 12px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family);
  }
  .header .file { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header .side {
    margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .banner {
    display: flex; align-items: center; gap: 6px; margin: 6px 8px; padding: 4px 8px;
    border-radius: 4px; font-size: 11.5px; font-family: var(--vscode-font-family);
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    font-family: var(--vscode-font-family);
  }
  .toolbar .link {
    background: none; border: none; color: var(--vscode-textLink-foreground);
    cursor: pointer; font-size: 12px; padding: 0;
  }
  .toolbar .link:hover { text-decoration: underline; }
  .btn {
    margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border: 1px solid transparent; border-radius: 4px;
    font-size: 12px; cursor: pointer; white-space: nowrap;
    font-family: var(--vscode-font-family);
  }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .hunks { overflow: auto; flex: 1; }
  .hunk { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
  .hunk-head {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer;
    background: var(--vscode-editor-lineHighlightBackground, rgba(128,128,128,0.08));
  }
  .hunk-header { color: var(--vscode-descriptionForeground); }
  .lines { white-space: pre; overflow-x: auto; }
  .line { padding: 0 8px; }
  .line.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(70,149,74,0.25)); }
  .line.delete { background: var(--vscode-diffEditor-removedTextBackground, rgba(200,60,60,0.25)); }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
```

- [ ] **Step 7: 實作 entry `diff.ts`**

Create `graph/webview-ui/src/diff.ts`：

```ts
import { mount } from 'svelte';
import Diff from './diff/Diff.svelte';
import { listenForHostMessages } from './diff/messaging';

listenForHostMessages();
mount(Diff, { target: document.getElementById('diff-app')! });
```

（v1 不 import 全域 css —— 元件自帶 inline `<style>`，vite `cssCodeSplit:false` 會全部收進 `diff.css`。）

- [ ] **Step 8: 建 `diff.html`（vite 入口）**

Create `graph/webview-ui/diff.html`：

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Snipcode Diff</title>
  </head>
  <body>
    <div id="diff-app"></div>
    <script type="module" src="/src/diff.ts"></script>
  </body>
</html>
```

- [ ] **Step 9: 建 `vite.diff.config.ts`（第三個獨立單入口）**

Create `graph/webview-ui/vite.diff.config.ts`：

```ts
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Separate, self-contained build for the Diff webview (diff.html → src/diff.ts).
// Kept apart from the graph (vite.config.ts) and commit-box (vite.workbench.config.ts)
// builds so the three never share a chunk: SnipcodeDiffViewProvider loads diff.js
// as a CLASSIC <script> (nonce CSP, no type="module"), so a top-level `import`
// from a shared chunk would break boot. `inlineDynamicImports` forces ONE
// self-contained diff.js. Runs with emptyOutDir:false so it ADDS to (never wipes)
// the graph + workbench dist output.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'diff.html'),
      output: {
        entryFileNames: 'diff.js',
        assetFileNames: 'diff.css',
        inlineDynamicImports: true,
      },
    },
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 800,
  },
});
```

- [ ] **Step 10: 把 Diff build 接進 `webview-ui` 的 build script**

Modify `graph/webview-ui/package.json` —— 把 `build` 那行從：

```json
    "build": "vite build && vite build --config vite.workbench.config.ts",
```

改成（在尾巴再串一個 vite build，三個單入口背靠背）：

```json
    "build": "vite build && vite build --config vite.workbench.config.ts && vite build --config vite.diff.config.ts",
```

- [ ] **Step 11: 讓 `copy-graph-assets.mjs` 要求 diff bundle 存在**

Modify `scripts/copy-graph-assets.mjs` —— required 檢查清單從：

```js
  for (const required of ['main.js', 'main.css', 'workbench.js', 'workbench.css']) {
```

改成：

```js
  for (const required of ['main.js', 'main.css', 'workbench.js', 'workbench.css', 'diff.js', 'diff.css']) {
```

（`for…of readdir(viteDist)` 迴圈已經會把 dist 裡**每個**檔案 cp 進 `dist/graph-webview/`，所以 `diff.js`/`diff.css` 自動被複製；這裡只是把它們加進「缺了就 fail」的守門清單。）

- [ ] **Step 12: 跑 webview build 確認三個 bundle 都產出**

Run: `cd graph/webview-ui && npm run build`
Expected: 三次 vite build 都 `built in …`；檢查 `graph/webview-ui/dist/` 內同時有 `main.js`、`workbench.js`、`diff.js`（＋各自 `.css`）。

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && node scripts/copy-graph-assets.mjs`
Expected: `copied graph webview assets -> …/dist/graph-webview`，且不因缺 `diff.js`/`diff.css` 而 throw。

- [ ] **Step 13: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/webview-ui/src/diff graph/webview-ui/src/diff.ts graph/webview-ui/diff.html \
  graph/webview-ui/vite.diff.config.ts graph/webview-ui/package.json scripts/copy-graph-assets.mjs
git commit -m "feat(webview): 加 Diff view 前端（store + 元件 + 獨立 vite 單入口 + asset 管線）"
```

---

## Task 3: `SnipcodeDiffViewProvider` + workbench 串接 + package.json 貢獻

把前端接上 host：新 WebviewViewProvider（照 `commit-box-view.ts`）、`ChangesWorkbench` 加讀 diff / stage / unstage / 驅動 Diff view 的方法、`extension.ts` 註冊、`package.json` 加 view / commands / menus，並把 Changes 樹的檔案點擊改成驅動 Diff view。這部分 vscode-bound，靠型別檢查 + build + F5 手動驗證。

**Files:**
- Create: `graph/src/tree/diff-view.ts`（`SnipcodeDiffViewProvider`）
- Modify: `graph/src/tree/changes-workbench.ts`（加 `fileDiff` / `stageHunks` / `unstageHunks` / `setDiffView` / `showInDiffView` + `registerCommands` 加 `snipcode.git.showDiff`）
- Modify: `graph/src/tree/changes-tree.ts`（file 節點 command 改指向 `snipcode.git.showDiff`）
- Modify: `graph/src/extension.ts`（註冊 provider、`workbench.setDiffView(...)`）
- Modify: `package.json`（`contributes.views` 加 `snipcode.diff`；`contributes.commands` 加 `snipcode.git.showDiff`、`snipcode.git.openChange` 的 menu）

**Interfaces:**
- Consumes:
  - `GitService.stageHunks(file, hunkIndices)` / `unstageHunks(file, hunkIndices)`（Task 1）。
  - `GitService.getUncommittedFileDiff(file, staged): Promise<DiffData | null>`（既有；讀 hunks，與 stage/unstage raw 對齊）。
  - `runExclusive(repoPath, fn)`（`../services/mutation-coordinator`）。
  - `MainPanel.assetRootUri`（既有；`dist/graph-webview` 的 asset root）。
  - webview→host `{ type: 'diffStageHunks', payload: { repoPath, file, side, hunkIndices } }`（Task 2）。
  - `FileNode`（`./build-change-tree`）欄位：`repoPath`、`path`、`group: 'staged' | 'unstaged'`。
- Produces:
  - `class SnipcodeDiffViewProvider implements vscode.WebviewViewProvider`，`static readonly viewType = 'snipcode.diff'`，`show(repoPath: string, file: string, side: ChangeGroup): void`。
  - host→webview `{ type: 'diffShow', payload: { repoPath, file, side, hunks: DiffHunk[] } }`（`DiffHunk` 的 `header`/`lines[].{type,content}` 即 Task 2 的 `DiffHunkView`）。
  - command `snipcode.git.showDiff`（arg = `FileNode`）。

- [ ] **Step 1: 建 `SnipcodeDiffViewProvider`**

Create `graph/src/tree/diff-view.ts`：

```ts
import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { ChangeGroup } from './build-change-tree';
import type { ChangesWorkbench } from './changes-workbench';

/**
 * The Diff webview at the bottom of the Snipcode Git container. Clicking a file
 * node in the Changes tree drives show(): the host fetches that file's staged or
 * unstaged hunks and posts them here; each hunk gets a checkbox and a
 * "Stage 選取 / Unstage 選取" button that applies the checked hunks to the real
 * index (via ChangesWorkbench → GitService.stageHunks / unstageHunks).
 *
 * Its bundle (diff.js/diff.css) is a self-contained CLASSIC script — mirrors
 * CommitBoxViewProvider's CSP/nonce/asset loading.
 */
export class SnipcodeDiffViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'snipcode.diff';

  private view: vscode.WebviewView | undefined;
  /** The last-requested diff, buffered until the view has resolved (a collapsed
   *  view has no webview yet) and re-pushed on every show(). */
  private pending: { repoPath: string; file: string; side: ChangeGroup } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  /** Show a file's diff in the panel. Called on a tree click and again after a
   *  stage/unstage so the panel reflects the file's new state. */
  show(repoPath: string, file: string, side: ChangeGroup): void {
    this.pending = { repoPath, file, side };
    if (this.view) {
      this.view.show?.(true); // reveal without stealing focus, if collapsed
      void this.push();
    } else {
      // Force the view to resolve; push() runs from resolveWebviewView.
      void vscode.commands.executeCommand('snipcode.diff.focus');
    }
  }

  private async push(): Promise<void> {
    if (!this.view || !this.pending) { return; }
    const { repoPath, file, side } = this.pending;
    const hunks = await this.workbench.fileDiff(repoPath, file, side);
    void this.view.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, side, hunks } });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assetRoot = MainPanel.assetRootUri ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    view.webview.html = this.getHtml(view.webview, assetRoot);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type !== 'diffStageHunks') { return; }
      const { repoPath, file, side, hunkIndices } = msg.payload ?? {};
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), hunkIndices as number[]);
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), hunkIndices as number[]);
        }
        // ChangesWorkbench.stageHunks/unstageHunks re-push the file's new diff
        // (via this.show), so no extra post is needed here.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void view.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunks', message } });
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
      }
    });

    // Flush any diff requested before the view resolved.
    if (this.pending) { void this.push(); }
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${codiconUri}" rel="stylesheet" />
</head>
<body>
  <div id="diff-app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}
```

- [ ] **Step 2: `ChangesWorkbench` 加 diff 讀取 / stage / unstage / view 串接**

Modify `graph/src/tree/changes-workbench.ts`：

(a) 檔頭 import 補上型別與 provider：

```ts
import type { RepoStatus, FileNode, RepoNode, ChangeGroup } from './build-change-tree';
import type { DiffHunk } from '../git/types';
import type { SnipcodeDiffViewProvider } from './diff-view';
```

（把原本第 7 行的 `import type { RepoStatus, FileNode, RepoNode } from './build-change-tree';` 換成上面第一行；另兩個 import 新增。）

(b) 在 class 內（`private view` 附近）加欄位與 setter：

```ts
  private diffView: SnipcodeDiffViewProvider | undefined;

  /** Wire the Diff webview so file clicks and post-stage refreshes can drive it. */
  setDiffView(view: SnipcodeDiffViewProvider): void { this.diffView = view; }
```

(c) 加讀 diff 與 hunk stage/unstage 的 method（放在 `openChange` 之後即可）：

```ts
  /** Read a file's parsed hunks (staged or unstaged side) for the Diff webview.
   *  Reuses getUncommittedFileDiff so the hunk order aligns with the raw
   *  stageHunks/unstageHunks re-fetch (same git diff command per side). */
  async fileDiff(repoPath: string, file: string, side: ChangeGroup): Promise<DiffHunk[]> {
    const diff = await this.svcFor(repoPath)
      .getUncommittedFileDiff(file, side === 'staged')
      .catch(() => null);
    return diff?.hunks ?? [];
  }

  /** Drive the Diff webview from a clicked file node (tree command). */
  private showInDiffView(node: FileNode): void {
    this.diffView?.show(node.repoPath, node.path, node.group);
  }

  /** Stage the selected hunks of one unstaged file, then refresh the tree and
   *  re-render the file's (now smaller) unstaged diff in the panel. */
  async stageHunks(repoPath: string, file: string, hunkIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).stageHunks(file, hunkIndices));
    await this.refresh();
    this.diffView?.show(repoPath, file, 'unstaged');
  }

  /** Unstage the selected hunks of one staged file, then refresh + re-render the
   *  file's remaining staged diff. */
  async unstageHunks(repoPath: string, file: string, hunkIndices: number[]): Promise<void> {
    await runExclusive(repoPath, () => this.svcFor(repoPath).unstageHunks(file, hunkIndices));
    await this.refresh();
    this.diffView?.show(repoPath, file, 'staged');
  }
```

(d) 在 `registerCommands` 內、`snipcode.git.openChange` 那行下面加：

```ts
    reg('snipcode.git.showDiff', (n) => this.showInDiffView(n as FileNode));
```

- [ ] **Step 3: Changes 樹的檔案點擊改驅動 Diff view**

Modify `graph/src/tree/changes-tree.ts` —— file 節點的 `item.command` 從 `snipcode.git.openChange` 改成 `snipcode.git.showDiff`：

```ts
    item.command = {
      command: 'snipcode.git.showDiff',
      title: 'Show Diff',
      arguments: [node],
    };
```

（`snipcode.git.openChange`（在完整編輯器開）保留為次要動作 —— 見 Step 5 的 context menu。）

- [ ] **Step 4: `extension.ts` 註冊 Diff provider 並串接 workbench**

Modify `graph/src/extension.ts`：

(a) 檔頭 import（`CommitBoxViewProvider` import 旁）：

```ts
import { SnipcodeDiffViewProvider } from './tree/diff-view';
```

(b) 把既有的 workbench 註冊區塊（~line 191–204）擴充為（新增建立 `diffView`、`setDiffView`、`registerWebviewViewProvider`）：

```ts
  const workbench = new ChangesWorkbench();
  const changesView = vscode.window.createTreeView('snipcode.changes', { treeDataProvider: workbench.tree, showCollapseAll: true, canSelectMany: true });
  workbench.setView(changesView);
  changesView.onDidChangeCheckboxState((e) => workbench.handleCheckboxChange(e.items));
  const diffView = new SnipcodeDiffViewProvider(context.extensionUri, workbench);
  workbench.setDiffView(diffView);
  context.subscriptions.push(
    workbench,
    changesView,
    vscode.window.registerWebviewViewProvider(
      CommitBoxViewProvider.viewType,
      new CommitBoxViewProvider(context.extensionUri, workbench),
    ),
    vscode.window.registerWebviewViewProvider(
      SnipcodeDiffViewProvider.viewType,
      diffView,
    ),
  );
  workbench.registerCommands(context);
  void workbench.refresh();
```

- [ ] **Step 5: `package.json` —— 加 view、command、menu**

Modify `package.json`：

(a) `contributes.views.snipcode-git`（~line 271）加第三個 view（放在 `snipcode.commitBox` 之後）：

```json
    "views": {
      "snipcode-git": [
        {
          "id": "snipcode.changes",
          "name": "Changes"
        },
        {
          "id": "snipcode.commitBox",
          "name": "Commit",
          "type": "webview"
        },
        {
          "id": "snipcode.diff",
          "name": "Diff",
          "type": "webview"
        }
      ],
```

(b) `contributes.commands`（~line 259，`snipcode.git.filterRepos` 之後、`]` 之前）加 `showDiff`：

```json
      {
        "command": "snipcode.git.filterRepos",
        "title": "Snipcode Git: Filter Repos",
        "icon": "$(filter)"
      },
      {
        "command": "snipcode.git.showDiff",
        "title": "Snipcode Git: Show Diff"
      },
      {
        "command": "snipcode.git.openChange",
        "title": "Snipcode Git: Open in Editor",
        "icon": "$(go-to-file)"
      }
    ],
```

（`snipcode.git.openChange` command 之前只在 host `registerCommand`，`package.json` 沒有宣告；補上宣告才能掛 menu。）

(c) `contributes.menus."view/item/context"`（~line 465，file 節點那組附近）加一條把 `openChange` 掛成 file 節點的 inline 動作：

```json
        {
          "command": "snipcode.git.openChange",
          "when": "view == snipcode.changes && viewItem =~ /^file-/",
          "group": "inline@9"
        },
```

- [ ] **Step 6: 型別檢查（host）**

Run: `cd graph && npm run lint`
Expected: `tsc --noEmit` 無錯（確認 `DiffHunk`、`ChangeGroup`、`SnipcodeDiffViewProvider` 型別一致，`stageHunks`/`unstageHunks`/`fileDiff` 簽章對得上）。

- [ ] **Step 7: Full build（webview 三 bundle + host bundle + copy assets）**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`
Expected: build 成功；`dist/graph-webview/` 內同時有 `main.js`、`workbench.js`、`diff.js`（＋各 `.css`）；`dist/extension.js` 內含新的 provider 程式（可 `grep -c "SnipcodeDiffViewProvider" dist/extension.js` 確認 > 0）。

- [ ] **Step 8: 回歸 —— 既有 webview / backend 測試不得掛**

Run: `cd graph && npx vitest run --project webview && npx vitest run --project backend`
Expected: 既有 workbench store / commit-selected / staging 等測試全綠（判斷依 `Tests …` 文字）。

- [ ] **Step 9: 手動 F5 驗證（記錄於 PR）**

在 VS Code 按 F5 開 Extension Development Host，開啟一個有未提交變更的 repo：
1. 開 Snipcode Git 容器 → 應看到 Changes / Commit / **Diff** 三個 view。
2. 點 Unstaged 下的一個多 hunk 檔 → Diff 面板渲染該檔 diff，每個 hunk 有 checkbox（預設全勾）。
3. 取消勾一個 hunk → 按「Stage 選取」→ 只有勾選的 hunk 進 index（Changes 樹該檔同時出現在 Staged + Unstaged，MM）。
4. 點 Staged 下的該檔 → Diff 面板換成 staged 側；取消勾一部分 → 按「Unstage 選取」→ 只有選的 hunk 退回 working。
5. 用 `verify-webview-ui` skill 對 Diff 面板做一次渲染截圖驗證版面（Diff 面板不是空白）。

- [ ] **Step 10: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/src/tree/diff-view.ts graph/src/tree/changes-workbench.ts graph/src/tree/changes-tree.ts \
  graph/src/extension.ts package.json
git commit -m "feat(git): 加 Diff webview view —— 點檔案顯示 diff、逐 hunk stage/unstage 進真實 index"
```

---

## Self-Review

對照 brief 逐條檢查：

**1. Spec coverage（範圍 fence「做」的每一條）**
- Diff webview view（viewType `snipcode.diff`，第三個 view 進 `snipcode-git`）→ Task 3 Step 1/4/5。
- 點 Changes 樹檔案 → Diff 面板顯示 → Task 3 Step 2(b)(c)/3（`showInDiffView` + 樹 command 改指向）。
- 每 hunk checkbox + 全選/清空 → Task 2 Step 3（store）/6（元件）。
- Stage 選取 / Unstage 選取 → Task 2 Step 6 + Task 3 Step 1 的 `onDidReceiveMessage` 分流。
- host `stageHunks`/`unstageHunks`（複用 `buildForwardPatch` 雙向）→ Task 1 Step 3。
- stage/unstage 後刷新樹 + 重送 diff → Task 3 Step 2(c)（`refresh()` + `diffView.show`）。
- 新 `vite.diff` 單入口 + copy-assets → Task 2 Step 9/10/11。
- 測試策略：host 真 git 整合（Task 1）、webview store happy-dom（Task 2）、build/型別/回歸（Task 3 Step 6–8）、F5 手動 + verify-webview-ui（Task 3 Step 9）→ 全部覆蓋。

**2. Placeholder scan**
- 無 TBD/TODO；每個 code step 都是完整可跑碼（`stageHunks`/`unstageHunks`、`stagedFileDiffRaw`、store 全部 method、`Diff.svelte`、`vite.diff.config.ts`、provider `getHtml`、workbench 三 method 皆逐字給出）。
- 無「similar to Task N」—— 每處都重貼完整碼。
- 錯誤處理具體：`stageHunks`/`unstageHunks` 有 `no unstaged/staged changes` guard；provider `onDidReceiveMessage` try/catch + `error` 回送 + `showErrorMessage`；messaging 有 30s timeout 防 stuck。

**3. Type consistency**
- host→webview `hunks: DiffHunk[]`（`{header, lines:[{type,content,...}]}`）⊇ webview `DiffHunkView`（`{header, lines:[{type,content}]}`）—— 多帶的 `oldLineNumber`/`newLineNumber` 欄位 webview 忽略，postMessage 安全。
- `side: 'staged' | 'unstaged'` == `ChangeGroup`（`build-change-tree.ts`）== store `DiffSide`，三處一致。
- `FileNode.group` 直接當 `side` 傳（`showInDiffView`）—— 型別對齊。
- `stageHunks(repoPath,file,hunkIndices)`（workbench）→ `GitService.stageHunks(file,hunkIndices)`（Task 1）簽章一致；webview 回送 `hunkIndices: number[]`（`selectedIndices` 已攤平成 `number[]`）。
- 訊息 type 字串一致：`diffShow` / `diffStageHunks` / `error(source:'diffStageHunks')` 在 provider、messaging、Diff.svelte 三處相符。
- command id `snipcode.git.showDiff` 在 `registerCommands`、`changes-tree` command、`package.json` commands 三處一致。

**v2 明列延後項（不在本計畫）：** 逐行 line-level 選取（`lineIndices`）、Shiki 上色、stale 指紋防護（v1 host stage/unstage 時重取 raw，檔案期間變動則 hunk index 可能對不上）、changelist 命名分組、`copyAsClipCode` 改複製 diff、動態 repo 增減 re-wiring。

**實作者需在 F5 / 執行時確認的不確定點：**
1. **`git apply --cached --reverse` 對 staged diff 的行為**：本計畫斷言它等同 `git reset -p`（把選中 hunk 從 index 退回 working）。Task 1 的 `unstageHunks([0])` 整合測試會證明；若 git 版本對 `--reverse` 的 index 套用行為不同，測試會抓到。
2. **hunk index 對齊**：webview 讀的是 `getUncommittedFileDiff(file, side)` 的 hunks，host stage/unstage 重取的是 `workingFileDiffRaw`/`stagedFileDiffRaw`——兩者用**同一組 git diff 指令**（unstaged=`git diff -- file`、staged=`git diff --cached -- file`），故 `parseDiff` 順序與 `buildForwardPatch` 的 hunk 順序一致。前提是「兩次呼叫之間檔案沒變」（v1 已知限制）。
3. **WebviewView 與 vite 第三入口**：三個獨立單入口（graph/workbench/diff）是否真的各自 self-contained、`diff.js` 以 classic script 開得起來（不 timeout），需 F5 + `verify-webview-ui` 截圖確認；`copy-graph-assets.mjs` 的 readdir 迴圈是否確實把 `diff.js`/`diff.css` 帶進 `dist/graph-webview`（Task 2 Step 12 已加守門）。
```
