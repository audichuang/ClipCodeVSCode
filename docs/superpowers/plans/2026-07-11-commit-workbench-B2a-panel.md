# Snipcode 提交工作台 B-2a：面板地基 + 多 repo 整檔提交 — 實作計畫

- 日期：2026-07-11
- 格式：superpowers writing-plans（bite-sized、每步完整程式碼、TDD 紅→綠→commit）
- 對應設計：`docs/superpowers/specs/2026-07-11-snipcode-git-workbench-and-blame-design.md`（Slice B / D2 / D3 最小 / D4）
- 前置：B-1 已交付 `GitService.commitSelected`、`GitService.getRepoOperationState`、`graph/src/services/mutation-coordinator.ts` 的 `runExclusive`。

---

## Goal

交付 Slice B 提交工作台的**可運作最小骨架**：一個常駐 Activity Bar 側欄（`WebviewViewProvider`），
能列出工作區內**所有 repo 的未提交變更**（分 repo 分組、每檔顯示變更類型與 hunk 數），
以**整檔 checkbox**勾選、共用單一 commit message，按 Commit 對每個有勾選的 repo 各下一次
`commitSelected`（每 repo 包在 `runExclusive` 內、per-repo 結果回報、部分失敗不重複提交成功 repo），
Amend 僅在勾選集中單一 repo 時可用，並在 index 非空／衝突中／detached 時以 banner 停用該 repo 的提交。

## Architecture

```
Activity Bar 容器 "Snipcode Git"
  └─ webview view  id: snipcode.commitWorkbench
        │  (root package.json 貢獻 viewsContainers + views[type=webview])
        ▼
CommitWorkbenchViewProvider  (graph/src/workbench/, vscode-aware)
  ├─ getHtml()：模仿 MainPanel 的 CSP/nonce/asset 連結，但指向 workbench.js/workbench.css
  ├─ 收 WorkbenchWebviewMessage：
  │     workbenchGetStatus → getWorkbenchStatus(repoPaths, makeService)  [純函式, 無 vscode]
  │     workbenchCommit     → commitAcrossRepos(deps, message, selections, opts)  [純函式, 注入 runExclusive/commitSelected]
  └─ 送 WorkbenchExtensionMessage：workbenchStatus / workbenchCommitResult
        ▲
        │ postMessage
        ▼
Workbench.svelte  (graph/webview-ui/src/workbench/, 第二 Vite 入口 workbench.ts)
  └─ workbenchStore（分組樹 + 整檔勾選 + 共用訊息框）→ RepoGroup / FileRow / CommitBox
```

共用地基（不重寫）：host `GitService`（`graph/src/git/git-service.ts`）、`RepoDiscoveryService`
（`graph/src/services/repo-discovery.ts`）、`runExclusive`（`graph/src/services/mutation-coordinator.ts`）。
新面板是**獨立 webview view**，與 Graph 的 `MainPanel`（WebviewPanel 編輯器分頁）並存、互不干涉。

## Tech Stack

- Host：TypeScript，esbuild bundle（CJS/Node）。`vscode` 為 external。
- Webview：Svelte 5 runes + Vite（ESM/browser），輸出 `graph/webview-ui/dist/`，由
  `scripts/copy-graph-assets.mjs` 複製到 `dist/graph-webview/`。
- 測試：vitest 兩專案 —
  - `backend`：`graph/src/**/*.test.ts`，node 環境，跑真 git（整合測試在 `src/git/__tests__/integration/`，30s timeout）。
  - `webview`：`graph/webview-ui/src/**/*.test.ts`，happy-dom。
- 測試指令：
  - backend：`cd graph && npx vitest run <path> --project backend`
  - webview：`cd graph && npx vitest run <path> --project webview`
  - host bundle / 資產打包驗證：repo 根 `npm run build`

## Global Constraints（每個 Task 都要守）

1. **`graph/src/git/` 與所有純邏輯模組不得 `import vscode`**。`getWorkbenchStatus`、`commitAcrossRepos`、
   `workbench-messages.ts` 全部 vscode-free，才能在 backend vitest 直接單元測試。vscode-aware 的只有
   `CommitWorkbenchViewProvider`（放 `graph/src/workbench/`，可 import vscode，等同 `panels/`）。
2. **新 message type 必須進 effects 分類，否則編譯失敗**。沿用 `message-bus.ts` 的
   `MESSAGE_EFFECTS` 慣例，但工作台有**自己一組** message 型別 —— 在
   `graph/src/workbench/workbench-messages.ts` 內建一個 `WORKBENCH_MESSAGE_EFFECTS: Record<WorkbenchWebviewMessage['type'], 'mutation' | 'read'>`
   窮舉紀錄；漏一個 type 就是 compile error（見 Task 1）。**不要**把工作台 message 塞進 MainPanel 的
   `WebviewMessage` union（那會誤觸 MainPanel 的 transaction gate；工作台自己用 `runExclusive` 序列化）。
3. **commit 訊息一律繁體中文、無任何 attribution / Co-Authored-By 行**（本專案 git commit 規範）。
4. **Vite 多入口 + copy-assets 要一起改，否則資產不會被打包**。新增第二入口後，`graph/webview-ui/dist/`
   必須同時產出 `main.js/main.css/workbench.js/workbench.css`；`copy-graph-assets.mjs` 需 fail-fast 斷言
   `workbench.js`/`workbench.css` 存在（見 Task 6）。
5. **Svelte 5 `$state` 是 reactive proxy，postMessage 前要 `$state.snapshot(...)` 或展開**，否則丟
   `DataCloneError`（AGENTS.md 已載明）。
6. **請求→回應要有 timeout / 對應 error 處理**：webview 送 `workbenchCommit` 後等 `workbenchCommitResult`，
   必須也能吃到 `{type:'error', source:'workbenchCommit'}` 並解除 loading（AGENTS.md 的 squash-stuck bug 家族）。
7. **git commit 前後 index 保持乾淨**（D1）：所有 host 提交流程委派給既有 `commitSelected`（已含 D1/D4 guard
   + 失敗 `reset` 清理），本計畫**不**自寫 apply/commit。

---

## Task 1 — 工作台 message 協定 + effects 分類（host, 純型別 + 窮舉紀錄）

### Files
- 新增 `graph/src/workbench/workbench-messages.ts`
- 新增 `graph/src/workbench/__tests__/workbench-messages.test.ts`

### Interfaces
- Produces：
  - `WorkbenchWebviewMessage`（webview→host discriminated union）
  - `WorkbenchExtensionMessage`（host→webview）
  - `WorkbenchStatus` / `RepoStatus` / `WorkbenchFileChange`（狀態模型，Task 2 產生、Task 7 消費）
  - `PerRepoSelection` / `RepoCommitResult`（Task 3 編排用）
  - `WORKBENCH_MESSAGE_EFFECTS: Record<WorkbenchWebviewMessage['type'], MessageEffect>`
- Consumes：無（純型別檔）。

### Steps

1. **(RED)** 先寫測試，鎖住「每個 webview message type 都有 effect 分類」這個唯一有 runtime 意義的不變量
   （型別窮舉由 TypeScript 保證，runtime 測試防止有人把 record 改成 `Partial`/漏 key）。

   建立 `graph/src/workbench/__tests__/workbench-messages.test.ts`：

   ```ts
   import { describe, it, expect } from 'vitest';
   import { WORKBENCH_MESSAGE_EFFECTS } from '../workbench-messages';

   describe('WORKBENCH_MESSAGE_EFFECTS', () => {
     it('classifies every webview message type', () => {
       // These are the only two message types B-2a defines webview→host. If a new
       // one is added without a classification, TS fails to compile the Record;
       // this test additionally guards against the record values drifting.
       expect(WORKBENCH_MESSAGE_EFFECTS.workbenchGetStatus).toBe('read');
       expect(WORKBENCH_MESSAGE_EFFECTS.workbenchCommit).toBe('mutation');
     });

     it('has no undefined effects', () => {
       for (const [type, effect] of Object.entries(WORKBENCH_MESSAGE_EFFECTS)) {
         expect(effect, `${type} must be classified`).toMatch(/^(mutation|read)$/);
       }
     });
   });
   ```

   跑（會紅，因為模組還不存在）：
   ```
   cd graph && npx vitest run src/workbench/__tests__/workbench-messages.test.ts --project backend
   ```

2. **(GREEN)** 建立 `graph/src/workbench/workbench-messages.ts`，完整內容：

   ```ts
   // Workbench-only message protocol. Kept SEPARATE from src/utils/message-bus.ts
   // so the commit workbench never rides MainPanel's transaction gate — it
   // serializes its own mutations through runExclusive (mutation-coordinator.ts).
   // No vscode import: this file is pure types + one const record, unit-testable.

   export type MessageEffect = 'mutation' | 'read';

   /** One changed file in a repo (D3 minimal: whole-file granularity in B-2a). */
   export interface WorkbenchFileChange {
     /** Repo-relative path (POSIX-style, as git reports it). */
     path: string;
     /** git status letter for the worktree side: M/A/D/R/U/N (N = nested repo). */
     changeType: string;
     /** Number of diff hunks (0 for non-hunkable: binary/submodule/nested/new-untracked-binary). */
     hunkCount: number;
     /** False → must be committed whole (binary/submodule/nested); no per-hunk in B-2a. */
     hunkable: boolean;
   }

   /** Per-repo group + commit-availability signals (D4 banner). */
   export interface RepoStatus {
     repoPath: string;
     repoName: string;
     files: WorkbenchFileChange[];
     /** clean | merge | rebase | cherry-pick | revert | bisect (getRepoOperationState). */
     operationState: string;
     /** True when the git index already has staged content (D1 → block commit). */
     indexDirty: boolean;
     /** True on detached HEAD (D4 → allow but warn). */
     detached: boolean;
     /**
      * Non-null → this repo's Commit is disabled; string is the user-facing reason
      * (index 非空 / in-progress op). Detached is a WARNING, not a block, so it does
      * NOT set this field. Computed host-side in Task 2 so the webview stays dumb.
      */
     commitDisabledReason: string | null;
   }

   export interface WorkbenchStatus {
     repos: RepoStatus[];
   }

   /** A repo's selection sent by the webview at Commit time (whole-file only). */
   export interface PerRepoSelection {
     repoPath: string;
     /** Files the user checked, each with the hunk count so host expands to [0..n-1]. */
     files: Array<{ path: string; hunkCount: number }>;
   }

   /** Per-repo commit outcome returned to the webview (D-Slice B partial-failure). */
   export interface RepoCommitResult {
     repoPath: string;
     ok: boolean;
     newHead?: string;
     error?: string;
   }

   // --- Webview → Host -------------------------------------------------------
   export type WorkbenchWebviewMessage =
     | { type: 'workbenchGetStatus' }
     | {
         type: 'workbenchCommit';
         payload: {
           message: string;
           amend: boolean;
           repos: PerRepoSelection[];
         };
       };

   // --- Host → Webview -------------------------------------------------------
   export type WorkbenchExtensionMessage =
     | { type: 'workbenchStatus'; payload: WorkbenchStatus }
     | { type: 'workbenchCommitResult'; payload: { results: RepoCommitResult[] } }
     | { type: 'error'; payload: { message: string; source?: string } };

   /**
    * Exhaustive by construction: adding a WorkbenchWebviewMessage type without a
    * classification here is a COMPILE error (Record over the union's 'type').
    * 'mutation' handlers wrap their git work in runExclusive; 'read' don't.
    */
   export const WORKBENCH_MESSAGE_EFFECTS: Record<WorkbenchWebviewMessage['type'], MessageEffect> = {
     workbenchGetStatus: 'read',
     workbenchCommit: 'mutation',
   };
   ```

   跑到綠：
   ```
   cd graph && npx vitest run src/workbench/__tests__/workbench-messages.test.ts --project backend
   ```

3. **(COMMIT)** `feat(workbench): 新增提交工作台 message 協定與 effects 分類`

---

## Task 2 — `getWorkbenchStatus`（host, 純函式, 真 git 整合測試）

### Files
- 新增 `graph/src/workbench/workbench-status.ts`
- 新增 `graph/src/workbench/__tests__/workbench-status.integration.test.ts`

### Interfaces
- Consumes：
  - `GitService`（`../git/git-service`）— 用到 `getUncommittedDiff()`、`getUncommittedFileDiff(file, staged)`、
    `getRepoOperationState()`、`branches()`。既有簽章（已核對）：
    - `getUncommittedDiff(): Promise<{ staged: {path;status}[]; unstaged: {path;status}[] }>`
    - `getUncommittedFileDiff(file: string, staged: boolean): Promise<DiffData | null>`（`DiffData.hunks: DiffHunk[]`、`DiffData.isBinary: boolean`）
    - `getRepoOperationState(): Promise<'clean'|'merge'|'rebase'|'cherry-pick'|'revert'|'bisect'>`
    - `branches(): Promise<BranchInfo[]>`（`BranchInfo.current`、`BranchInfo.detached?`）
  - `WorkbenchStatus` / `RepoStatus` / `WorkbenchFileChange`（Task 1）
- Produces：`getWorkbenchStatus(repoPaths, makeService?): Promise<WorkbenchStatus>`
  - `makeService` 注入點讓測試可換假 GitService；預設 `new GitService(p)`。

### 設計備註（守 scope）
- D1 前提下 index 乾淨，變更全在 `unstaged`；但為了偵測「index 非空」banner，**直接看 `getUncommittedDiff().staged.length`**
  —— 不需要新增 GitService 方法（`staged` 本來就回傳）。
- hunk 數：對每個 tracked 檔 `getUncommittedFileDiff(path, false)` → `diff.hunks.length`。`diff` 為
  `null` 或 `isBinary` → `hunkable=false, hunkCount=0`（整檔處理）。nested repo（status `N`）同樣不可逐 hunk。
- detached：`branches()` 找 `current?.detached`。
- **完整 porcelain v2 結構化 status、rename old/new、submodule 能力矩陣**留 B-2b（見結尾）。B-2a 只到
  「分 repo + 檔清單 + 變更類型 + hunk 數 + hunkable 布林」。

### Steps

1. **(RED)** 建立整合測試 `graph/src/workbench/__tests__/workbench-status.integration.test.ts`
   （用 `src/git/__tests__/integration/helpers.ts` 的真 git repo 工具）：

   ```ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { getWorkbenchStatus } from '../workbench-status';
   import { TempRepo, commit, createTempRepo, runGit, writeFile } from '../../git/__tests__/integration/helpers';

   const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n';
   const CHANGED = 'a\nb2\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn2\no\np\n'; // two far-apart edits → 2 hunks

   describe('getWorkbenchStatus (integration)', () => {
     let repoA: TempRepo;
     let repoB: TempRepo;
     beforeEach(() => {
       repoA = createTempRepo();
       repoB = createTempRepo();
       commit(repoA.path, 'base', { 'f.txt': BASE });
       commit(repoB.path, 'base', { 'g.txt': 'x\n' });
     });
     afterEach(() => { repoA.cleanup(); repoB.cleanup(); });

     it('groups changes per repo with hunk counts and change types', async () => {
       writeFile(repoA.path, 'f.txt', CHANGED);       // modified, 2 hunks
       writeFile(repoA.path, 'new.txt', 'hello\n');   // untracked new file
       // repoB: no changes

       const status = await getWorkbenchStatus([repoA.path, repoB.path]);

       const a = status.repos.find(r => r.repoPath === repoA.path)!;
       expect(a.files.map(f => f.path).sort()).toEqual(['f.txt', 'new.txt']);
       const f = a.files.find(x => x.path === 'f.txt')!;
       expect(f.changeType).toBe('M');
       expect(f.hunkCount).toBe(2);
       expect(f.hunkable).toBe(true);
       const n = a.files.find(x => x.path === 'new.txt')!;
       expect(n.hunkCount).toBe(1);   // whole new file = one hunk

       const b = status.repos.find(r => r.repoPath === repoB.path)!;
       expect(b.files).toEqual([]);
     });

     it('flags a dirty index and disables commit (D1)', async () => {
       writeFile(repoA.path, 'f.txt', CHANGED);
       writeFile(repoA.path, 'staged.txt', 'pre\n');
       runGit(repoA.path, ['add', 'staged.txt']);

       const status = await getWorkbenchStatus([repoA.path]);
       const a = status.repos[0];
       expect(a.indexDirty).toBe(true);
       expect(a.commitDisabledReason).toBeTruthy();
     });

     it('flags an in-progress operation and disables commit (D4)', async () => {
       // Park a merge conflict so MERGE_HEAD exists.
       runGit(repoA.path, ['checkout', '-b', 'l']);
       writeFile(repoA.path, 'f.txt', 'left\n'); runGit(repoA.path, ['commit', '-am', 'l']);
       runGit(repoA.path, ['checkout', 'main']);
       writeFile(repoA.path, 'f.txt', 'right\n'); runGit(repoA.path, ['commit', '-am', 'r']);
       expect(() => runGit(repoA.path, ['merge', 'l'])).toThrow();

       const status = await getWorkbenchStatus([repoA.path]);
       expect(status.repos[0].operationState).toBe('merge');
       expect(status.repos[0].commitDisabledReason).toContain('merge');
     });
   });
   ```

   跑（紅）：
   ```
   cd graph && npx vitest run src/workbench/__tests__/workbench-status.integration.test.ts --project backend
   ```

2. **(GREEN)** 建立 `graph/src/workbench/workbench-status.ts`：

   ```ts
   import * as path from 'path';
   import { GitService } from '../git/git-service';
   import type { WorkbenchStatus, RepoStatus, WorkbenchFileChange } from './workbench-messages';

   type ServiceFactory = (repoPath: string) => GitService;

   /**
    * Build the per-repo change model the workbench renders (D3 minimal).
    * Pure/vscode-free: repo discovery happens in the provider (Task 5), which
    * passes the resolved repo paths in. `makeService` is injectable for tests.
    *
    * Each repo is fetched independently and a failure in one repo degrades to an
    * empty file list for that repo rather than failing the whole panel.
    */
   export async function getWorkbenchStatus(
     repoPaths: string[],
     makeService: ServiceFactory = (p) => new GitService(p),
   ): Promise<WorkbenchStatus> {
     const repos = await Promise.all(repoPaths.map((repoPath) => repoStatus(repoPath, makeService)));
     return { repos };
   }

   async function repoStatus(repoPath: string, makeService: ServiceFactory): Promise<RepoStatus> {
     const svc = makeService(repoPath);
     const base: RepoStatus = {
       repoPath,
       repoName: path.basename(repoPath),
       files: [],
       operationState: 'clean',
       indexDirty: false,
       detached: false,
       commitDisabledReason: null,
     };

     try {
       const [diff, operationState, branches] = await Promise.all([
         svc.getUncommittedDiff(),
         svc.getRepoOperationState(),
         svc.branches().catch(() => []),
       ]);

       base.operationState = operationState;
       base.indexDirty = diff.staged.length > 0;              // D1: any staged content
       base.detached = branches.find((b) => b.current)?.detached === true;

       // Hunk counts per unstaged file (index is expected clean under D1; we still
       // read the worktree side only). Non-hunkable types → whole-file.
       base.files = await Promise.all(
         diff.unstaged.map((entry) => fileChange(svc, entry)),
       );

       base.commitDisabledReason = disabledReason(base);
     } catch {
       // Whole-repo status failed (e.g. transient git error): show it as an empty,
       // commit-disabled group rather than dropping the repo silently.
       base.commitDisabledReason = 'status unavailable';
     }
     return base;
   }

   async function fileChange(
     svc: GitService,
     entry: { path: string; status: string },
   ): Promise<WorkbenchFileChange> {
     // Nested repos (status 'N') are never per-hunk stageable.
     if (entry.status === 'N') {
       return { path: entry.path, changeType: entry.status, hunkCount: 0, hunkable: false };
     }
     const diff = await svc.getUncommittedFileDiff(entry.path, false).catch(() => null);
     if (!diff || diff.isBinary) {
       return { path: entry.path, changeType: entry.status, hunkCount: 0, hunkable: false };
     }
     return {
       path: entry.path,
       changeType: entry.status,
       hunkCount: diff.hunks.length,
       hunkable: true,
     };
   }

   /** D1/D4: index non-empty or an in-progress op blocks commit; detached only warns. */
   function disabledReason(s: RepoStatus): string | null {
     if (s.indexDirty) {
       return '此 repo 已有預先暫存的變更，請先在原生 SCM 提交或重置後再用此面板';
     }
     if (s.operationState !== 'clean') {
       return `此 repo 有進行中的 ${s.operationState}，請先完成或中止`;
     }
     return null;
   }
   ```

   跑到綠：
   ```
   cd graph && npx vitest run src/workbench/__tests__/workbench-status.integration.test.ts --project backend
   ```

3. **(COMMIT)** `feat(workbench): 新增 getWorkbenchStatus 多 repo 變更彙整`

---

## Task 3 — `commitAcrossRepos` 編排器（host, 純函式, 注入依賴, 單元測試部分失敗）

### Files
- 新增 `graph/src/workbench/commit-across-repos.ts`
- 新增 `graph/src/workbench/__tests__/commit-across-repos.test.ts`

### Interfaces
- Produces：
  ```ts
  interface CommitAcrossReposDeps {
    runExclusive: <T>(repoPath: string, fn: () => Promise<T>) => Promise<T>;
    commitSelected: (
      repoPath: string,
      message: string,
      files: Array<{ path: string; hunkIndices: number[] }>,
      opts?: { amend?: boolean },
    ) => Promise<string>;
  }
  function commitAcrossRepos(
    deps: CommitAcrossReposDeps,
    message: string,
    selections: PerRepoSelection[],
    opts?: { amend?: boolean },
  ): Promise<RepoCommitResult[]>;
  ```
- Consumes：`PerRepoSelection` / `RepoCommitResult`（Task 1）。**不 import GitService、不 import runExclusive
  的實體** —— 全部靠注入，才能純單元測試「一 repo 失敗、其餘成功、不重複提交」。

### 設計備註
- 對每個有勾選的 repo：`deps.runExclusive(repoPath, () => deps.commitSelected(repoPath, message, files, opts))`。
- 整檔 = 該檔全部 hunk：`hunkIndices = [0..hunkCount-1]`（`hunkCount` 由 webview 依 status 帶入）。
- 每 repo 各自 try/catch → `{repoPath, ok, newHead?}` 或 `{repoPath, ok:false, error}`。**一 repo 失敗不影響其他 repo**
  （git 無跨 repo atomic；設計 §錯誤處理已明示 N 個獨立 commit）。
- provider 收到結果後：成功 repo 清 selection、失敗 repo 保留 selection 與訊息框（Task 5/7）。

### Steps

1. **(RED)** 建立 `graph/src/workbench/__tests__/commit-across-repos.test.ts`：

   ```ts
   import { describe, it, expect, vi } from 'vitest';
   import { commitAcrossRepos } from '../commit-across-repos';

   // Real serialization semantics without the git layer: same as mutation-coordinator
   // but inline so the test asserts ordering deterministically.
   const passthroughExclusive = <T>(_repo: string, fn: () => Promise<T>) => fn();

   describe('commitAcrossRepos', () => {
     it('commits every selected repo and returns per-repo new heads', async () => {
       const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
       const results = await commitAcrossRepos(
         { runExclusive: passthroughExclusive, commitSelected },
         '修正手續費計算',
         [
           { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 2 }] },
           { repoPath: '/b', files: [{ path: 'y.ts', hunkCount: 1 }] },
         ],
       );
       expect(results).toEqual([
         { repoPath: '/a', ok: true, newHead: 'head-/a' },
         { repoPath: '/b', ok: true, newHead: 'head-/b' },
       ]);
       // Whole-file expansion: hunkCount 2 → [0,1]; 1 → [0].
       expect(commitSelected).toHaveBeenCalledWith('/a', '修正手續費計算', [{ path: 'x.ts', hunkIndices: [0, 1] }], undefined);
       expect(commitSelected).toHaveBeenCalledWith('/b', '修正手續費計算', [{ path: 'y.ts', hunkIndices: [0] }], undefined);
     });

     it('reports a per-repo failure without failing or re-committing the others', async () => {
       const commitSelected = vi.fn(async (repo: string) => {
         if (repo === '/b') throw new Error('pre-commit hook failed');
         return `head-${repo}`;
       });
       const results = await commitAcrossRepos(
         { runExclusive: passthroughExclusive, commitSelected },
         'msg',
         [
           { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 1 }] },
           { repoPath: '/b', files: [{ path: 'y.ts', hunkCount: 1 }] },
         ],
       );
       expect(results).toEqual([
         { repoPath: '/a', ok: true, newHead: 'head-/a' },
         { repoPath: '/b', ok: false, error: 'pre-commit hook failed' },
       ]);
       // /a committed exactly once — a retry must not double-commit it.
       expect(commitSelected).toHaveBeenCalledTimes(2);
     });

     it('wraps each repo commit in runExclusive keyed by repo path', async () => {
       const runExclusive = vi.fn(<T>(_repo: string, fn: () => Promise<T>) => fn());
       const commitSelected = vi.fn(async (repo: string) => `head-${repo}`);
       await commitAcrossRepos({ runExclusive, commitSelected }, 'm', [
         { repoPath: '/a', files: [{ path: 'x', hunkCount: 1 }] },
       ]);
       expect(runExclusive).toHaveBeenCalledWith('/a', expect.any(Function));
     });

     it('passes amend through to commitSelected', async () => {
       const commitSelected = vi.fn(async () => 'h');
       await commitAcrossRepos({ runExclusive: passthroughExclusive, commitSelected }, 'm',
         [{ repoPath: '/a', files: [{ path: 'x', hunkCount: 1 }] }], { amend: true });
       expect(commitSelected).toHaveBeenCalledWith('/a', 'm', [{ path: 'x', hunkIndices: [0] }], { amend: true });
     });
   });
   ```

   跑（紅）：
   ```
   cd graph && npx vitest run src/workbench/__tests__/commit-across-repos.test.ts --project backend
   ```

2. **(GREEN)** 建立 `graph/src/workbench/commit-across-repos.ts`：

   ```ts
   import type { PerRepoSelection, RepoCommitResult } from './workbench-messages';

   export interface CommitAcrossReposDeps {
     /** Serialize per repo path against Graph/other-panel mutations (D2). */
     runExclusive: <T>(repoPath: string, fn: () => Promise<T>) => Promise<T>;
     /** GitService.commitSelected bound to a repo path (provider injects the real one). */
     commitSelected: (
       repoPath: string,
       message: string,
       files: Array<{ path: string; hunkIndices: number[] }>,
       opts?: { amend?: boolean },
     ) => Promise<string>;
   }

   /**
    * Commit the checked files in each selected repo as N independent commits
    * sharing one message. git cannot make one commit span repos, so there is NO
    * cross-repo atomic rollback: each repo succeeds or fails on its own, and the
    * caller keeps the selection for failed repos (so a retry never double-commits
    * an already-successful repo). Whole-file selection expands to all hunks.
    */
   export async function commitAcrossRepos(
     deps: CommitAcrossReposDeps,
     message: string,
     selections: PerRepoSelection[],
     opts?: { amend?: boolean },
   ): Promise<RepoCommitResult[]> {
     const results: RepoCommitResult[] = [];
     for (const sel of selections) {
       const files = sel.files.map((f) => ({
         path: f.path,
         hunkIndices: wholeFileHunks(f.hunkCount),
       }));
       try {
         const newHead = await deps.runExclusive(sel.repoPath, () =>
           deps.commitSelected(sel.repoPath, message, files, opts),
         );
         results.push({ repoPath: sel.repoPath, ok: true, newHead });
       } catch (err) {
         results.push({ repoPath: sel.repoPath, ok: false, error: errText(err) });
       }
     }
     return results;
   }

   /** [0..n-1]; a non-hunkable/whole file always reports hunkCount 1 (Task 2). */
   function wholeFileHunks(hunkCount: number): number[] {
     const n = Math.max(1, hunkCount);
     return Array.from({ length: n }, (_, i) => i);
   }

   function errText(err: unknown): string {
     return err instanceof Error ? err.message : String(err);
   }
   ```

   > 註：`commitSelected` 的 deps 簽章帶 `repoPath` 首參，是因為 host 的 `GitService.commitSelected(message, files, opts)`
   > 綁定單一 repo 實例。provider（Task 5）會用 `(repoPath, msg, files, opts) => makeService(repoPath).commitSelected(msg, files, opts)`
   > 這個 adapter 注入。純測試則直接用 `vi.fn`，不碰 git。

   跑到綠：
   ```
   cd graph && npx vitest run src/workbench/__tests__/commit-across-repos.test.ts --project backend
   ```

3. **(COMMIT)** `feat(workbench): 新增 commitAcrossRepos 多 repo 提交編排（per-repo 部分失敗）`

---

## Task 4 — `GitService.commitSelected` 支援 amend（host, 擴充 B-1 簽章, 整合測試）

> **偏差警告（實作者需確認）**：B-1 交付的 `commitSelected(message, files)` 沒有 amend 參數。B-2a 的 Amend 按鈕
> 需要它。最小且正確的做法是**在既有交易流程內把 `commit -m` 換成 `commit --amend -m`**，重用同一套 D1/D4 guard
> 與失敗 `reset` 清理，不另寫 apply/commit。若 B-1 的擁有者不希望改動該方法簽章，替代方案是另加
> `amendSelected(message, files)` 複製流程 —— 但那是重複程式碼，故本計畫採「加一個可選 `opts.amend`」。

### Files
- 修改 `graph/src/git/git-service.ts`（`commitSelected` 簽章 + commit 指令分支）
- 修改 `graph/src/git/__tests__/integration/commit-selected.integration.test.ts`（加 amend 案例）

### Interfaces
- 由：`commitSelected(message: string, files: Array<{path; hunkIndices}>): Promise<string>`
- 變成：`commitSelected(message: string, files: Array<{path; hunkIndices}>, opts?: { amend?: boolean }): Promise<string>`
  （`opts` optional → 既有所有呼叫端與測試不受影響，Global Constraint 相容）。

### Steps

1. **(RED)** 在 `commit-selected.integration.test.ts` 末尾（`describe` 內）加：

   ```ts
   it('amends HEAD with the selected hunk instead of creating a new commit', async () => {
     const parentBefore = runGit(repo.path, ['rev-parse', 'HEAD~1']).catch?.(() => '') ?? '';
     const before = head(repo.path);
     const beforeCount = runGit(repo.path, ['rev-list', '--count', 'HEAD']).trim();

     const newHash = await svc.commitSelected('修訂：併入第一個 hunk', [{ path: 'f.txt', hunkIndices: [0] }], { amend: true });

     // Amend replaces HEAD → new SHA, but commit COUNT is unchanged (no new commit).
     expect(newHash).not.toBe(before);
     expect(newHash).toBe(head(repo.path));
     expect(runGit(repo.path, ['rev-list', '--count', 'HEAD']).trim()).toBe(beforeCount);

     // The amended tree carries hunk 0 (beta2), hunk 1 (xi) still uncommitted.
     const committed = runGit(repo.path, ['show', 'HEAD:f.txt']);
     expect(committed).toContain('\nbeta2\n');
     expect(committed).toContain('\nxi\n');
     expect(runGit(repo.path, ['status', '--porcelain', 'f.txt']).trim()).toBe('M f.txt');
     expect(() => runGit(repo.path, ['diff', '--cached', '--quiet'])).not.toThrow();
   });
   ```

   > 註：`beforeEach` 只建了一個 `base` commit，`HEAD~1` 不存在也沒關係——上面不依賴 `parentBefore`；
   > 若要更嚴謹，可在 `beforeEach` 前多 `commit(repo.path, 'root', {...})` 一次讓 HEAD 有 parent。實作者
   > 視需要調整；核心斷言是「commit count 不變 + tree 併入 hunk 0」。

   跑（紅）：
   ```
   cd graph && npx vitest run src/git/__tests__/integration/commit-selected.integration.test.ts --project backend
   ```

2. **(GREEN)** 修改 `git-service.ts` 的 `commitSelected`。簽章與 commit 分支：

   ```ts
   async commitSelected(
     message: string,
     files: Array<{ path: string; hunkIndices: number[] }>,
     opts?: { amend?: boolean },
   ): Promise<string> {
     return this.withMutationLock(async () => {
       // ... (D4 op-state guard, unmerged guard, D1 clean-index guard: UNCHANGED) ...

       try {
         for (const { path, hunkIndices } of files) {
           const raw = await this.workingFileDiffRaw(path);
           if (!raw.trim()) {
             throw new Error(`no working-tree changes to stage for ${path}`);
           }
           const patch = buildForwardPatch(raw, hunkIndices);
           await this.execUnlocked(['apply', '--cached'], { stdin: patch });
         }
         // Amend folds the freshly-staged hunks into HEAD (no new commit); a plain
         // commit creates one. Both use -m with the shared workbench message.
         const commitArgs = opts?.amend
           ? ['commit', '--amend', '-m', message]
           : ['commit', '-m', message];
         await this.execUnlocked(commitArgs);
       } catch (err) {
         await this.execUnlocked(['reset', '--quiet']).catch(() => { /* best-effort cleanup */ });
         throw err;
       }

       return (await this.exec(['rev-parse', 'HEAD'])).trim();
     });
   }
   ```

   （只動簽章那行與 commit 指令那兩行；D1/D4 guard 與 catch/reset 保持原樣。）

   跑到綠：
   ```
   cd graph && npx vitest run src/git/__tests__/integration/commit-selected.integration.test.ts --project backend
   ```

3. **(COMMIT)** `feat(git-service): commitSelected 支援 amend 選項`

---

## Task 5 — `CommitWorkbenchViewProvider` + package.json 貢獻 + 註冊（host, vscode-aware, 編譯驗證）

### Files
- 新增 `graph/src/workbench/CommitWorkbenchViewProvider.ts`
- 修改 `package.json`（**repo 根**，即 `/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/package.json`）：
  `contributes.viewsContainers.activitybar` + `contributes.views["snipcode.commitWorkbench-container"]`
- 修改 `graph/src/extension.ts`（在 `activate()` 的 workspaceFolder 分支註冊 provider）

### Interfaces
- Consumes：
  - `WorkbenchWebviewMessage` / `WorkbenchExtensionMessage`（Task 1）
  - `getWorkbenchStatus`（Task 2）
  - `commitAcrossRepos`（Task 3）
  - `runExclusive`（`../services/mutation-coordinator`）
  - `GitService`（`../git/git-service`）— 提供 `commitSelected` adapter
  - `RepoDiscoveryService`（`../services/repo-discovery`）— `discoverRepos(folderPaths)`
  - `MainPanel.assetRootUri`（`../panels/MainPanel`）— host 注入的資產目錄（activateGraph 已在 activate 前設好）
- Produces：`class CommitWorkbenchViewProvider implements vscode.WebviewViewProvider`，含 static `viewType = 'snipcode.commitWorkbench'`。

### Steps

1. **(package.json 貢獻)** 在 `contributes` 內新增 view container 與 webview view。緊接既有
   `contributes.views` 物件之外（同層）加 `viewsContainers`，並在 `views` 物件內加一個新 container key：

   ```jsonc
   // contributes.viewsContainers（若不存在則新增此整段）
   "viewsContainers": {
     "activitybar": [
       {
         "id": "snipcode.commitWorkbench-container",
         "title": "Snipcode Git",
         "icon": "resources/icon-dark.svg"
       }
     ]
   },
   // contributes.views 內新增一個 key（與既有 "scm" 同層）
   "views": {
     "scm": [ /* ...既有不動... */ ],
     "snipcode.commitWorkbench-container": [
       {
         "id": "snipcode.commitWorkbench",
         "name": "Commit Workbench",
         "type": "webview"
       }
     ]
   }
   ```

   > 驗證點（實作者必查）：`icon` 路徑 `resources/icon-dark.svg` 需存在於 host 根（graph 有
   > `resources/icon-dark.svg`，但 host 根是否有同名檔要確認；沒有就改指向存在的 svg 或用 codicon）。
   > view `id` 必須與 `CommitWorkbenchViewProvider.viewType` 字串完全一致。

2. **(provider 程式碼)** 建立 `graph/src/workbench/CommitWorkbenchViewProvider.ts`：

   ```ts
   import * as vscode from 'vscode';
   import { GitService } from '../git/git-service';
   import { RepoDiscoveryService } from '../services/repo-discovery';
   import { runExclusive } from '../services/mutation-coordinator';
   import { MainPanel } from '../panels/MainPanel';
   import { getWorkbenchStatus } from './workbench-status';
   import { commitAcrossRepos } from './commit-across-repos';
   import type { WorkbenchWebviewMessage, WorkbenchExtensionMessage } from './workbench-messages';

   /**
    * Persistent Activity Bar side panel (its own WebviewView, NOT MainPanel's
    * editor-tab WebviewPanel). Mirrors MainPanel's CSP/nonce/asset resolution but
    * loads the workbench.* bundle. Mutations serialize through runExclusive
    * (per-repo, D2), independent of MainPanel's transaction gate.
    */
   export class CommitWorkbenchViewProvider implements vscode.WebviewViewProvider {
     public static readonly viewType = 'snipcode.commitWorkbench';

     private view: vscode.WebviewView | undefined;
     private refreshTimer: ReturnType<typeof setTimeout> | undefined;

     constructor(private readonly extensionUri: vscode.Uri) {}

     resolveWebviewView(view: vscode.WebviewView): void {
       this.view = view;
       const assetRoot = MainPanel.assetRootUri
         ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
       view.webview.options = {
         enableScripts: true,
         localResourceRoots: [assetRoot],
       };
       view.webview.onDidReceiveMessage((m: WorkbenchWebviewMessage) => this.onMessage(m));
       view.onDidDispose(() => { this.view = undefined; });
       view.webview.html = this.getHtml(view.webview, assetRoot);
       // First paint pushes status; the webview also asks on boot (Task 8).
       void this.refresh();
     }

     /** Debounced re-status; call from a file/HEAD watcher (Task 5 step 4). */
     scheduleRefresh(): void {
       if (this.refreshTimer) clearTimeout(this.refreshTimer);
       this.refreshTimer = setTimeout(() => void this.refresh(), 300);
     }

     private async onMessage(m: WorkbenchWebviewMessage): Promise<void> {
       switch (m.type) {
         case 'workbenchGetStatus':
           await this.refresh();
           return;
         case 'workbenchCommit': {
           try {
             const results = await commitAcrossRepos(
               {
                 runExclusive,
                 commitSelected: (repoPath, message, files, opts) =>
                   new GitService(repoPath).commitSelected(message, files, opts),
               },
               m.payload.message,
               m.payload.repos,
               { amend: m.payload.amend },
             );
             this.post({ type: 'workbenchCommitResult', payload: { results } });
           } catch (err) {
             // Whole-batch failure (should be rare — per-repo errors are caught
             // inside commitAcrossRepos). Surface via error so the webview clears
             // its loading state (Global Constraint 6).
             this.post({ type: 'error', payload: { message: errText(err), source: 'workbenchCommit' } });
           }
           // Status changes after any commit — push a fresh tree so successful
           // repos drop their committed files.
           await this.refresh();
           return;
         }
       }
     }

     private async refresh(): Promise<void> {
       if (!this.view) return;
       const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
       const repos = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
       const status = await getWorkbenchStatus(repos.map((r) => r.path));
       this.post({ type: 'workbenchStatus', payload: status });
     }

     private post(msg: WorkbenchExtensionMessage): void {
       this.view?.webview.postMessage(msg);
     }

     private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
       const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.js'));
       const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.css'));
       const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
       const nonce = getNonce();
       return `<!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8">
     <meta name="viewport" content="width=device-width, initial-scale=1.0">
     <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
     <link rel="stylesheet" href="${codiconUri}">
     <link rel="stylesheet" href="${styleUri}">
     <title>Snipcode Commit Workbench</title>
   </head>
   <body>
     <div id="workbench-app"></div>
     <script nonce="${nonce}" src="${scriptUri}"></script>
   </body>
   </html>`;
     }
   }

   function getNonce(): string {
     let text = '';
     const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
     for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
     return text;
   }

   function errText(err: unknown): string {
     return err instanceof Error ? err.message : String(err);
   }
   ```

   > 為何自己複製 `getNonce`：`MainPanel.ts` 的 `getNonce` 是 module-local function（非 export）。複製 8 行比
   > 為它加 export 面更小、對 vendored 檔改動更少。若日後想共用可抽 `utils/nonce.ts`，B-2a 不做。

3. **(註冊)** 在 `graph/src/extension.ts` 的 `activate()` 內、workspaceFolder 分支（tree view providers 附近）
   註冊 provider。加入 import 與註冊：

   ```ts
   // 檔頭 import 區
   import { CommitWorkbenchViewProvider } from './workbench/CommitWorkbenchViewProvider';

   // activate() 內，有 workspaceFolder 之後、tree views 附近：
   const workbenchProvider = new CommitWorkbenchViewProvider(context.extensionUri);
   context.subscriptions.push(
     vscode.window.registerWebviewViewProvider(
       CommitWorkbenchViewProvider.viewType,
       workbenchProvider,
       { webviewOptions: { retainContextWhenHidden: true } },
     ),
   );
   ```

4. **(debounce 刷新, scope 6)** 最小做法：複用既有 `FileWatcher`（`services/file-watcher.ts`，建構子
   `new FileWatcher(repoPath, cb)`）——對每個探索到的 repo 建一個 watcher，callback 呼叫
   `workbenchProvider.scheduleRefresh()`。B-2a 只需在 `refresh()` 首次探索完 repos 後，為每個 repo 建 watcher
   一次即可（不處理 repo 動態增減，留 B-2b）。

   ```ts
   // 在 activate() 內取得 repos 後（或在 provider.refresh 首次完成後）：
   // ponytail: one FileWatcher per discovered repo, all funnelled through the
   // provider's 300ms debounce. Dynamic repo add/remove re-wiring is B-2b.
   const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
   RepoDiscoveryService.discoverRepos(folders).then(repos => {
     for (const r of repos) {
       const w = new FileWatcher(r.path, () => workbenchProvider.scheduleRefresh());
       w.enabled = true;
       context.subscriptions.push(w);
     }
   }).catch(() => {});
   ```

   > 驗證點：`FileWatcher` 的 enable/建構語意以 `MainPanel.ts` 用法為準（`new FileWatcher(repoPath, cb)`
   > + `.enabled = true`）。實作者確認 `FileWatcher` 可 dispose 且能塞進 `context.subscriptions`。

5. **(驗證)** 本 Task 無單元測試（WebviewViewProvider / package.json 貢獻屬 vscode-bound，依測試策略以
   「編譯通過 + F5 手動」驗收，實際 F5 在 Task 8 尾端）。此步只需 host 編譯通過：
   ```
   cd graph && npm run lint          # tsc --noEmit 全綠
   ```
   （注意：`workbench.js/workbench.css` 尚未由 vite 產出，getHtml 連結會 404，但那要等 Task 6；本 Task 只保證型別/編譯。）

6. **(COMMIT)** `feat(workbench): 新增 CommitWorkbenchViewProvider 與 Activity Bar 貢獻`

---

## Task 6 — Vite 第二入口 + workbench.html/ts + copy-assets 斷言（webview build, 打包驗證）

### Files
- 修改 `graph/webview-ui/vite.config.ts`（多入口）
- 新增 `graph/webview-ui/workbench.html`
- 新增 `graph/webview-ui/src/workbench.ts`（暫時掛一個佔位節點，Task 8 換成真 Workbench.svelte）
- 修改 `scripts/copy-graph-assets.mjs`（fail-fast 斷言 workbench 資產）

### Interfaces
- Produces：`graph/webview-ui/dist/{main.js,main.css,workbench.js,workbench.css}`；經 copy-assets 後
  `dist/graph-webview/` 內同時有 workbench.js/workbench.css。
- Consumes：無新 host 型別。

### 設計備註（本計畫最高不確定處，實作者務必驗證輸出檔名）
- 現行 config 用 `rollupOptions.output.entryFileNames = 'main.js'`、`assetFileNames = 'main.css'`、
  `cssCodeSplit: false` —— 是**單入口硬編死檔名**。改多入口要：
  - `rollupOptions.input = { main: 'index.html', workbench: 'workbench.html' }`
  - `entryFileNames = '[name].js'`、`chunkFileNames = '[name].js'`、`assetFileNames = '[name][extname]'`
  - **`cssCodeSplit: true`**（讓每個入口各自產 CSS；`false` 會把兩入口 CSS 併成一支，workbench 會載到 graph 的 CSS）
- 風險：Vite 對「兩入口都 import 的共用模組」可能拆出 shared chunk、或 CSS 命名不完全等於 `main.css/workbench.css`。
  因此 **copy-assets 加硬斷言**：找不到 `workbench.js`/`workbench.css` 就 throw，讓打包在 CI/本地立刻爆而非默默漏檔。

### Steps

1. **(vite 多入口)** 覆寫 `graph/webview-ui/vite.config.ts`：

   ```ts
   import { defineConfig } from 'vite';
   import { svelte } from '@sveltejs/vite-plugin-svelte';
   import { resolve } from 'node:path';

   export default defineConfig({
     plugins: [svelte()],
     build: {
       outDir: 'dist',
       rollupOptions: {
         // Two pages → two entries. Each html pulls its own /src/*.ts entry.
         input: {
           main: resolve(__dirname, 'index.html'),
           workbench: resolve(__dirname, 'workbench.html'),
         },
         output: {
           // Deterministic, unhashed names so MainPanel.getHtmlForWebview and
           // CommitWorkbenchViewProvider.getHtml can hardcode main.*/workbench.*.
           entryFileNames: '[name].js',
           chunkFileNames: '[name].js',
           assetFileNames: '[name][extname]',
           manualChunks: undefined,
         },
       },
       // Per-entry CSS (main.css / workbench.css). Was false for the single-entry
       // build; MUST be true now or both entries share one merged stylesheet.
       cssCodeSplit: true,
       assetsInlineLimit: 100000,
       chunkSizeWarningLimit: 800,
     },
   });
   ```

2. **(workbench.html)** 新增 `graph/webview-ui/workbench.html`（對照 `index.html`，換 entry 與 mount 節點 id）：

   ```html
   <!DOCTYPE html>
   <html lang="en">
     <head>
       <meta charset="UTF-8" />
       <meta name="viewport" content="width=device-width, initial-scale=1.0" />
       <title>Snipcode Commit Workbench</title>
     </head>
     <body>
       <div id="workbench-app"></div>
       <script type="module" src="/src/workbench.ts"></script>
     </body>
   </html>
   ```

3. **(workbench.ts 佔位)** 新增 `graph/webview-ui/src/workbench.ts`（Task 8 會換成 mount 真元件；此步先讓 build
   有東西輸出並可手動確認掛載）：

   ```ts
   // Placeholder entry — Task 8 replaces this body with `mount(Workbench, …)`.
   const el = document.getElementById('workbench-app');
   if (el) el.textContent = 'Snipcode Commit Workbench (booting…)';
   ```

4. **(copy-assets 斷言)** 修改 `scripts/copy-graph-assets.mjs`，在既有「複製 viteDist 全部檔案」迴圈**之後**加
   fail-fast 檢查（既有迴圈已會複製 workbench.*，因為它照抄整個 dist 目錄；此斷言防止 vite 命名沒如預期）：

   ```js
   // After the existing `for (const name of await readdir(viteDist)) { ... }` loop:
   // The multi-entry vite build must emit BOTH bundles; a rename/split would let
   // the workbench view 404 silently. Fail the build instead.
   for (const required of ['main.js', 'main.css', 'workbench.js', 'workbench.css']) {
     if (!existsSync(path.join(outDir, required))) {
       throw new Error(
         `graph webview asset missing after copy: ${required} ` +
         `(vite multi-entry output changed? check webview-ui/vite.config.ts entryFileNames/cssCodeSplit)`,
       );
     }
   }
   ```

   （`existsSync` 與 `path` 已在檔案頂部 import，無需新增 import。）

5. **(驗證)** repo 根跑完整 build，確認四個資產都在，且斷言不 throw：
   ```
   npm run build
   ls dist/graph-webview/workbench.js dist/graph-webview/workbench.css dist/graph-webview/main.js dist/graph-webview/main.css
   ```
   > 若 build 因 CSS 命名不符 throw：依實際 vite 輸出檔名調整 `assetFileNames`（可能需
   > `assetFileNames: (info) => info.name?.endsWith('.css') ? '[name][extname]' : 'assets/[name][extname]'`
   > 之類），或改 getHtml/copy-assets 對齊實際檔名。**這是本計畫指定的 spike 驗證點。**

6. **(COMMIT)** `build(webview): vite 第二入口 workbench + copy-assets 斷言`

---

## Task 7 — Workbench Svelte store（webview, 分組/勾選/tri-state 狀態機, vitest webview）

### Files
- 新增 `graph/webview-ui/src/workbench/workbench-store.svelte.ts`
- 新增 `graph/webview-ui/src/workbench/__tests__/workbench-store.test.ts`

### Interfaces
- Consumes：`WorkbenchStatus` / `RepoStatus` / `WorkbenchFileChange` / `PerRepoSelection` 的**結構**
  （webview 不 import host 檔；就地宣告等價的 webview-side 型別，維持 adapter 邊界 thin，如同 message-bus 的
  `snipcodeCopyFullSource` inline-type 慣例）。
- Produces：`workbenchStore` 單例，含：
  - `setStatus(status)`：載入/刷新分組樹，**保留已勾選但仍存在的檔案**（成功提交後 host 會送新 status，消失的檔案自然移除勾選）。
  - `toggleFile(repoPath, path)`、`toggleRepo(repoPath)`（整 repo 全選/全消）、`toggleCollapse(repoPath)`
  - `repoTriState(repoPath): 'all' | 'some' | 'none'`（供 RepoGroup 勾選框顯示；B-2a 是「整檔」層級的 tri-state，非 hunk 層級）
  - `message`（`$state` 字串，共用單一訊息框）
  - `selections(): PerRepoSelection[]`（只含有勾選檔的 repo，供 Commit）
  - `canCommit`、`canAmend`（衍生：有勾選 + 至少一個未 disabled repo；amend 需勾選集中單一 repo）
  - `applyCommitResults(results)`：成功 repo 清其 selection、失敗 repo 保留（呼應設計 §跨 repo 部分失敗）

### 設計備註（守 scope）
- **勾選是純 webview 狀態**，不碰 git。B-2a 只有整檔勾選；hunk-level tri-state（部分 hunk）留 B-2b。
- `commitDisabledReason != null` 的 repo：其檔案在 UI 唯讀、不可勾（store `toggleFile` 對 disabled repo no-op）。

### Steps

1. **(RED)** 建立 `graph/webview-ui/src/workbench/__tests__/workbench-store.test.ts`：

   ```ts
   import { describe, it, expect, beforeEach } from 'vitest';
   import { workbenchStore, type WbStatus } from '../workbench-store.svelte';

   const status: WbStatus = {
     repos: [
       {
         repoPath: '/a', repoName: 'a', operationState: 'clean', indexDirty: false,
         detached: false, commitDisabledReason: null,
         files: [
           { path: 'x.ts', changeType: 'M', hunkCount: 2, hunkable: true },
           { path: 'y.ts', changeType: 'A', hunkCount: 1, hunkable: true },
         ],
       },
       {
         repoPath: '/b', repoName: 'b', operationState: 'merge', indexDirty: false,
         detached: false, commitDisabledReason: '此 repo 有進行中的 merge，請先完成或中止',
         files: [{ path: 'z.ts', changeType: 'M', hunkCount: 1, hunkable: true }],
       },
     ],
   };

   beforeEach(() => {
     workbenchStore.reset();
     workbenchStore.setStatus(status);
     workbenchStore.message = '';
   });

   describe('workbenchStore selection', () => {
     it('toggles a file and reflects tri-state on its repo', () => {
       expect(workbenchStore.repoTriState('/a')).toBe('none');
       workbenchStore.toggleFile('/a', 'x.ts');
       expect(workbenchStore.repoTriState('/a')).toBe('some');
       workbenchStore.toggleFile('/a', 'y.ts');
       expect(workbenchStore.repoTriState('/a')).toBe('all');
     });

     it('toggleRepo selects/deselects all files in a repo', () => {
       workbenchStore.toggleRepo('/a');
       expect(workbenchStore.repoTriState('/a')).toBe('all');
       workbenchStore.toggleRepo('/a');
       expect(workbenchStore.repoTriState('/a')).toBe('none');
     });

     it('ignores toggles on a commit-disabled repo', () => {
       workbenchStore.toggleFile('/b', 'z.ts');
       expect(workbenchStore.repoTriState('/b')).toBe('none');
     });

     it('selections() yields only checked repos with hunk counts', () => {
       workbenchStore.toggleFile('/a', 'x.ts');
       expect(workbenchStore.selections()).toEqual([
         { repoPath: '/a', files: [{ path: 'x.ts', hunkCount: 2 }] },
       ]);
     });

     it('canCommit requires a selection; canAmend requires a single repo', () => {
       expect(workbenchStore.canCommit).toBe(false);
       workbenchStore.toggleFile('/a', 'x.ts');
       expect(workbenchStore.canCommit).toBe(true);
       expect(workbenchStore.canAmend).toBe(true); // single repo /a
     });

     it('setStatus preserves an existing selection for files that still exist', () => {
       workbenchStore.toggleFile('/a', 'x.ts');
       workbenchStore.setStatus(status); // refresh with same files
       expect(workbenchStore.repoTriState('/a')).toBe('some');
     });

     it('applyCommitResults clears selection for succeeded repos, keeps failed', () => {
       workbenchStore.toggleFile('/a', 'x.ts');
       workbenchStore.applyCommitResults([{ repoPath: '/a', ok: false, error: 'hook' }]);
       expect(workbenchStore.repoTriState('/a')).toBe('some'); // kept on failure
       workbenchStore.applyCommitResults([{ repoPath: '/a', ok: true, newHead: 'h' }]);
       expect(workbenchStore.repoTriState('/a')).toBe('none'); // cleared on success
     });
   });
   ```

   跑（紅）：
   ```
   cd graph && npx vitest run webview-ui/src/workbench/__tests__/workbench-store.test.ts --project webview
   ```

2. **(GREEN)** 建立 `graph/webview-ui/src/workbench/workbench-store.svelte.ts`：

   ```ts
   // Webview-side mirror of the host status/selection shapes (kept inline so the
   // webview never imports host code — same convention as message-bus's
   // snipcodeCopyFullSource). Selection is pure webview state (no git calls).

   export interface WbFileChange {
     path: string;
     changeType: string;
     hunkCount: number;
     hunkable: boolean;
   }
   export interface WbRepoStatus {
     repoPath: string;
     repoName: string;
     files: WbFileChange[];
     operationState: string;
     indexDirty: boolean;
     detached: boolean;
     commitDisabledReason: string | null;
   }
   export interface WbStatus { repos: WbRepoStatus[]; }
   export interface WbCommitResult { repoPath: string; ok: boolean; newHead?: string; error?: string; }
   export interface WbSelection { repoPath: string; files: Array<{ path: string; hunkCount: number }>; }

   type TriState = 'all' | 'some' | 'none';

   class WorkbenchStore {
     repos = $state<WbRepoStatus[]>([]);
     // repoPath → Set of checked file paths.
     private checked = $state<Record<string, Set<string>>>({});
     collapsed = $state<Record<string, boolean>>({});
     message = $state('');
     committing = $state(false);

     reset(): void {
       this.repos = [];
       this.checked = {};
       this.collapsed = {};
       this.message = '';
       this.committing = false;
     }

     setStatus(status: WbStatus): void {
       this.repos = status.repos;
       // Drop checks for files/repos that no longer exist; keep the rest.
       const next: Record<string, Set<string>> = {};
       for (const repo of status.repos) {
         const prev = this.checked[repo.repoPath];
         if (!prev) continue;
         const paths = new Set(repo.files.map((f) => f.path));
         const kept = new Set([...prev].filter((p) => paths.has(p)));
         if (kept.size) next[repo.repoPath] = kept;
       }
       this.checked = next;
     }

     private repo(repoPath: string): WbRepoStatus | undefined {
       return this.repos.find((r) => r.repoPath === repoPath);
     }
     private disabled(repoPath: string): boolean {
       return this.repo(repoPath)?.commitDisabledReason != null;
     }

     toggleFile(repoPath: string, path: string): void {
       if (this.disabled(repoPath)) return;
       const set = new Set(this.checked[repoPath] ?? []);
       if (set.has(path)) set.delete(path); else set.add(path);
       this.checked = { ...this.checked, [repoPath]: set };
     }

     toggleRepo(repoPath: string): void {
       if (this.disabled(repoPath)) return;
       const repo = this.repo(repoPath);
       if (!repo) return;
       const state = this.repoTriState(repoPath);
       const set = state === 'all' ? new Set<string>() : new Set(repo.files.map((f) => f.path));
       this.checked = { ...this.checked, [repoPath]: set };
     }

     toggleCollapse(repoPath: string): void {
       this.collapsed = { ...this.collapsed, [repoPath]: !this.collapsed[repoPath] };
     }

     isChecked(repoPath: string, path: string): boolean {
       return this.checked[repoPath]?.has(path) ?? false;
     }

     repoTriState(repoPath: string): TriState {
       const repo = this.repo(repoPath);
       const set = this.checked[repoPath];
       if (!repo || !set || set.size === 0) return 'none';
       return set.size === repo.files.length ? 'all' : 'some';
     }

     selections(): WbSelection[] {
       const out: WbSelection[] = [];
       for (const repo of this.repos) {
         const set = this.checked[repo.repoPath];
         if (!set || set.size === 0) continue;
         out.push({
           repoPath: repo.repoPath,
           files: repo.files
             .filter((f) => set.has(f.path))
             .map((f) => ({ path: f.path, hunkCount: f.hunkCount })),
         });
       }
       return out;
     }

     get canCommit(): boolean {
       return this.selections().length > 0 && !this.committing;
     }
     get canAmend(): boolean {
       // Amend only when the whole selection is inside a single repo.
       return this.selections().length === 1 && !this.committing;
     }

     applyCommitResults(results: WbCommitResult[]): void {
       const next = { ...this.checked };
       for (const r of results) {
         if (r.ok) delete next[r.repoPath]; // succeeded → clear selection
         // failed → keep selection (avoid double-commit on retry)
       }
       this.checked = next;
       this.committing = false;
     }
   }

   export const workbenchStore = new WorkbenchStore();
   ```

   跑到綠：
   ```
   cd graph && npx vitest run webview-ui/src/workbench/__tests__/workbench-store.test.ts --project webview
   ```

3. **(COMMIT)** `feat(workbench): 新增 workbench Svelte store（分組/勾選/tri-state）`

---

## Task 8 — Workbench.svelte UI + 綁定 provider（webview, 手動 F5 驗收）

### Files
- 新增 `graph/webview-ui/src/workbench/Workbench.svelte`（含 RepoGroup / FileRow / CommitBox 於單檔，ponytail：少檔）
- 修改 `graph/webview-ui/src/workbench.ts`（改成 mount 真元件 + 綁 vscode 訊息）

### Interfaces
- Consumes：`workbenchStore`（Task 7）、`WorkbenchExtensionMessage`（結構就地鏡射）。
- Produces：可運作 UI（分組樹 + 整檔 checkbox + banner + 共用訊息框 + Commit/Amend）。

### 設計備註（守 scope）
- **無 Shiki、無 diff 檢視器**（設計 §UI 基礎建設：持久側欄不背 Shiki）。B-2a 只列檔名 + 徽章 + checkbox。
- HunkView（展開逐 hunk）**不做**，留 B-2b。
- 用簡單 CSS，套 VS Code CSS 變數（`--vscode-*`）維持主題一致。

### Steps

1. **(entry 綁訊息)** 覆寫 `graph/webview-ui/src/workbench.ts`：

   ```ts
   import { mount } from 'svelte';
   import Workbench from './workbench/Workbench.svelte';
   import { workbenchStore } from './workbench/workbench-store.svelte';

   // Minimal one-shot vscode api (workbench has its own bundle/context; the
   // graph vscode-api.ts drags uiStore, so we acquire locally in ~3 lines).
   const vscode = acquireVsCodeApi();

   window.addEventListener('message', (e) => {
     const msg = e.data;
     switch (msg?.type) {
       case 'workbenchStatus':
         workbenchStore.setStatus(msg.payload);
         break;
       case 'workbenchCommitResult':
         workbenchStore.applyCommitResults(msg.payload.results);
         break;
       case 'error':
         if (msg.payload?.source === 'workbenchCommit') workbenchStore.committing = false;
         break;
     }
   });

   export function postCommit(amend: boolean): void {
     workbenchStore.committing = true;
     vscode.postMessage({
       type: 'workbenchCommit',
       payload: {
         message: workbenchStore.message,
         amend,
         // $state proxies must be snapshotted before postMessage (DataCloneError).
         repos: JSON.parse(JSON.stringify(workbenchStore.selections())),
       },
     });
   }

   export function requestStatus(): void {
     vscode.postMessage({ type: 'workbenchGetStatus' });
   }

   mount(Workbench, { target: document.getElementById('workbench-app')! });
   requestStatus();

   // acquireVsCodeApi is injected by the webview host at runtime.
   declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
   ```

   > 註：`declare function` 需移到檔案頂部（TS 要求宣告在使用前的 hoist 對 `declare` 成立，但為清楚建議放最上面）。
   > 實作者把 `declare` 移到 import 之後、程式之前。

2. **(GREEN — Workbench.svelte)** 建立 `graph/webview-ui/src/workbench/Workbench.svelte`：

   ```svelte
   <script lang="ts">
     import { workbenchStore } from './workbench-store.svelte';
     import { postCommit } from '../workbench';

     const store = workbenchStore;

     function triClass(state: 'all' | 'some' | 'none'): string {
       return state === 'all' ? 'checked' : state === 'some' ? 'partial' : '';
     }
   </script>

   <div class="workbench">
     {#if store.repos.length === 0}
       <p class="empty">沒有偵測到未提交的變更。</p>
     {:else}
       {#each store.repos as repo (repo.repoPath)}
         <section class="repo">
           <header class="repo-head">
             <button class="collapse" onclick={() => store.toggleCollapse(repo.repoPath)}>
               <span class="codicon codicon-chevron-{store.collapsed[repo.repoPath] ? 'right' : 'down'}"></span>
             </button>
             <input
               type="checkbox"
               class={triClass(store.repoTriState(repo.repoPath))}
               checked={store.repoTriState(repo.repoPath) === 'all'}
               indeterminate={store.repoTriState(repo.repoPath) === 'some'}
               disabled={repo.commitDisabledReason != null}
               onchange={() => store.toggleRepo(repo.repoPath)}
             />
             <span class="repo-name">{repo.repoName}</span>
             <span class="count">{repo.files.length} changes</span>
           </header>

           {#if repo.commitDisabledReason}
             <p class="banner error">{repo.commitDisabledReason}</p>
           {:else if repo.detached}
             <p class="banner warn">detached HEAD：此提交不在任何分支上。</p>
           {/if}

           {#if !store.collapsed[repo.repoPath]}
             <ul class="files">
               {#each repo.files as file (file.path)}
                 <li class="file-row">
                   <input
                     type="checkbox"
                     checked={store.isChecked(repo.repoPath, file.path)}
                     disabled={repo.commitDisabledReason != null}
                     onchange={() => store.toggleFile(repo.repoPath, file.path)}
                   />
                   <span class="badge badge-{file.changeType}">{file.changeType}</span>
                   <span class="path">{file.path}</span>
                   {#if file.hunkable}
                     <span class="hunks">{file.hunkCount} hunk{file.hunkCount === 1 ? '' : 's'}</span>
                   {:else}
                     <span class="hunks whole">整檔</span>
                   {/if}
                 </li>
               {/each}
             </ul>
           {/if}
         </section>
       {/each}
     {/if}

     <div class="commit-box">
       <textarea
         bind:value={store.message}
         placeholder="commit message（共用一個，繁中）"
         rows="3"
       ></textarea>
       <div class="actions">
         <button disabled={!store.canCommit || store.message.trim() === '' || store.committing}
                 onclick={() => postCommit(false)}>
           Commit 勾選的變更
         </button>
         <button disabled={!store.canAmend || store.message.trim() === '' || store.committing}
                 onclick={() => postCommit(true)}
                 title={store.canAmend ? '' : 'Amend 只在勾選集中單一 repo 時可用'}>
           Amend
         </button>
       </div>
     </div>
   </div>

   <style>
     .workbench { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; padding: 4px; }
     .empty { opacity: 0.7; padding: 8px; }
     .repo-head { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
     .repo-name { font-weight: 600; }
     .count { opacity: 0.6; margin-left: auto; }
     .banner { margin: 2px 0 4px 20px; padding: 4px 6px; border-radius: 3px; font-size: 11px; }
     .banner.error { background: var(--vscode-inputValidation-errorBackground); }
     .banner.warn { background: var(--vscode-inputValidation-warningBackground); }
     .files { list-style: none; margin: 0; padding: 0 0 0 20px; }
     .file-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
     .badge { font-weight: 700; width: 1.2em; text-align: center; }
     .badge-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
     .badge-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
     .badge-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
     .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
     .hunks { opacity: 0.6; font-size: 11px; }
     .collapse { background: none; border: none; color: inherit; cursor: pointer; padding: 0; }
     .commit-box { border-top: 1px solid var(--vscode-panel-border); margin-top: 6px; padding-top: 6px; }
     textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
       color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: vertical; }
     .actions { display: flex; gap: 6px; margin-top: 6px; }
     .actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
       border: none; padding: 4px 10px; cursor: pointer; }
     .actions button:disabled { opacity: 0.5; cursor: default; }
   </style>
   ```

   > 註：`Workbench.svelte` 從 `../workbench.ts` import `postCommit` 造成「元件 ↔ entry」互相 import。
   > 若 svelte-check 對此循環有疑慮，實作者可把 `postCommit`/`requestStatus` 抽到獨立
   > `workbench/messaging.ts`（entry 只負責 mount + 監聽）。B-2a 允許此小重構，屬同 Task 範圍。

3. **(驗證 — 型別 + build + 手動 F5)**
   ```
   cd graph && npm run check        # svelte-check 全綠（webview 型別）
   # 回 repo 根：
   npm run build                    # 產出 workbench.* 並複製到 dist/graph-webview
   ```
   手動 F5（Extension Development Host）驗收清單（vscode-bound 部分依測試策略以此交付）：
   - Activity Bar 出現「Snipcode Git」容器與「Commit Workbench」view，可載入（無 CSP/404 錯誤，DevTools console 乾淨）。
   - 多 repo 工作區：每個有變更的 repo 分組列出、可折疊；每檔顯示變更類型 + hunk 數；整檔 checkbox 可勾。
   - index 非空 / merge 中 repo：顯示 banner 且該 repo 檔案不可勾、Commit 對它停用。
   - 勾選跨 repo → 填訊息 → Commit：對應 repo 各產生 commit；成功 repo 檔案從清單消失、selection 清空。
   - 製造 pre-commit hook 失敗（在某 repo 放 `.git/hooks/pre-commit` exit 1）：該 repo 保留 selection 與訊息，
     其他 repo 仍成功（驗證 per-repo 部分失敗 + 不重複提交）。
   - Amend：僅勾單一 repo 時可按；跨多 repo 勾選時 Amend 停用。

4. **(COMMIT)** `feat(workbench): 新增 Commit Workbench Svelte UI 與 provider 綁定`

---

## Self-Review

### 對照 spec 覆蓋

- **D2（交易與鎖，跨面板序列化）**：✅ 每個 repo 的提交 `runExclusive(repoPath, () => commitSelected(...))`
  （Task 3 編排 + Task 5 注入真 `runExclusive`）。與 Graph 共用同一把 module-level、repo-path-keyed 鎖
  （`mutation-coordinator.ts`），不各做一份。`commitSelected` 內部仍有 per-instance `withMutationLock`，兩層不衝突
  （runExclusive 是跨面板序列化，withMutationLock 是同實例序列化）。
- **D3（最小結構化 status）**：✅ Task 2 只到「分 repo + 檔清單 + 變更類型 + hunk 數 + hunkable」。完整
  `porcelain=v2 -z` 結構化、rename old/new、submodule/mode-only/symlink 能力矩陣**明列延到 B-2b**。
- **D4（提交適用政策 banner）**：✅ index 非空（D1）與 in-progress op（merge/rebase/cherry-pick/revert/bisect）
  → `commitDisabledReason` 停用該 repo（Task 2 `disabledReason` + Task 8 banner）；detached → 允許但警告（不停用）。
  底層阻擋仍由 `commitSelected` 的既有 D1/D4 guard 兜底（即使 UI 漏擋，host 仍拒絕並經 error 回報）。
- **Slice B 面板段**：✅ 獨立 Activity Bar webview view（非 createWebviewPanel）、repo 只作分組、共用單一訊息框、
  勾選跨 repo、N 個獨立 commit 共用一則訊息、per-repo 結果與部分失敗、成功清 selection/失敗保留、
  Amend 單一 repo 限制、debounce 刷新。
- **明確不做（scope fence 守住）**：逐 hunk 勾選 UI 與逐 hunk 提交、diff 檢視器渲染、ClipCode 複製（D6）、
  stale 指紋防護、完整 porcelain v2 結構化與能力矩陣、CRLF 整合測試 —— 全部**未**出現在任何 Task，於下方「延到 B-2b」重列。

### Placeholder scan
- 全文無 `TODO`/`FIXME`/`...`/空函式殘留。唯一「佔位」是 Task 6 的 `workbench.ts` 佔位字串，**在 Task 8 被真 mount 取代**
  （刻意的 build-first 中間態，非最終殘留）。

### 型別一致性
- host `WorkbenchStatus/RepoStatus/WorkbenchFileChange/PerRepoSelection/RepoCommitResult` 定義於
  `workbench-messages.ts`（Task 1），被 Task 2/3/5 消費；webview 端就地鏡射等價型別（`workbench-store.svelte.ts`
  的 `Wb*`），符合「vendored 不 import host、adapter 邊界 thin」慣例。兩側欄位一一對應（path/changeType/hunkCount/
  hunkable、repoPath/ok/newHead/error），實作者需人工核對命名一致（無編譯期保證，因刻意解耦）。
- `commitSelected` deps 簽章帶 `repoPath` 首參，與 `GitService.commitSelected(message, files, opts)`（綁單一 repo）
  的差異由 provider 的 adapter `(repoPath, m, f, o) => new GitService(repoPath).commitSelected(m, f, o)` 弭平。

### 風險 / 對既有程式的偏差（實作者必須驗證）

1. **Vite 多入口輸出檔名（最高風險）**：現行 config 硬編 `entryFileNames:'main.js'` + `cssCodeSplit:false`。
   Task 6 改成 `[name].js` + `cssCodeSplit:true` + 兩 html input。**未實跑 vite** —— Vite 可能：
   (a) 把兩入口共用模組拆出 shared chunk（`chunkFileNames:'[name].js'` 下命名可能撞或帶 hash）；
   (b) CSS 檔名不完全等於 `main.css/workbench.css`。緩解：copy-assets 加了 fail-fast 斷言（Task 6 step 4），
   build 會立刻爆而非默默漏檔。**實作者需實跑 `npm run build` 確認四資產檔名，必要時調 `assetFileNames`/getHtml。**
   這是計畫指定的 spike 點。

2. **`copy-graph-assets.mjs` 是否真需改**：既有迴圈 `for (name of readdir(viteDist)) cp(...)` **已會**複製 dist
   內全部檔（含 workbench.*），所以「複製」本身可能無需改；Task 6 的改動是**加斷言**（防命名漂移），非改複製邏輯。
   若實跑發現 vite 把資產放進 `dist/assets/` 子目錄，則複製與 getHtml 連結都要對齊子路徑。

3. **`WebviewViewProvider` 註冊位置與資產可用性**：provider 在 `graph/src/extension.ts` `activate()` 註冊，
   `MainPanel.assetRootUri` 由 `activateGraph` 於 `activate()` 前設定 → provider 能取到 `dist/graph-webview`。
   但 **view 只在使用者點開 Activity Bar 容器時才 `resolveWebviewView`**；若那時 workbench.* 尚未打包（dev 未 build），
   會 404。實作者確認 dev 流程（`npm run dev` watch）會產出 workbench.*，或 F5 前先 `npm run build`。

4. **package.json 貢獻在 host 根、id 對齊**：view container/view 貢獻加在 **host 根 package.json**（非 graph 的），
   `views` key 必須用 container id `snipcode.commitWorkbench-container`，view id `snipcode.commitWorkbench` 要與
   `CommitWorkbenchViewProvider.viewType` 字串完全一致，否則註冊拋「no view registered」。`icon` 路徑需存在。

5. **`commitSelected` 簽章擴充是對 B-1 的偏差**：Task 4 加 `opts?.amend`。optional 參數不破壞既有呼叫端，但這是動
   B-1 交付的方法 —— 若 B-1 擁有者有別的 amend 規劃（例如 `--only`/`--reset-author` 語意），需先對齊。替代方案
   （另開 `amendSelected`）會重複整段交易流程，故本計畫選擇擴充。

6. **debounce 刷新用 N 個 FileWatcher**：Task 5 step 4 對每 repo 各建一個 `FileWatcher`。`FileWatcher` 建構/enable
   語意以 `MainPanel.ts` 現用法推定（`new FileWatcher(repoPath, cb)` + `.enabled = true`），實作者需核對其真簽章
   與 dispose 行為。repo 動態增減不重連 watcher，留 B-2b。

7. **webview entry ↔ 元件互相 import**：`Workbench.svelte` import `../workbench.ts` 的 `postCommit`，而
   `workbench.ts` import `Workbench.svelte`。若 svelte-check/bundler 對此循環報警，抽 `workbench/messaging.ts` 化解
   （計畫已在 Task 8 step 2 註明，屬同 Task 範圍）。

8. **`branches()` 每 repo 一次額外 git 呼叫**（Task 2 detached 偵測）：多 repo 時是 N 次 spawn。B-2a 可接受；
   若效能有感，B-2b 併入 porcelain v2 status 時可一起拿到 detached，省這次呼叫。

### 明列延到 B-2b
- 逐 hunk 勾選 UI（HunkView）與逐 hunk 提交、tri-state 到 hunk 層級。
- diff 檢視器渲染（展開檔案看 diff 行）。
- ClipCode「⧉ 複製成 ClipCode」（D6，hunk→完整 snapshot、多 repo namespace）。
- stale 指紋防護（expected HEAD + working-content fingerprint + hunk digest 驗證）。
- 完整 `git status --porcelain=v2 -z` 結構化 status 與完整能力矩陣（rename old/new、submodule、mode-only、symlink、intent-to-add）。
- CRLF/autocrlf 整合測試。
- repo 動態增減時的 FileWatcher 重連。
