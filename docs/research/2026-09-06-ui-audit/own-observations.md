# 我自己從截圖 + 程式碼看到的（已驗證）

## 已驗證的 Agent P0 主張
- Diff P0-1 ✔ `graph/webview-ui/src/diff.ts` 無 `import './styles/global.css'`；`dist/graph-webview/diff.css` 中 `--text-secondary` 用 12 次/定義 0、`--border-color` 9/0、`--bg-secondary` 2/0、`--bg-primary` 1/0。
- Sidebar P0-2 ✔ root `package.json` 無 `"l10n"`（只有 graph/package.json:35）；`.vscodeignore:25` 排除 `graph/l10n/**`；vsix 內 l10n 檔數 = 0。
- Sidebar P0-1 ✔ `graph/src/extension.ts:207-210` registerWebviewViewProvider 無 `retainContextWhenHidden`。
- PR P0-1 ✔ `PrView.svelte:273-278` effect 只清 `awaitingBranches`，不重載。
- Diff P0-2 ✔ `git-parser.ts:293-300` 無 `\` 行處理（471/480 是路徑 unescape）。

## 自己發現：Uncommitted 節點懸空、不接 HEAD（線圖 P0 級）
- `MainPanel.ts:149` 與 `git-service.ts:834` 都是 `parents: []` → SourceGit 演算法把它當 root：dot 落在 lane 0、沒有任何線。
- 截圖 graph-dark.png：虛線圈在 x≈10（lane 0），正下方是藍色 feature/very-long lane；HEAD develop 在 lane 1（綠）。看起來像 uncommitted 屬於 feature/very-long。
- 修法：parents 改為 `[HEAD hash]` → 演算法會從 uncommitted 拉一條線到 HEAD，且 HEAD 分支會佔 lane 0（順帶達成 JetBrains 的「current branch 靠左」，至少在有未提交變更時）。需查 MainPanel.test 對 UNCOMMITTED 的斷言。

## 截圖觀察（graph-dark / 2x / light / narrow）
- 車道很窄（4 條 lane 約 50px）；線 2px、點 r4；光暈（5px @ 0.07）在 dark/light 都看不出來 → 白畫。
- HEAD 列沒有整列底色，只靠綠色 bold badge + 空心點辨識。
- 非當前分支的列文字 0.6 淡化 OK，但**線**沒有淡化，五條線一樣亮。
- current branch (develop) 在 lane 1，main 在 lane 3-4（最右）；lane 順序 = log 順序，main 不靠左。
- local-only 小點（•）在 message 前，極小、與 badge 色相同 → 幾乎看不見。
- tag 色 `#f0c040` 與 palette 的 `#ffc53d`/`#faad14` 近似。
- Author 欄 120px 截斷「Bob Martí…」；Date 「2026-08-02 PM 3:22」格式怪（zh-TW locale 產物）+ 150px。
- Toolbar 兩列：第一列 repo pill / branch pill / Graph Reflog Stats PR / 圖示；第二列 search + 定位 icon + Source ▾ + Branch ▾（filter）。
- Details：Commit tab 只有 author/SHA/parents/message，files 在另一個 tab（Changes 9），要多點一下才看到改了什麼；avatar 佔空間（無網路時空圓）。
- Diff tab：無檔案標頭（路徑/狀態）；Staged/Unstaged badge 同灰色；Inline/SBS 切換極小；stage chevron 在中央 gutter；大量空白。
- Workbench（commit box 320px）：3 行 textarea + Commit/Amend，無 repo 數、無字數、無 Commit & Push。

## 已驗證：builder 短 hash 對全長 hash（潛在 bug + 死碼）
- `git-service.ts:886` `parseBranches` 用 `%(objectname:short)` → `BranchInfo.hash` 7 碼；`git-graph-builder.ts buildUpstreamMap` 把它拿去和 `commit.hash`（%H 全長）比、查 `hashIndex`。
- fixture：42 個 dot 中 34 個 `remoteTip:true`（含 develop 整條祖先），明顯錯。
- 目前無可見症狀：`CommitGraph.svelte:1517` `isRemoteTip` 未使用；builder 內 `remoteTipSet` 只影響 merge-parent 繪製且條件恆真。
- 意義：graph 的 remote-only/local-only 視覺標示（虛線點）在 builder 層其實是壞的、且沒接到 UI；CommitGraph 自己另算 `currentBranchRemoteAhead` / `currentBranchLocalOnly`（只針對目前分支）。要做「remote-only 段落可辨」必須先修這個。

## 量測（render agent）
- Toolbar 44px、列 30px、graph SVG 寬 86px（6 lane）、車道 12.6px、線 2px(.85)+5px(.07)、點 r4/head r5/merge r4+r2、badge 12.35px 字/21px 高、subject 起點 x=22.9、BottomPanel 285px(35%)。
- `--row-height/--lane-width/--graph-node-radius/--toolbar-height/--bottom-panel-height` 全是 dead CSS vars，沒有元件讀。
- ref-badge 無 max-width：超長分支名不截斷，反而擠掉 subject。
- details 面板日期 `toLocaleString()` 與 graph 欄格式不一致。
