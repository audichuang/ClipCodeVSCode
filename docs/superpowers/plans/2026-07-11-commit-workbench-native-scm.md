# Snipcode Git — 原生 SCM 提交工作台 (B-2 重做) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 VS Code 原生 SCM API（`vscode.scm.createSourceControl` / `SourceControlResourceGroup`）取代 B-2a 的自訂 webview 提交面板，做出多 repo、真實 git staging（Staged / Unstaged 兩組）、原生檔案圖示與 git 顏色、hover inline stage/unstage、每 repo 一個 commit 訊息框的「Snipcode Git」提交工作台。

**Architecture:** 每個 repo 建一個 `SourceControl`（共用 id `snipcodeGit`），各自兩個 `SourceControlResourceGroup`（`staged` / `changes`）。資源清單來自既有 `git-service.ts` 的 `getUncommittedDiff()`（porcelain 已切好 staged/unstaged）。stage/unstage/commit 是新增的 git-service 方法，走真實 `git add` / `git reset` / `git commit`（推翻 D1 的虛擬/乾淨-index 模型）。`resourceUri` 指向實體檔案 → 免費拿到原生檔案類型圖示與內建 git 擴充的 FileDecoration（彩色檔名 + 狀態徽章）。命令 handler 在 host 層（`src/scm/`，非 `git/`）呼叫 git-service，並用 `runExclusive`（mutation-coordinator，D2）與 Graph 側序列化。

**Tech Stack:** TypeScript（extension host, esbuild CJS）、VS Code SCM API、既有 `graph/src/git/git-service.ts`（child_process 包 git CLI）、Vitest backend project（真 git 整合測試）。

## Global Constraints

- **`git/` 目錄不得 import `vscode`。** git-service / parser 必須維持可用真 git CLI 單元測試。任何 vscode-aware 程式（SCM 註冊、命令、decoration）放 `src/scm/` 或 `extension.ts`，透過參數注入 repo 路徑與方法。
- **每個新命令都要在 `package.json` `contributes.commands` 宣告，並在需要按鈕的地方貢獻 `menus`。** 只在程式碼 `registerCommand` 而 package.json 沒宣告，命令面板／menu 不會出現。
- **移除舊 webview 提交 UI 的註冊，避免兩個提交入口並存。** B-2a 的 `snipcode.commitWorkbench` view、`snipcode-commit-workbench` viewsContainer、`CommitWorkbenchViewProvider` 註冊全數移除。
- **多 repo 共用同一個 SourceControl id `snipcodeGit`**（比照內建 git 全 repo 共用 id `git`）。因此所有 `menus` 的 `when` 用 `scmProvider == snipcodeGit`，一次涵蓋全部 repo。
- **stage/unstage/commit 只接受 repo-relative 路徑**：`git-service.assertSafePath` 會拒絕絕對路徑與 `..`。SCM resource 同時記住 `resourceUri`（絕對，給圖示）與 `relPath`（repo-relative，給 git 指令）。
- **所有變更 index 的 handler 走 `runExclusive(repoPath, fn)`**（`src/services/mutation-coordinator.ts`）以與 Graph / 側欄的 mutation 序列化（D2）。
- **commit 訊息（git 與本 plan 產出的 commit）一律繁體中文、不得含任何 attribution / Co-Authored-By 行。** 程式碼註解用英文。
- 測試指令：backend 單元／整合 `cd graph && npx vitest run <path> --project backend`；host 型別 `cd graph && npm run lint`；整包 build `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`。

## Scope fence (v1)

**做：** 原生 SCM 的「Snipcode Git」——多 repo，每 repo 一個 SourceControl；Staged Changes / Changes 兩組；原生檔案圖示 + 內建 git 彩色檔名/徽章；hover inline stage/unstage（單檔與多選）；group header 的 stage-all / unstage-all；每 repo 一個 commit 訊息框（`inputBox`）+ commit 已 staged 的 index；refresh on file/HEAD change（沿用既有 FileWatcher）；SourceControl label 帶 branch 名。移除 B-2a webview 提交面板的註冊。

**不做（延到 B-2b）：** 逐 hunk 勾選與 hunk-level stage；內嵌自訂 diff 檢視（v1 用內建 `git.openChange` 開 diff）；「⧉ 複製成 ClipCode」；單一共用的跨-repo commit 訊息框（原生 SCM 每個 SourceControl 各自一個 inputBox，做不到單框跨 repo）；動態新增/移除 repo 時 SourceControl 的即時重連（沿用 B-2a 的靜態探索，動態 re-wiring 留 B-2b）。

## File Structure

- **`graph/src/git/git-service.ts`** (modify) — 新增 `stagePaths` / `unstagePaths` / `commitIndex`，並把 `rm` 加進 mutation 分類。純 git，無 vscode。
- **`graph/src/git/__tests__/integration/staging.integration.test.ts`** (create) — 真 git 整合測試，驗 stage/unstage/commit 與 `getUncommittedDiff` 交互。
- **`graph/src/scm/snipcode-scm.ts`** (create) — `SnipcodeScmManager`：建 SourceControl / 群組、從 `getUncommittedDiff` 填 resource states、branch label、debounce refresh，以及命令 handler + `registerCommands`。vscode-aware，放 `src/scm/` 而非 `git/`。
- **`graph/src/extension.ts`** (modify) — 移除 `CommitWorkbenchViewProvider` 註冊與其 FileWatcher 迴圈；改註冊 `SnipcodeScmManager`、`registerCommands`、把 FileWatcher 導向 `manager.scheduleRefresh()`。
- **`graph/src/workbench/CommitWorkbenchViewProvider.ts`** (delete) — 舊 webview 提供者，改用原生 SCM 後為死碼。
- **`package.json`** (root, modify) — 移除 `snipcode-commit-workbench` viewsContainer 與 `snipcode.commitWorkbench` view；新增 `snipcode.scm.*` 命令與 `scm/*` menus。

> **保留不動（B-2b 複用）：** `graph/src/workbench/workbench-status.ts`、`commit-across-repos.ts`、`workbench-messages.ts`、`git-service.commitSelected`（D1 逐-hunk 提交邏輯）、webview 端 workbench bundle（`vite.workbench.config.ts` 等）。它們不再被載入（view 已移除），但保留 git 邏輯供 B-2b 的 hunk-level UI 複用。見結尾 Self-Review。

---

## Task 1: git-service — 真實 staging 方法（stagePaths / unstagePaths / commitIndex）

**Files:**
- Modify: `graph/src/git/git-service.ts`（`invalidatesReadCache` 加 `rm`；在 `stageFile` 附近新增三個方法）
- Test: `graph/src/git/__tests__/integration/staging.integration.test.ts`

**Interfaces:**
- Consumes（既有，已讀確認形狀）：
  - `getUncommittedDiff(): Promise<{ staged: Array<{ path: string; status: string }>; unstaged: Array<{ path: string; status: string }> }>` — porcelain `-z -uall`，同一檔可同時出現在 staged 與 unstaged（MM）；untracked → unstaged `status:'U'`；巢狀 repo → `status:'N'`；rename `status:'R'` 的 `path` 是新路徑。
  - `private exec(args)` 已對 `add`/`reset`/`commit` 走 `withMutationLock`（見 `invalidatesReadCache`）；`rm` 目前不在清單。
  - `private assertSafePath(filePath, context)` 會拒絕絕對路徑 / `..` / 開頭 `-`。
  - `GitError`（同檔 export，`err.exitCode`）。
- Produces（Task 3 依賴）：
  - `stagePaths(paths: string[]): Promise<void>`
  - `unstagePaths(paths: string[]): Promise<void>`
  - `commitIndex(message: string): Promise<string>`（回傳新 HEAD hash）

- [ ] **Step 1: 寫失敗測試**

新增 `graph/src/git/__tests__/integration/staging.integration.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from './helpers';

describe('GitService integration — real staging (stagePaths/unstagePaths/commitIndex)', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
    // A committed baseline file so we can produce tracked modifications.
    commit(repo.path, 'baseline', { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  });
  afterEach(() => repo.cleanup());

  it('stagePaths moves a modified file from unstaged to staged', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    let diff = await svc.getUncommittedDiff();
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
    expect(diff.staged.map(e => e.path)).not.toContain('a.txt');

    await svc.stagePaths(['a.txt']);

    diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).toContain('a.txt');
  });

  it('stagePaths handles an untracked new file', async () => {
    writeFile(repo.path, 'new.txt', 'hi\n');
    await svc.stagePaths(['new.txt']);
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.find(e => e.path === 'new.txt')?.status).toBe('A');
  });

  it('unstagePaths moves a staged file back to unstaged (working change kept)', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']);
    await svc.unstagePaths(['a.txt']);
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).not.toContain('a.txt');
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
  });

  it('MM: a file staged then edited again shows in BOTH groups', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    await svc.stagePaths(['a.txt']);
    writeFile(repo.path, 'a.txt', 'a3\n'); // further unstaged edit
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged.map(e => e.path)).toContain('a.txt');
    expect(diff.unstaged.map(e => e.path)).toContain('a.txt');
  });

  it('commitIndex commits only staged, leaves the rest in the working tree, index clean', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n');
    writeFile(repo.path, 'b.txt', 'b2\n');
    await svc.stagePaths(['a.txt']); // stage only a.txt

    const hash = await svc.commitIndex('修正 a 檔');

    expect(hash).toMatch(/^[0-9a-f]{7,40}$/);
    // index is clean after commit
    const diff = await svc.getUncommittedDiff();
    expect(diff.staged).toHaveLength(0);
    // b.txt is still an unstaged working change (was never staged/committed)
    expect(diff.unstaged.map(e => e.path)).toContain('b.txt');
    // the commit message landed
    expect(runGit(repo.path, ['log', '-1', '--format=%s'])).toBe('修正 a 檔');
  });

  it('commitIndex throws when nothing is staged', async () => {
    writeFile(repo.path, 'a.txt', 'a2\n'); // unstaged only
    await expect(svc.commitIndex('空提交')).rejects.toThrow(/nothing staged/i);
  });

  it('unstagePaths under an unborn HEAD (no commits) unstages via rm --cached', async () => {
    const fresh = createTempRepo();
    try {
      const s = new GitService(fresh.path);
      writeFile(fresh.path, 'x.txt', 'x\n');
      await s.stagePaths(['x.txt']);
      await s.unstagePaths(['x.txt']); // must not throw despite no HEAD
      const diff = await s.getUncommittedDiff();
      expect(diff.staged).toHaveLength(0);
      expect(diff.unstaged.find(e => e.path === 'x.txt')?.status).toBe('U');
    } finally {
      fresh.cleanup();
    }
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd graph && npx vitest run src/git/__tests__/integration/staging.integration.test.ts --project backend`
Expected: FAIL —「svc.stagePaths is not a function」（方法尚未存在）。

- [ ] **Step 3: 實作三個方法 + 把 `rm` 加進 mutation 分類**

在 `graph/src/git/git-service.ts` 的 `invalidatesReadCache`（`switch (cmd)`）加入 `rm`，讓 unborn-HEAD 的 `git rm --cached` 也走 mutation lock。找到 `case 'reset':` 上方，加一行：

```ts
      case 'restore':
      case 'rm':
      case 'switch':
```

（把 `rm` 插進既有的 `add/apply/.../reset/restore/switch/am → return true` 連續 case 群組中；只需新增 `case 'rm':` 一行，其餘不動。）

在 `stageFile(filePath)` 方法後面新增：

```ts
  /**
   * Stage the given repo-relative paths into the index (`git add`). No-op on an
   * empty list. Routes through exec() → withMutationLock (add is a mutation).
   */
  async stagePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const p of paths) this.assertSafePath(p, 'add');
    await this.exec(['add', '--', ...paths]);
  }

  /**
   * Remove the given repo-relative paths from the index, keeping working-tree
   * changes. With a HEAD this is `git reset -q HEAD -- <paths>`; under an unborn
   * HEAD (no commits yet) there is no tree to reset against, so unstage by
   * dropping the index entries with `git rm --cached`.
   */
  async unstagePaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const p of paths) this.assertSafePath(p, 'reset');
    const hasHead = await this.exec(['rev-parse', '--verify', 'HEAD'], { silent: true })
      .then(() => true)
      .catch(() => false);
    if (hasHead) {
      await this.exec(['reset', '--quiet', 'HEAD', '--', ...paths]);
    } else {
      await this.exec(['rm', '--cached', '--quiet', '--', ...paths]);
    }
  }

  /**
   * Commit whatever is currently staged (`git commit -m`). Throws with a clear
   * message when the index is empty (git would fail anyway). Returns the new
   * HEAD hash.
   */
  async commitIndex(message: string): Promise<string> {
    const indexEmpty = await this.exec(['diff', '--cached', '--quiet'], { silent: true })
      .then(() => true)
      .catch(err => {
        if (err instanceof GitError && err.exitCode === 1) return false;
        throw err;
      });
    if (indexEmpty) throw new Error('nothing staged to commit');
    await this.exec(['commit', '-m', message]);
    return (await this.exec(['rev-parse', 'HEAD'])).trim();
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd graph && npx vitest run src/git/__tests__/integration/staging.integration.test.ts --project backend`
Expected: PASS（7 個測試全綠，`Tests  7 passed`）。

- [ ] **Step 5: 型別檢查**

Run: `cd graph && npm run lint`
Expected: 無錯誤（`tsc --noEmit` 通過）。

- [ ] **Step 6: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/src/git/git-service.ts graph/src/git/__tests__/integration/staging.integration.test.ts
git commit -m "新增 git-service 真實 staging 方法 stagePaths/unstagePaths/commitIndex"
```

---

## Task 2: SnipcodeScmManager — 建 SCM、群組、resource states、branch label、refresh；移除舊 webview 註冊

此 Task 交付一個**唯讀可見**的 SCM view：SCM 面板出現「Snipcode Git · <repo> (<branch>)」，每 repo 有 Staged Changes / Changes 兩組、原生檔案圖示、內建 git 彩色檔名，點檔案開 diff。互動按鈕（stage/unstage/commit）留給 Task 3。舊 webview 提交面板同時移除。因程式碼 vscode-bound，驗收為**編譯通過 + 一次手動 F5**。

**Files:**
- Create: `graph/src/scm/snipcode-scm.ts`
- Modify: `graph/src/extension.ts`
- Delete: `graph/src/workbench/CommitWorkbenchViewProvider.ts`
- Modify: `package.json`（root — 移除舊 view + viewsContainer）

**Interfaces:**
- Consumes：
  - `getUncommittedDiff()`（Task 1 之前已存在）
  - `branches(): Promise<BranchInfo[]>`（`BranchInfo` 有 `name: string`、`current: boolean`、`detached?: boolean`）
  - `RepoDiscoveryService.discoverRepos(folderPaths: string[]): Promise<RepoInfo[]>`（`RepoInfo.path`）
  - `FileWatcher`（`new FileWatcher(repoPath, onChange)`；`w.enabled = true`）
- Produces（Task 3 依賴）：
  - `class SnipcodeScmManager implements vscode.Disposable`
  - `async init(): Promise<void>`
  - `async refresh(): Promise<void>`
  - `scheduleRefresh(): void`
  - `dispose(): void`
  - 內部型別 `ScmResource extends vscode.SourceControlResourceState`（帶 `repoPath: string`、`relPath: string`、`staged: boolean`）與 `repos: Map<string, RepoScm>`——Task 3 的命令 handler 直接掛在此 class 上。

- [ ] **Step 1: 建立 `SnipcodeScmManager`（唯讀版）**

新增 `graph/src/scm/snipcode-scm.ts`：

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from '../git/git-service';
import { RepoDiscoveryService } from '../services/repo-discovery';

/**
 * A resource state that remembers which repo + repo-relative path it maps to,
 * so command handlers (Task 3) can call the repo-relative git-service methods.
 */
export interface ScmResource extends vscode.SourceControlResourceState {
  repoPath: string;
  relPath: string;
  staged: boolean;
}

interface RepoScm {
  baseName: string;
  svc: GitService;
  sc: vscode.SourceControl;
  stagedGroup: vscode.SourceControlResourceGroup;
  changesGroup: vscode.SourceControlResourceGroup;
  branch: string;
}

/**
 * Owns one native VS Code SourceControl per discovered repo (all sharing the id
 * `snipcodeGit`, mirroring the built-in git provider's single id across repos).
 * Each repo gets a Staged Changes + Changes group populated from
 * getUncommittedDiff(). resourceUri points at the real file so VS Code supplies
 * the native file-type icon and the built-in git FileDecorationProvider colours
 * the filename / adds the status badge for free.
 */
export class SnipcodeScmManager implements vscode.Disposable {
  protected repos = new Map<string, RepoScm>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Discover repos, create a SourceControl each, then populate. */
  async init(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const found = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    for (const r of found) this.ensureRepo(r.path);
    await this.refresh();
  }

  private ensureRepo(repoPath: string): RepoScm {
    const existing = this.repos.get(repoPath);
    if (existing) return existing;
    const repo = this.createRepo(repoPath, path.basename(repoPath), '');
    this.repos.set(repoPath, repo);
    return repo;
  }

  /** Create a SourceControl + two groups. label carries the branch when known. */
  private createRepo(repoPath: string, baseName: string, branch: string): RepoScm {
    const label = branch ? `Snipcode Git · ${baseName} (${branch})` : `Snipcode Git · ${baseName}`;
    const sc = vscode.scm.createSourceControl('snipcodeGit', label, vscode.Uri.file(repoPath));
    const stagedGroup = sc.createResourceGroup('staged', 'Staged Changes');
    const changesGroup = sc.createResourceGroup('changes', 'Changes');
    stagedGroup.hideWhenEmpty = true;
    changesGroup.hideWhenEmpty = true;
    sc.inputBox.placeholder = 'Snipcode Git 提交訊息';
    // acceptInputCommand fires on the input box's commit (Enter/checkmark); the
    // handler is registered in Task 3. Passing repoPath lets it find this repo.
    sc.acceptInputCommand = { command: 'snipcode.scm.commit', title: 'Commit', arguments: [repoPath] };
    return { baseName, svc: new GitService(repoPath), sc, stagedGroup, changesGroup, branch };
  }

  /** Re-read status for every repo and repaint the groups. */
  async refresh(): Promise<void> {
    await Promise.all([...this.repos.keys()].map(p => this.refreshRepo(p)));
  }

  private async refreshRepo(repoPath: string): Promise<void> {
    let repo = this.repos.get(repoPath);
    if (!repo) return;
    const [diff, branches] = await Promise.all([
      repo.svc.getUncommittedDiff().catch(() => ({ staged: [], unstaged: [] })),
      repo.svc.branches().catch(() => []),
    ]);
    const current = branches.find(b => b.current);
    const branch = current?.detached ? 'HEAD detached' : (current?.name ?? '(no branch)');
    // SourceControl.label is readonly, so a branch change means recreate.
    if (branch !== repo.branch) {
      repo.sc.dispose();
      repo = this.createRepo(repoPath, repo.baseName, branch);
      this.repos.set(repoPath, repo);
    }
    repo.stagedGroup.resourceStates = diff.staged.map(e => this.toResource(repoPath, e, true));
    repo.changesGroup.resourceStates = diff.unstaged.map(e => this.toResource(repoPath, e, false));
    repo.sc.count = diff.staged.length + diff.unstaged.length;
  }

  private toResource(
    repoPath: string,
    entry: { path: string; status: string },
    staged: boolean,
  ): ScmResource {
    const resourceUri = vscode.Uri.file(path.join(repoPath, entry.path));
    const isDelete = entry.status === 'D';
    const isUntracked = entry.status === 'U' || entry.status === 'N';
    return {
      repoPath,
      relPath: entry.path,
      staged,
      resourceUri,
      // v1 opens the built-in git working-tree diff; a custom diff view is B-2b.
      command: { command: 'git.openChange', title: 'Open Changes', arguments: [resourceUri] },
      // NO iconPath: leaving it unset keeps the native file-type icon AND lets the
      // built-in git FileDecorationProvider colour the filename + add the status
      // badge on this URI. strikeThrough/tooltip are the only extras we add.
      decorations: {
        strikeThrough: isDelete,
        faded: isUntracked && !staged,
        tooltip: statusTooltip(entry.status),
      },
      contextValue: staged ? 'staged' : 'changes',
    };
  }

  /** Debounced re-status; wired to the FileWatcher in extension.ts. */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const repo of this.repos.values()) repo.sc.dispose();
    this.repos.clear();
  }
}

function statusTooltip(status: string): string {
  switch (status) {
    case 'M': return 'Modified';
    case 'A': return 'Added';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'C': return 'Copied';
    case 'U': return 'Untracked';
    case 'N': return 'Nested repository';
    default: return status;
  }
}
```

- [ ] **Step 2: 從 `extension.ts` 移除舊 webview provider、註冊 `SnipcodeScmManager`**

在 `graph/src/extension.ts`：

移除舊 import（第 15 行附近）：

```ts
import { CommitWorkbenchViewProvider } from './workbench/CommitWorkbenchViewProvider';
```

新增 import（放在其他 `./` import 附近）：

```ts
import { SnipcodeScmManager } from './scm/snipcode-scm';
```

把整段舊 workbench 註冊（`// --- Commit Workbench (Activity Bar side panel, Slice B) ---` 起，到 `.catch(() => {});` 的 `RepoDiscoveryService.discoverRepos(workbenchFolders)...` 迴圈為止，即目前約第 187–205 行）替換為：

```ts
  // --- Snipcode Git (native SCM commit workbench, B-2) ---
  const scmManager = new SnipcodeScmManager();
  context.subscriptions.push(scmManager);
  scmManager.registerCommands(context); // Task 3 adds this method.
  void scmManager.init();
  // One FileWatcher per discovered repo, funnelled through the manager's 300ms
  // debounce. Dynamic repo add/remove re-wiring is B-2b.
  const scmFolders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  RepoDiscoveryService.discoverRepos(scmFolders).then(repos => {
    for (const r of repos) {
      const w = new FileWatcher(r.path, () => scmManager.scheduleRefresh());
      w.enabled = true;
      context.subscriptions.push(w);
    }
  }).catch(() => {});
```

> 註：`registerCommands` 由 Task 3 加到 manager；本 Task 先寫呼叫點會讓 `npm run lint` 在 Task 2 尾端報「registerCommands 不存在」。為讓 Task 2 能獨立編譯通過，先在 `snipcode-scm.ts` 加一個**暫時空實作**（Task 3 會補上真身）：

在 `SnipcodeScmManager` 內、`dispose()` 之前加：

```ts
  /** Registered in Task 3. Placeholder keeps Task 2 compiling. */
  registerCommands(_context: vscode.ExtensionContext): void {
    // ponytail: filled in Task 3.
  }
```

- [ ] **Step 3: 刪除舊 webview provider 檔**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git rm graph/src/workbench/CommitWorkbenchViewProvider.ts
```

- [ ] **Step 4: package.json 移除舊 view + viewsContainer**

在 root `package.json` `contributes` 移除以下兩塊：

`viewsContainers.activitybar` 陣列中的：

```json
        {
          "id": "snipcode-commit-workbench",
          "title": "Snipcode Git",
          "icon": "images/icon.svg"
        }
```

（若移除後 `activitybar` 陣列變空，連同 `"activitybar": []` 一併留空陣列或整個移除 `viewsContainers` 空殼——本 repo 目前 `activitybar` 只有這一個項目，移除後刪掉整個 `"viewsContainers": { "activitybar": [ ... ] }` 區塊。）

以及 `views` 中的整個 `snipcode-commit-workbench` 鍵：

```json
      "snipcode-commit-workbench": [
        {
          "id": "snipcode.commitWorkbench",
          "name": "Commit Workbench",
          "type": "webview"
        }
      ]
```

> **決策說明（保留 vs 移除 viewsContainer）：** 一併移除。原生 SCM 面板不需要自訂 Activity Bar 容器（它長在內建的 Source Control view）。留一個空的 `snipcode-commit-workbench` 容器會在側邊欄顯示一個永遠空白的圖示。B-2b 若要放 hunk/ClipCode webview，屆時再自行貢獻它需要的容器/ view。

- [ ] **Step 5: 型別檢查 + build**

Run: `cd graph && npm run lint`
Expected: 無錯誤。

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`
Expected: `BUILD` 成功；`dist/extension.js` 產出（原生 SCM 為 host 端邏輯，`grep -c "snipcodeGit" dist/extension.js` 應 ≥ 1，確認有打包進去）。

- [ ] **Step 6: 手動 F5 驗收（唯讀）**

在 VS Code 開此專案，F5 啟動 Extension Development Host，開一個含至少一個 git repo 且有未提交變更的資料夾。開啟 Source Control 面板（Ctrl/Cmd+Shift+G）。預期畫面：
- 出現一個「Snipcode Git · <repo 名> (<branch 名>)」的 provider 區塊（與內建 Git provider 並列，多 repo 各一塊）。
- 已 `git add` 過的檔案在「Staged Changes」；其餘在「Changes」。
- 每個檔案有**原生檔案類型圖示**（如 `.ts` 圖示），檔名帶 git 顏色（綠=新增、橘=修改…，由內建 git decoration 提供）；刪除的檔案有刪除線。
- 點檔案會開啟該檔的 working-tree diff（內建 `git.openChange`）。
- 舊的「Snipcode Git」Activity Bar 圖示（webview 版）不再出現。

- [ ] **Step 7: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/src/scm/snipcode-scm.ts graph/src/extension.ts package.json
git commit -m "改用原生 SCM 建 Snipcode Git 提交工作台並移除舊 webview 提交面板"
```

---

## Task 3: 命令與 menu — stage / unstage / stage-all / unstage-all / commit / refresh

此 Task 讓 SCM view 可互動：hover 檔案列出現 +/−、group header 出現 stage-all/unstage-all、每 repo 的 inputBox 可提交、title 有 refresh。驗收為**編譯通過 + 一次手動 F5**。

**Files:**
- Modify: `graph/src/scm/snipcode-scm.ts`（用真身取代 Task 2 的 `registerCommands` placeholder，並加 handler + 私有 helper）
- Modify: `package.json`（root — 新增 commands + scm menus）

**Interfaces:**
- Consumes：
  - Task 1 的 `stagePaths` / `unstagePaths` / `commitIndex`
  - Task 2 的 `SnipcodeScmManager`、`ScmResource`、`this.repos: Map<string, RepoScm>`、`refresh()`
  - `runExclusive(repoPath, fn)`（`src/services/mutation-coordinator.ts`）
- Produces：可用的 `snipcode.scm.stage` / `unstage` / `stageAll` / `unstageAll` / `commit` / `refresh` 命令。

- [ ] **Step 1: 在 `snipcode-scm.ts` 匯入 `runExclusive` 並補齊命令**

在 `snipcode-scm.ts` 頂端 import 區加：

```ts
import { runExclusive } from '../services/mutation-coordinator';
```

用下列真身**取代** Task 2 加的 placeholder `registerCommands`（整個方法換掉），並在其後（`dispose()` 之前）新增 handler 與 helper：

```ts
  registerCommands(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    reg('snipcode.scm.stage', (...args) => this.stage(flattenResources(args)));
    reg('snipcode.scm.unstage', (...args) => this.unstage(flattenResources(args)));
    reg('snipcode.scm.stageAll', (arg) => this.stageAll(arg as vscode.SourceControl));
    reg('snipcode.scm.unstageAll', (arg) => this.unstageAll(arg as vscode.SourceControl));
    reg('snipcode.scm.commit', (arg) => this.commit(arg));
    reg('snipcode.scm.refresh', () => this.refresh());
  }

  private async stage(resources: ScmResource[]): Promise<void> {
    await this.runByRepo(resources, (repo, relPaths) => repo.svc.stagePaths(relPaths));
    await this.refresh();
  }

  private async unstage(resources: ScmResource[]): Promise<void> {
    await this.runByRepo(resources, (repo, relPaths) => repo.svc.unstagePaths(relPaths));
    await this.refresh();
  }

  private async stageAll(sc: vscode.SourceControl): Promise<void> {
    const found = this.findByControl(sc);
    if (!found) return;
    const [repoPath, repo] = found;
    const relPaths = (repo.changesGroup.resourceStates as ScmResource[]).map(r => r.relPath);
    if (relPaths.length) await runExclusive(repoPath, () => repo.svc.stagePaths(relPaths));
    await this.refresh();
  }

  private async unstageAll(sc: vscode.SourceControl): Promise<void> {
    const found = this.findByControl(sc);
    if (!found) return;
    const [repoPath, repo] = found;
    const relPaths = (repo.stagedGroup.resourceStates as ScmResource[]).map(r => r.relPath);
    if (relPaths.length) await runExclusive(repoPath, () => repo.svc.unstagePaths(relPaths));
    await this.refresh();
  }

  /**
   * acceptInputCommand passes a repoPath string; a scm/title commit button would
   * pass the SourceControl. Accept both.
   */
  private async commit(arg: unknown): Promise<void> {
    let repoPath: string | undefined;
    if (typeof arg === 'string') {
      repoPath = arg;
    } else {
      repoPath = this.findByControl(arg as vscode.SourceControl)?.[0];
    }
    if (!repoPath) return;
    const repo = this.repos.get(repoPath);
    if (!repo) return;
    const message = repo.sc.inputBox.value.trim();
    if (!message) {
      void vscode.window.showWarningMessage('請先輸入提交訊息');
      return;
    }
    if (repo.stagedGroup.resourceStates.length === 0) {
      void vscode.window.showWarningMessage('沒有已暫存的變更可提交');
      return;
    }
    try {
      await runExclusive(repoPath, () => repo.svc.commitIndex(message));
      repo.sc.inputBox.value = '';
    } catch (err) {
      void vscode.window.showErrorMessage(`提交失敗：${err instanceof Error ? err.message : String(err)}`);
    }
    await this.refresh();
  }

  /** Group resources by repo and run fn per repo under that repo's lock. */
  private async runByRepo(
    resources: ScmResource[],
    fn: (repo: RepoScm, relPaths: string[]) => Promise<void>,
  ): Promise<void> {
    const byRepo = new Map<string, string[]>();
    for (const r of resources) {
      const list = byRepo.get(r.repoPath) ?? [];
      list.push(r.relPath);
      byRepo.set(r.repoPath, list);
    }
    for (const [repoPath, relPaths] of byRepo) {
      const repo = this.repos.get(repoPath);
      if (!repo) continue;
      await runExclusive(repoPath, () => fn(repo, relPaths));
    }
  }

  private findByControl(sc: vscode.SourceControl): [string, RepoScm] | undefined {
    for (const [repoPath, repo] of this.repos) {
      if (repo.sc === sc) return [repoPath, repo];
    }
    return undefined;
  }
```

並在檔案底部（`statusTooltip` 附近）新增：

```ts
/**
 * SCM resource-state commands receive the selected resources as varargs; a
 * multi-selection may arrive as a trailing array. Flatten to ScmResource[].
 */
function flattenResources(args: unknown[]): ScmResource[] {
  const out: ScmResource[] = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const x of a) if (isScmResource(x)) out.push(x);
    } else if (isScmResource(a)) {
      out.push(a);
    }
  }
  return out;
}

function isScmResource(x: unknown): x is ScmResource {
  return !!x && typeof x === 'object' && 'repoPath' in x && 'relPath' in x;
}
```

> 註：`RepoScm` 型別在 Task 2 是 module 內部 interface；`runByRepo`/`findByControl`/`stageAll` 直接參照它即可（同檔）。

- [ ] **Step 2: package.json 新增 commands**

在 root `package.json` `contributes.commands` 陣列末尾（`clipcode.blame.revealCommit` 之後）新增：

```json
      {
        "command": "snipcode.scm.stage",
        "title": "Snipcode Git: Stage Changes",
        "icon": "$(add)"
      },
      {
        "command": "snipcode.scm.unstage",
        "title": "Snipcode Git: Unstage Changes",
        "icon": "$(remove)"
      },
      {
        "command": "snipcode.scm.stageAll",
        "title": "Snipcode Git: Stage All Changes",
        "icon": "$(add)"
      },
      {
        "command": "snipcode.scm.unstageAll",
        "title": "Snipcode Git: Unstage All Changes",
        "icon": "$(remove)"
      },
      {
        "command": "snipcode.scm.commit",
        "title": "Snipcode Git: Commit",
        "icon": "$(check)"
      },
      {
        "command": "snipcode.scm.refresh",
        "title": "Snipcode Git: Refresh",
        "icon": "$(refresh)"
      }
```

- [ ] **Step 3: package.json 新增 scm menus**

在 root `package.json` `contributes.menus` 物件內新增以下三個鍵（`scm/title` 已存在——把 `snipcode.scm.*` 項目**追加**進既有 `scm/title` 陣列，不要新建重複鍵；`scm/resourceState/context` 與 `scm/resourceGroup/context` 為新鍵）：

在既有 `"scm/title"` 陣列末尾追加：

```json
        {
          "command": "snipcode.scm.commit",
          "when": "scmProvider == snipcodeGit",
          "group": "navigation@1"
        },
        {
          "command": "snipcode.scm.refresh",
          "when": "scmProvider == snipcodeGit",
          "group": "navigation@2"
        }
```

新增 `"scm/resourceGroup/context"`（group header 的 inline stage-all / unstage-all）：

```json
      "scm/resourceGroup/context": [
        {
          "command": "snipcode.scm.stageAll",
          "when": "scmProvider == snipcodeGit && scmResourceGroup == changes",
          "group": "inline"
        },
        {
          "command": "snipcode.scm.unstageAll",
          "when": "scmProvider == snipcodeGit && scmResourceGroup == staged",
          "group": "inline"
        }
      ],
```

新增 `"scm/resourceState/context"`（檔案列 hover 的 inline +/−；context menu 也帶）：

```json
      "scm/resourceState/context": [
        {
          "command": "snipcode.scm.stage",
          "when": "scmProvider == snipcodeGit && scmResourceGroup == changes",
          "group": "inline"
        },
        {
          "command": "snipcode.scm.unstage",
          "when": "scmProvider == snipcodeGit && scmResourceGroup == staged",
          "group": "inline"
        }
      ],
```

- [ ] **Step 4: 型別檢查 + build**

Run: `cd graph && npm run lint`
Expected: 無錯誤。

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`
Expected: `BUILD` 成功。

- [ ] **Step 5: 手動 F5 驗收（互動）**

F5 啟動 Extension Development Host，開一個含 git 變更的資料夾，開 Source Control 面板。預期：
- **hover「Changes」裡的檔案** → 右側出現 `+`（Stage Changes）；點它 → 該檔移到「Staged Changes」。
- **hover「Staged Changes」裡的檔案** → 右側出現 `−`（Unstage Changes）；點它 → 檔案移回「Changes」。
- **hover group header「Changes」/「Staged Changes」** → 出現 stage-all / unstage-all inline 按鈕，點擊整組搬移。
- **在該 repo 的 commit 訊息框輸入繁中訊息 → 按輸入框的 commit（Enter / 勾勾）** → 已 staged 的變更被提交，訊息框清空，Staged Changes 清空；未 staged 的仍留在 Changes。
- **provider title 列** 有 refresh 按鈕；改動磁碟檔後（或按 refresh）清單自動更新。
- **多 repo**：在含多個 repo 的 workspace，各 repo 各自一塊、各自一個訊息框、各自 stage/commit 互不影響。

- [ ] **Step 6: Commit**

```bash
cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode
git add graph/src/scm/snipcode-scm.ts package.json
git commit -m "為 Snipcode Git SCM 加上 stage/unstage/commit/refresh 命令與 menu 貢獻"
```

---

## Self-Review

**1. 使用者需求逐條覆蓋**

- **真實 git staging（非虛擬）**：Task 1 `stagePaths`/`unstagePaths`/`commitIndex` 走真 `git add`/`reset`/`commit`；本 plan 明確不用 D1 的乾淨-index / 虛擬勾選模型（`commitSelected` 保留但不再被載入）。✅
- **Staged / Unstaged 兩組**：Task 2 每 repo `createResourceGroup('staged', 'Staged Changes')` + `('changes', 'Changes')`，來源 `getUncommittedDiff()` 的 `staged`/`unstaged`。✅
- **每組按 repo 分 + branch 徽章**：Task 2 每 repo 一個 `SourceControl`（label = `Snipcode Git · <repo> (<branch>)`），branch 由 `branches()` 取得；branch 變更因 label readonly 而 dispose+recreate。✅（風險見下）
- **原生檔案類型圖示 + 彩色檔名**：Task 2 `resourceUri` 指實體檔、**刻意不設 `decorations.iconPath`**，讓原生檔案圖示 + 內建 git FileDecorationProvider 的顏色/徽章生效。✅（風險見下）
- **hover +/− stage/unstage**：Task 3 `scm/resourceState/context` group `inline`，用 `scmResourceGroup == changes/staged` 分辨方向。✅
- **每 repo commit 框 + commit**：Task 2 `sc.inputBox` + `acceptInputCommand`；Task 3 `commit` handler 讀 `inputBox.value`、`commitIndex`。✅
- **refresh on file/HEAD change**：Task 2 沿用既有 per-repo `FileWatcher` → `scheduleRefresh()`（300ms debounce）。✅
- **移除 B-2a webview 提交面板**：Task 2 移除 view/viewsContainer/provider 註冊並刪 provider 檔。✅

**2. Placeholder scan**：無 TBD/TODO 殘留於交付碼。唯一「placeholder」是 Task 2 步驟 2 刻意加的 `registerCommands` 空實作，並在 Task 3 步驟 1 明確以真身**取代**——這是為了讓 Task 2 能獨立編譯/驗收的過渡，非遺留占位。已在文中標明。

**3. 型別一致性**：`ScmResource`（`repoPath`/`relPath`/`staged`）、`RepoScm`（`baseName`/`svc`/`sc`/`stagedGroup`/`changesGroup`/`branch`）在 Task 2 定義，Task 3 的 `stage`/`unstage`/`stageAll`/`unstageAll`/`runByRepo`/`findByControl` 全部沿用同名欄位。git-service 方法名 `stagePaths`/`unstagePaths`/`commitIndex` 在 Task 1 定義、Task 3 呼叫一致。`git.openChange`、`scmProvider == snipcodeGit`、`scmResourceGroup == staged/changes` 三個 context key 與 SourceControl id / group id 對齊。

**4. 移除了什麼 / 延到 B-2b 什麼**

- 移除（註冊層）：`snipcode.commitWorkbench` view、`snipcode-commit-workbench` viewsContainer、`CommitWorkbenchViewProvider` 註冊與檔案。
- 保留但不再載入（B-2b 複用）：`workbench-status.ts`、`commit-across-repos.ts`、`workbench-messages.ts`、`git-service.commitSelected`（D1 逐-hunk）、webview 端 workbench bundle。
- 延到 B-2b：逐 hunk 勾選 / hunk-level stage、內嵌自訂 diff、「⧉ 複製成 ClipCode」、單一共用跨-repo commit 框、動態 repo 增減時 SourceControl 即時 re-wiring。

**5. 需實作者在 F5 驗證的不確定點（vscode.scm 實際行為）**

- **彩色檔名/狀態徽章是否自動出現**：本 plan 賭「內建 git FileDecorationProvider 會依 `resourceUri` 對我方 SCM resource 上色/加徽章」。此為全域、以 URI 為 key 的 decoration，理論上跨 provider 生效；但若內建 Git 擴充被停用、或該 repo 未被內建 git 追蹤，檔名可能不上色（原生**檔案類型圖示**仍在）。若 F5 發現沒顏色，備援：在 `toResource` 設 `decorations.iconPath` 為帶 `ThemeColor('gitDecoration.*ResourceForeground')` 的 `ThemeIcon`（但那會蓋掉原生檔案類型圖示，需權衡）。
- **`git.openChange` 是否吃我方 `resourceUri`**：內建命令是為內建 git 的 resource 設計，傳純 `Uri` 多數版本可開 working-tree diff，但非公開契約。若某版本無效，備援用 `vscode.diff`（HEAD gitfs URI vs 檔案）或先降級為 `vscode.open`。B-2b 會用自訂 diff 取代。
- **branch 變更時 dispose+recreate SourceControl 的閃爍**：label readonly 迫使 recreate；branch 切換不頻繁，可接受。若實作者覺得閃爍礙眼，替代方案是不把 branch 放 label（改放 group label 或 `statusBarCommands`），但那較不像「徽章」。
- **SCM 命令 varargs 形狀**：`stage`/`unstage` 以 `flattenResources` 容錯處理「單一 resource」與「多選陣列」兩種傳參形狀；不同 VS Code 版本傳法略異，F5 需實測多選 stage 是否整批生效。
- **同 id `snipcodeGit` 多 SourceControl**：比照內建 git（全 repo 共用 id `git`）應可行且讓 `scmProvider == snipcodeGit` 一次涵蓋全 repo；F5 確認多 repo 各自區塊正確堆疊。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-11-commit-workbench-native-scm.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每個 Task 派一個新 subagent，Task 間 review，快速迭代。

**2. Inline Execution** — 在本 session 依 executing-plans 批次執行、以 checkpoint 供 review。

**Which approach?**
