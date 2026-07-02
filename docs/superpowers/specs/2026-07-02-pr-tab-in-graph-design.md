# Git Graph+ 「PR」tab 設計(取代 SCM TreeView)

日期:2026-07-02
狀態:已批准

## 目標
把 PR 功能從 SCM 側邊的 TreeView(0.3.22 發的 `clipcode.prPanel`)搬進 **Git Graph+ webview 的第 4 個 tab**(Graph / Reflog / Stats / **PR**),體驗對齊 GitHub「New pull request」頁:選 base(`<base> into <current>`)、看 Files + Commits、看 diff、複製成 ClipCode 格式。

## 使用者已定的決策
1. **PR tab 取代 TreeView**(不並存)。
2. **完整**:Files + Commits + 落後提示(像 GitHub New PR)。

## 移除(被取代的舊功能)
- `src/prPanelView.ts`、`src/prTreeProvider.ts`
- `src/branchDiff.ts`、`src/prCopyService.ts`(TreeView 專用;graph tab 改用 graph 的 GitService)
- `package.json`:`clipcode.prPanel` view + `clipcode.pr.*` commands + 對應 menus + activation
- `src/extension.ts`:`registerPrPanel` 呼叫 + 相關 export(若僅供 PR 面板用)
- 對應測試:`test/branchDiff.test.ts`、`test/prCopyService.test.ts`

## 新增:Git Graph+ PR tab

### Webview(`graph/webview-ui/`,全部包 `/* SNIPCODE-HOOK start … end */`)
- `src/lib/stores/ui.svelte.ts`:`viewMode` union 加 `'pr'`(:14),`setViewMode`(:155)
- `src/components/layout/Toolbar.svelte`:在 tab 群(:157-181)加第 4 個 `<button class="view-tab">` PR;i18n key `toolbar.pr`(`lib/i18n/en.ts`+`ko.ts`+`zh.ts`)
- `src/App.svelte`:view router(:458-509)加 `{:else if uiStore.viewMode === 'pr'}<PrView/>`;可加 Ctrl+4(:244-246)
- **新** `src/components/pr/PrView.svelte`:
  - **base-ref 下拉**:資料來自 `branchStore.branches`(`lib/stores/branches.svelte.ts`),markup 仿現有 `.repo-dropdown`(Toolbar.svelte:104-153)。顯示 `<base> into <current-branch>`(current 來自 `branchStore.currentBranch`)。
  - **落後提示橫幅**:相對 base 的 ahead/behind。用現有 `branches()` 的 current branch `behind`/`upstream`(相對 upstream)顯示「落後 origin N,建議 pull」;若要相對「選定 base」的精確計數,見下方 host `commitsBetween` 可回傳兩向計數。
  - **子 tab Files / Commits**(預設停 Files):
    - **Files**:選 base → post `{type:'compareCommits', payload:{ref1:<base>, ref2:'HEAD'}}` → 收 `commitDiffData`(`files[]` + `diffs`)→ 檔案樹(複用 `CommitDetails` 的 `buildFileTree`/`FileTreeBrowser` 模式或自渲染 `files[]`);點檔 → `{type:'openDiff', payload:{file, ref1:<base>, ref2:'HEAD'}}`。**Copy** 按鈕:把 `files[]` 轉 `{repoRootFsPath, relativePath, oldRelativePath, status}` → post `{type:'snipcodeCopyFullSource', payload:{hash:'HEAD', files}}`(複用 CommitDetails.svelte:512-524 的 `snipcodeCopyFiles` 模式)。
    - **Commits**:post 新的 `{type:'getCommitsBetween', payload:{base, head:'HEAD'}}` → 收 commit 列表渲染。

### Host(`graph/src/`,SNIPCODE-HOOK)— 只為 Commits 列表 + 精確落後計數
- `git/git-service.ts`:新 `commitsBetween(base, head)` → `git log <base>..<head>`(需自建,`log()` 的 `assertSafeRef` 擋 range)。可順帶回 ahead/behind(`git rev-list --left-right --count base...head`)供橫幅。
- `utils/message-bus.ts`:`WebviewMessage` 加 `getCommitsBetween`(:29-149);`ExtensionMessage` 加回應 variant(:152-209)。
- `panels/MainPanel.ts`:新 `case 'getCommitsBetween'`(仿 `getMultiCommitSections` :530-541)。

## 複用(零改動)
`compareCommits`/`diffFiles`/`diffCommits`/`commitDiffData`(Files+diff between base 與 HEAD)、`snipcodeCopyFullSource` → `MainPanel.copyFullSourceAtCommit` → 父層 `src/graphCopy.ts`(ClipCode 格式契約**不動**)、`getBranches`/`branchData`(base 清單)、`openDiff`(單檔 native diff)。

## 三-dot 語意
Files/Commits 用 **three-dot**(`base...HEAD` = merge-base..HEAD)與 IntelliJ 端一致。`compareCommits` 目前是 `diff ref1 ref2`(two-dot);PrView 送 ref 時改送 merge-base,或 host 端 compareCommits 對 PR 用途改 three-dot。**實作時以 three-dot 為準**(見 plan)。

## 錯誤處理
無 repo / 無選 base / 空 diff / base 解不出:安全降級,PrView 顯示對應訊息,不炸 webview。

## 測試
- Host:`commitsBetween` 純解析 + graph vitest(`cd graph && npx vitest run`)。
- 移除 TreeView 後 host `npm test` 仍綠(移除對應測試檔)。
- Webview UI:靠 graph 既有測試 + 手動(F5)——headless 無法跑真 webview。

## 發布
下個 patch **0.3.23**。動到 `graph/` 必跑 `cd graph && npx vitest run` + 根 `npm test`。
