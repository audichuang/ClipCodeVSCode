# Snipcode Git 工具列：一鍵 Fetch / Pull / Push（全部 repo）＋ 樹上 ↓↑ 狀態

日期：2026-07-13　狀態：已採納（方案 A）　分支：improve/unified-staged-diff

## 動機

Snipcode Git 側欄（`snipcode-git` 容器）目前只有 Changes 樹＋Commit box。使用者要
IntelliJ 風格的基礎操作：一鍵 fetch、看得出「有新東西該 pull」、push、以及進階
操作（rebase／merge／分支管理）的入口——不搬 SCM 容器裡既有的
Branches/Remotes 樹，只在 Snipcode Git 這一塊補「最簡單夠用」的操作面。

## UX

`snipcode.changes` view 標題列新增 4 顆按鈕（`view/title`，`navigation` 群組）：

| 按鈕 | 命令 | 行為 |
|---|---|---|
| $(cloud-download) Fetch | `snipcode.git.fetchAll` | 對 workspace 全部 repo 依序 `git fetch --prune` |
| $(arrow-down) Pull | `snipcode.git.pullAll` | 全部 repo `git pull`（不帶參數；尊重各 repo `pull.rebase` 設定） |
| $(arrow-up) Push | `snipcode.git.pushAll` | 全部 repo `pushCurrentBranch()`（無 upstream 時 push 並 `--set-upstream`；無 remote 回報略過） |
| $(git-branch) Graph | 既有 `gitGraphPlus.open` | 進階操作入口（rebase、merge、建分支、tag…graph 已有完整 UI） |

Changes 樹的 **repo 節點** `description` 從「分支名」擴充為「分支名 ↓behind ↑ahead」：

- `main ↓3 ↑1`；為 0 的一側省略（`main ↓3`、`main ↑1`）；兩者皆 0 或無
  upstream → 只顯示分支名（現狀）。
- 資料在 `loadStatus()` 每 repo 順帶取得，fetch/pull/push 完成後的 `refresh()`
  自然更新。

## 實作

### GitService（graph/src/git/git-service.ts，SNIPCODE-HOOK 圍欄）

```ts
/** 目前分支相對 upstream 的 ahead/behind；無 upstream 或 detached 回 null。 */
async aheadBehind(): Promise<{ ahead: number; behind: number } | null>
```

`git rev-list --left-right --count @{upstream}...HEAD` → `behind\tahead`；
失敗（無 upstream / detached / 空 repo）→ null。唯讀命令，不進 mutation lock。

### ChangesWorkbench（graph/src/tree/changes-workbench.ts）

```ts
async fetchAll(): Promise<void>   // 同型：pullAll / pushAll
```

- repo 清單來自既有 `discover()`。
- 逐 repo：`runExclusive(repoPath, () => svcFor(repoPath).fetch(undefined, { prune: true }))`
  （pull/push 同型；fetch/push 為網路操作，GitService 本就不對其上 mutation lock，
  `runExclusive` 只是避免與本套件其他排隊操作交錯）。
- `vscode.window.withProgress`（location: Notification）逐 repo 報進度
  「Fetching <name> (i/n)…」。
- **單一 repo 失敗不中斷**：收集 `{repo, error}`，全部跑完後一次
  `showErrorMessage`：「Fetch：2/3 成功；<repo>: <原因>」。全成功時
  `setStatusBarMessage` 短暫提示，不彈通知。
- 結束後 `await this.refresh()`（Changes 樹＋↓↑）。graph 面板不必手動通知——
  file-watcher 監看 `.git` 變化本就會觸發它自動刷新。
- 註冊三個命令於既有 `reg()` 清單。

### 樹狀態（build-change-tree.ts / changes-tree.ts）

- `RepoStatus` 加 `ahead?: number; behind?: number`（`loadStatus()` 以
  `aheadBehind()` 填入；null → 兩欄 undefined）。
- `RepoNode` 帶過去；`changes-tree.ts` repo 節點：
  `description = branch + (behind ? ' ↓'+behind : '') + (ahead ? ' ↑'+ahead : '')`。

### package.json（root）

- `contributes.commands` ＋3（含 icon 與 `category: "Snipcode Git"`）。
- `menus."view/title"`：4 個 entry，`when: "view == snipcode.changes"`，
  `group: "navigation@1..4"`（Graph 用既有命令 id，僅加 menu entry）。

## 錯誤處理

- 個別 repo 失敗：彙總報告（見上），不中斷其他 repo。
- 0 個 repo：`showInformationMessage('No git repositories in workspace')`。
- pushCurrentBranch 回 `{ pushed: false, reason: 'no-remote' }` → 計入略過清單，
  訊息註明「<repo>: 無 remote，已略過」。
- `aheadBehind()` 任何失敗一律回 null——狀態顯示絕不能弄壞 Changes 樹本體
  （try/catch 包住，樹照畫、只是不顯示箭頭）。

## 測試

1. **真 git 整合**（`git-service` integration）：`aheadBehind()`——有 upstream 領先/落後各若干、無 upstream → null、detached → null。
2. **workbench 單元**（mock svc）：`fetchAll` 對多 repo 全部呼叫；一個 repo reject 時其餘照跑且彙總錯誤；結束呼叫 refresh。`pushAll` 的 no-remote 略過路徑。
3. **樹渲染**：repo 節點 description 的四種組合（↓↑、只 ↓、只 ↑、無）。
4. 全套 vitest ＋ tsc ＋ svelte-check（webview 無改動，僅回歸）。

## 不做（YAGNI）

- 不搬 Branches/Remotes/Tags/Stashes 樹（留在 SCM 容器）。
- 不做底部狀態列分支 widget。
- 不做 per-repo inline fetch 按鈕（先驗證全部 repo 夠不夠用）。
- 不做 pull 的 merge/rebase 選項 UI（尊重 git 設定；要細控去 graph modal）。
- 不做自動輪詢 fetch（graph 已有 auto-fetch timer，不重複）。
