# ClipCodeVSCode PR 面板 — 設計

日期:2026-07-02
狀態:已批准(對稱 ClipCode IntelliJ 版移植)

## 目標
在 Snipcode(ClipCodeVSCode)加一個 PR 面板,與 ClipCode IntelliJ 版等價:
1. 選 base ref,看目前分支 `base..HEAD` 的變更檔(等同一個 PR 的內容)。
2. 勾選檔案,用既有 ClipCode 剪貼簿格式複製到剪貼簿。
3. 檢查 remote,提醒目前分支相對 origin 是否落後(behind N)。

## 範圍決定
- **純本地 git,自己 spawn git CLI**(仿 `extension.ts` 既有的 `readCommittedBatch` spawn 模式)。不接 GitHub API;不碰 vendored `graph/` 的 GitService(它是獨立 build 邊界,host 無法乾淨 import)。
- `base..HEAD` 用 two-dot 語意(`git diff --name-status <base> HEAD`),與 ClipCode 的 `GitChangeUtils.getDiff(base, HEAD)` 一致。兩邊要改 three-dot 就一起改。
- **複製複用 `buildGraphCopyPayload`**(hash = `'HEAD'`):它已讀 content、處理 DELETED marker、size/count limit、套 ClipCode 格式。PR 面板只把 diff 結果轉成 `GraphCopyFile[]`。格式契約與跨工具相容完全不動。
- base ref 預設:當前分支 upstream → `origin/main` → `origin/master`;使用者可改選。

## UI 映射(IntelliJ → VS Code 慣例)
| ClipCode(IntelliJ) | ClipCodeVSCode |
|---|---|
| Tool Window | TreeView `clipcode.prPanel`(SCM 容器,clone `HistoryTreeProvider` 模式) |
| base ref 下拉 | view/title 按鈕 `clipcode.pr.selectBase` → `QuickPick` |
| remote 新鮮度 banner | `treeView.message`(TreeView 原生頂部訊息區) |
| 檔案清單 + checkbox | TreeView 檔案樹 + 原生 `TreeItem.checkboxState`(預設全勾) |
| Copy 按鈕 | view/title 按鈕 `clipcode.pr.copyAll` + 右鍵 `clipcode.pr.copySelected` |
| Fetch / Refresh | view/title toolbar 按鈕 `clipcode.pr.fetch` / `clipcode.pr.refresh` |

## 資料流(複用為主)
```
選 base ref / Refresh
  └─ 背景:BranchDiffProvider.remoteStatus(doFetch)  ← 先 fetch(靜默),再算 ahead/behind
  └─ 背景:BranchDiffProvider.diffNameStatus(base)   ← git diff --name-status base HEAD
  └─ treeView.message = banner(依 remoteStatus)
  └─ 建檔案樹(clone historyTree)+ checkbox 全勾
Copy(勾選檔)
  └─ 轉成 GraphCopyPayload{hash:'HEAD', files: GraphCopyFile[]}
  └─ buildGraphCopyPayload(makeGraphCopyDeps(...))   ← 完全複用,格式不變
  └─ vscode.env.clipboard.writeText(result.text)
```

## 新增檔案(host `src/`)
- `src/branchDiff.ts` — spawn git CLI:`diffNameStatus(base)`、`remoteStatus(doFetch)`、`candidateBaseRefs()`;純函式 `parseNameStatus`、`parseAheadBehind`(單元測試,對稱 ClipCode)。
- `src/prCopyService.ts` — 純函式:`toGraphCopyPayload(diffFiles, selectedPaths): GraphCopyPayload`(hash `'HEAD'`),薄 glue 呼叫 `buildGraphCopyPayload` + 寫 clipboard。可測。
- `src/prTreeProvider.ts` — `TreeDataProvider`(clone `historyTreeProvider.ts` + `historyTree.ts` 樹建構,加 checkbox)。
- `src/prPanelView.ts` — `registerPrPanel(context)`(clone `historyView.ts`):QuickPick base、fetch、refresh、copy commands、`treeView.message` banner、generation guard(對稱 ClipCode 修過的 race 保護)。
- `package.json`(contributes:view `clipcode.prPanel`、commands、menus)+ `src/extension.ts`(呼叫 `registerPrPanel`)。

## 學到的教訓(從 ClipCode 版 codex 複查納入,一開始就做對)
- **fetch/diff 順序**:remoteStatus(含 fetch)必須在 diffNameStatus 之前算,否則 diff 用 fetch 前的舊 ref。
- **並發 reload race**:用 generation 計數器,onSuccess/apply 前檢查 generation 與當前 base 一致才更新 UI。
- **fetch 狀態語意**:`fetched=false` 不可兼指「失敗」與「未嘗試」;加 `fetchAttempted`,offline 提示只在 `fetchAttempted && !fetched`。
- **remote ref 名稱**:用完整 `origin/xxx`(不是去前綴的 `xxx`),否則 rev-list/diff 解析成 local 分支。

## 錯誤處理
無 git repo / 無 origin upstream / 離線 fetch 失敗 / 空 diff:各自安全降級,不丟例外,banner/清單顯示對應訊息。

## 測試
`node --test`(host):`parseNameStatus`、`parseAheadBehind`、banner 格式化、`toGraphCopyPayload` 純函式寫單元測試(對稱 ClipCode 策略)。TreeView/git-spawn 整合靠既有 e2e 或手動 VS Code 實測(此 headless 環境無法跑真 VS Code)。
