審查完成。以下為完整報告（純程式碼層級推導，未改任何檔案、未跑任何渲染）。

---

# Snipcode 側邊欄 UX 審查報告（v0.3.42）

## 1. 現況描述：目前側邊欄長什麼樣

```
Activity Bar
├─ [Source Control]（VS Code 內建 SCM 容器）— 內含 7 個 view
│   ├─ Source Control（內建 vscode.git）
│   ├─ Snipcode History ─ <repo>            ← 標題會被程式改寫（historyView.ts:36）
│   │   └─ <commit 第一行>   <7 位 hash>     icon git-commit（Collapsed）
│   │       └─ <壓縮後資料夾 a/b/c>          ThemeIcon.Folder（Expanded）
│   │           └─ [MODIFIED] Foo.ts   <relPath>   resourceUri 給檔案 icon
│   │       └─ Load More…
│   ├─ Branches   (description = repo 名)   "visibility": "visible"
│   │   ├─ main            ✓ icon, description "current ↑1 ↓2"   ← 點擊跳 QuickPick
│   │   ├─ develop         git-branch icon
│   │   └─ feature/  (folder, Collapsed) → x, y   （以 / 切資料夾，只顯示最後一段）
│   ├─ Remotes    (description = repo 名)
│   │   └─ origin  (cloud icon, Collapsed, tooltip = fetch/push URL)
│   │       └─ main, develop…（去掉 origin/ 前綴）              ← 點擊跳 QuickPick
│   ├─ Tags       → v1.2.0   <7 位 hash>  tag icon                ← 點擊跳 QuickPick
│   ├─ Stashes    → stash@{0}   <message>  archive icon           ← 點擊跳 QuickPick
│   └─ Worktrees  → main (main) / feature-x   ./path  home|worktree|lock icon
│
└─ [Snipcode Git]（自訂容器 images/snipcode-git.svg：一條線上的圓點）
    ├─ Changes  ← 標題列 9 個 icon：filter, +all, −all, refresh, fetch, pull, push, graph, collapse-all
    │   ├─ ✓ Staged   3                       （永遠顯示，即使 0）
    │   │   └─ ☑ repo-a   main ↓2 ↑1          icon repo；只有 Staged 側有 checkbox
    │   │       ├─ Foo.ts   src/components     檔案 icon 由 resourceUri；顏色/字母完全靠 vscode.git
    │   │       │            inline: [−] [go-to-file]；右鍵只有「Copy as ClipCode」
    │   │       └─ Bar.ts   src                點擊 → Snipcode Diff tab（DiffPanel.show）
    │   └─ ⧉ Unstaged 5
    │       └─ repo-a   main ↓2 ↑1            同一 repo 再出現一次，branch/badge 重複
    │           ├─ Foo.ts   src/components     （MM 檔會同時出現在兩側）
    │           ├─ new.ts   ""                 untracked → status 'U' 混在 Unstaged
    │           └─ vendor-lib   ""             巢狀 repo 目錄 → status 'N'，外觀與一般檔案無異
    └─ Commit（webview，排在 Changes 之下）
        ├─ [banner：錯誤 / 已提交 N 個 repo]
        ├─ textarea rows=3  placeholder「Commit 訊息（共用一則，套用到所有已暫存的 repo）」
        └─ [✓ Commit（主色，撐滿）] [Amend（次色）]
```

Status bar 右側另有一個 `$(git-merge)` 項目，tooltip 為 `'Git Graph+ - ' + vscode.l10n.t('clickToOpen')`（`graph/src/views/status-bar.ts:14`）。

檔案節點沒有任何 `tooltip`；`FileNode.status`（M/A/D/R/C/U/N）算出來了但**沒有任何地方渲染**（`graph/src/tree/changes-tree.ts:92-100`）。

---

## 2. Findings（依嚴重度）

圍欄註記：`graph/src/tree/*` 是 Snipcode 自有檔但位於 vendored `graph/` 內，依 `graph/AGENTS.md` 仍要 `SNIPCODE-HOOK` 圍欄；`graph/src/views/*`、`graph/src/extension.ts`、`webview-ui/src/lib/i18n/*.ts` 是上游檔，必須圍欄；root `package.json`、`.vscodeignore`、root `src/` 不需圍欄。

### P0

**P0-1 Commit 草稿在 view 隱藏時直接遺失**
- 證據：`graph/src/extension.ts:207-210` `registerWebviewViewProvider(viewType, provider)` 沒有傳 `{ webviewOptions: { retainContextWhenHidden: true } }`；`graph/webview-ui/src/workbench/messaging.ts:8-9` 宣告了 `getState/setState` 卻從未呼叫。WebviewView 在切到其他 Activity（Explorer）或收合時會被銷毀 → 打了一半的訊息消失。
- 建議：最省 = extension.ts 加 `webviewOptions.retainContextWhenHidden: true`（1 行，圍欄）。較正規 = `postCommit` 之外在 `message` 變動時 `vscode.setState({message})`，boot 時 `getState()` 還原（約 5 行，webview 端）。
- 成本：極低。

**P0-2 出貨版的 host 端 l10n 完全沒載入 → 通知/tooltip 顯示原始 key**
- 證據：root `package.json` **沒有** `"l10n"` 欄位（只有 `graph/package.json:35` 有，但那不是出貨 manifest）；`.vscodeignore:25` 明確排除 `graph/l10n/**`；`unzip -l clipcode-vscode-0.3.42.vsix | grep l10n` 為空；`dist/extension.js` 內含 key 字串 `changesStashed`×3、`checkedOut`×2、`clickToOpen`×1。`MainPanel.ts:824,826,850,859` 與 `status-bar.ts:14` 都是 **key 風格** `vscode.l10n.t('checkedOut', ref)`，沒有 bundle 時 VS Code 原樣回傳 → 使用者在側邊欄 checkout 後看到 toast「checkedOut」、status bar tooltip「Git Graph+ - clickToOpen」。（`extension.ts:99` 那種傳英文整句的用法只會退化成英文，不受影響。）
- 建議（三段缺一不可）：① root `package.json` 加 `"l10n": "./graph/l10n"`；② `.vscodeignore` 移除 `graph/l10n/**`；③ 新增 `graph/l10n/bundle.l10n.zh-tw.json`（zh-TW locale 不會 fallback 到 zh-cn）。
- 成本：純設定 + 一份 JSON 翻譯。無程式碼。

**P0-3 衝突檔被當成「可提交的 Staged 檔」呈現，且 'U' 字母與 untracked 撞名**
- 證據：`graph/src/git/git-service.ts:966-968`：`x !== ' ' && x !== '?'` 就進 staged、`y` 同理進 unstaged → `UU/AA/DD/AU/UA/DU/UD` 全部同時進 Staged 與 Unstaged，status 為 `'U'`（與 968 行 untracked 的 `'U'` 相同）。`build-change-tree.ts:90-92` 只有兩個 group，沒有 conflict 概念。結果：衝突 repo 的 checkbox 預設勾選 → 按 Commit → git 回「unmerged files」錯誤，只以 banner 文字呈現，使用者不知道哪個檔在衝突。VS Code 內建有「Merge Changes」群組，IntelliJ 有紅色 Conflicts 節點。
- 建議：在 `getUncommittedDiff`（已在 HOOK 內）把 unmerged 組合歸到第三個 `conflict` 陣列；`ChangeGroup` 加 `'conflict'`；`buildChangeTree` 多回一個「Merge Conflicts」group（icon `warning`，顏色 `gitDecoration.conflictingResourceForeground`）；`contextValue = file-conflict` 不給 stage inline，只給 Open + 「Mark Resolved」（= stagePaths）；commit 前若該 repo 有 conflict 直接以 view.message 提示。更新 `graph/src/tree/__tests__/build-change-tree.test.ts`。
- 成本：新程式碼約 40-60 行，圍欄。

### P1

**P1-1 沒有任何 Discard / Rollback 動作**
- 證據：`changes-workbench.ts:405-442` 註冊的命令中沒有 discard；`git-service.ts` 只有 `restore --source=stash`（:2766），沒有 working-tree 還原方法。IntelliJ 的 Rollback 與 VS Code 的 Discard Changes 都是核心動作。
- 建議：GitService 加 `discardPaths(paths)` = `git restore --worktree --` + untracked 用 `clean -f --`（走 `withMutationLock`）；命令 `snipcode.git.discard` 用 `showWarningMessage({modal:true})` 確認；package.json inline `discard` icon 於 `file-unstaged`。
- 成本：新程式碼中等，圍欄。

**P1-2 檔案的狀態字母 / 顏色完全外包給 vscode.git，且 `status` 從未顯示**
- 證據：`changes-tree.ts:96` 只靠 `resourceUri`（`file:` scheme）讓 vscode.git 的 decoration 上色；沒有 `tooltip`。vscode.git 只裝飾它自己開啟的 repo（`git.repositoryScanMaxDepth` 預設 1、`git.autoRepositoryDetection`、`git.decorations.enabled`），而 Snipcode 的 `RepoDiscoveryService` 掃到深度 3 + submodule → 深層 repo 的檔案在樹裡**無字母無顏色**。同一個 MM 檔在 Staged 側也會拿到 working-tree 的顏色（vscode.git decoration 後寫入者勝）。
- 建議：註冊自己的 `FileDecorationProvider`，`resourceUri` 改用自訂 scheme（例：`snipcode-change:///<abs path>?status=M&group=staged`）——icon theme 仍照檔名解析圖示、`item.command` 已存在所以不需要 `file:` scheme；badge 用 M/A/D/R/C/U/!，顏色對應 `gitDecoration.{modified,added,deleted,renamed,untracked,conflicting}ResourceForeground`（staged 側可用 `stageModified/stageDeleted`）；同時補 `tooltip = "<path>\n<Modified> (staged)"`。
- 成本：新檔約 50 行 + changes-tree.ts 幾行，圍欄。

**P1-3 每個 repo 底下是純平面清單：無目錄分組、無壓縮、無 tree/flat 切換**
- 證據：`changes-tree.ts:61` repo 直接回 `node.files`；`:94` 以 `description = dirname` 代替層級。50 個檔時可讀性差。VS Code SCM 有「View as Tree」，IntelliJ 預設目錄樹 + 壓縮；root `src/historyTree.ts:53-61` 已有 `compress()` 單鏈壓縮可直接借用。
- 建議：`build-change-tree.ts` 在 repo 下多一層 `dir` 節點（沿用 compress 邏輯），context key `snipcode.changes.viewAsTree` + 兩個 `view/title` 命令（icon `list-tree` / `list-flat`）互斥顯示。
- 成本：新程式碼中等，圍欄；更新 build-change-tree.test.ts。

**P1-4 untracked 與巢狀 repo 目錄混在 Unstaged，且被 Stage All 一併 `git add`**
- 證據：`git-service.ts:968` `??` → `'U'`/`'N'` 推進 unstaged；`stagePaths`（:2370-2375）不過濾 → `stageAll`/`stageRepo` 對 `'N'` 目錄執行 `git add` 會建立 embedded gitlink（git 只警告不阻止）。VS Code 有「Untracked Changes」群組，IntelliJ 有「Unversioned Files」。
- 建議：最低限度 1 行：`stageAll`/`stageRepo`/`sameGroup` 過濾 `status==='N'`，`'N'` 節點改 icon `repo` + description `(nested repo)`；完整版：第四個 group「Untracked」。
- 成本：低（過濾）/ 中（分組），圍欄。

**P1-5 右鍵選單幾乎是空的**
- 證據：package.json `view/item/context` 對 `snipcode.changes` 只有 `inline` 群組的 stage/unstage/open 與 `navigation@10` 的 Copy as ClipCode；`inline` 群組的項目**不會**出現在右鍵選單 → 右鍵一個檔案只看到「Copy as ClipCode」。
- 建議：在 package.json 為同一批命令再加一組非 inline 的項目：`1_stage`(Stage/Unstage)、`2_open`(Open File / Show Diff / Open Changes)、`3_discard`、`9_copy`。
- 成本：純 package.json。

**P1-6 inline「Open in Editor」（go-to-file icon）其實開的是 VS Code 原生 diff**
- 證據：`changes-workbench.ts:300-307` 執行 `git.openChange`，失敗才 `vscode.open`。標題與 icon 都說「開檔」，行為卻是第二套 diff（與 Snipcode Diff tab 並存）。
- 建議：改成 `vscode.open`（1 行）；原生 diff 若要保留，放右鍵「Open Changes (VS Code)」。
- 成本：極低，圍欄。

**P1-7 Command Palette 污染 + 無參數呼叫會拋 TypeError**
- 證據：package.json 沒有 `menus.commandPalette`。需要節點參數的命令（`snipcode.git.stage/unstage/stageRepo/unstageRepo/openChange/showDiff/copyAsClipCode`、`gitGraphPlus.show*Menu`、`clipcode.history.loadMore`）都會出現在 palette；`changes-workbench.ts:414-418` `clicked.repoPath` 在 `n===undefined` 時 TypeError，`:430` `stageRepo(undefined)` 同理。標題前綴三套：「Snipcode:」「Snipcode Git:」「Git Graph+:」+ 無前綴的「Refresh」(:63)、「Load More」(:59)、兩個同名「Checkout Remote Branch」(:153, :158)。
- 建議：`menus.commandPalette` 對上述命令 `"when": "false"`；統一改用 `category` 欄位（例如全部 `"category": "Snipcode Git"`），title 去前綴。
- 成本：純 package.json。

**P1-8 Changes 標題列 9 個 icon，且 + / − 三種粒度共用同一 icon**
- 證據：`view/title` 對 `view == snipcode.changes` 有 8 個 `navigation@0-7` + `showCollapseAll: true`（`extension.ts:198`）。`add`/`remove` 同時用於檔案、repo、全部三層。
- 建議：`stageAll`/`unstageAll`/`refresh` 改到非 navigation 群組（進 `…` 溢出選單），標題列保留 filter / fetch / pull / push / graph；全部層級改用 `check-all` / `clear-all`。窄寬度溢出行為請截圖驗證。
- 成本：純 package.json。

**P1-9 空 / 載入 / 錯誤三種狀態都沒有表達**
- 證據：`changes-tree.ts:59` root 永遠回兩個 group → 無 repo 的 workspace 顯示「Staged 0 / Unstaged 0」；`viewsWelcome`（package.json:353）只有 branches 一條，而且因為 root 從不為空，Changes 的 welcome 永遠不會觸發；`refresh()` 是先 await 再 fire，`getChildren` 同步 → 沒有進度條；`changes-workbench.ts:105-114` 非 strict 讀失敗回空 → 壞掉的 repo **無聲消失**。
- 建議：無 repo 或兩 group 皆 0 時 root 回 `[]` + package.json 加 `viewsWelcome` for `snipcode.changes`（「No changes / No git repository」+ 按鈕）；`refresh()` 包 `vscode.window.withProgress({ location: { viewId: 'snipcode.changes' } }, …)`（1 行）；讀失敗的 repo 以 `warning` icon 節點 + error description 保留在樹中。
- 成本：低，圍欄 + package.json。

**P1-10 Amend 不帶入舊訊息、無「已 push」警告**
- 證據：`workbench-store.svelte.ts:40-43` `canAmend` 需要非空訊息；`changes-workbench.ts:290` → `commitIndex(message,{amend})` → `git-service.ts:2409-2422` `commit --amend -m <新訊息>` 直接覆寫。graph 端的 amend modal 有 `amend.pushedWarning`、`amend.keepMessage`，側邊欄沒有。
- 建議：Amend 且訊息為空時，host 讀 `git log -1 --format=%B` 回填 textarea（新增 GitService 小方法 + 一個 message type），或直接導到 `MainPanel.showModalWithPanel({modal:'amend'})` 重用現成 modal。
- 成本：低-中，圍欄。

**P1-11 沒有 Commit & Push、沒有 Ctrl/Cmd+Enter**
- 證據：`Workbench.svelte:26-39` 只有 Commit / Amend；IntelliJ 有「Commit and Push…」與 Ctrl+K/Ctrl+Enter，VS Code SCM 有 Ctrl+Enter。
- 建議：textarea `onkeydown` 攔 (Ctrl|Meta)+Enter → `postCommit(false)`（3 行）；Commit 旁加 split/次按鈕「Commit & Push」，host 端 commit 成功後對成功的 repo 呼叫既有 `pushCurrentBranch`。
- 成本：低（快捷鍵）/ 中（Commit & Push），圍欄。

**P1-12 三種文字同時出現（英文 / 繁中硬編 / 簡中 webview）**
- 證據：Tree 標籤英文 `'Staged'/'Unstaged'`（`build-change-tree.ts:83`）、view 名「Changes」「Commit」；繁中硬編：`Workbench.svelte:17,22,35`、`messaging.ts:67`、`commit-box-view.ts:53`、`changes-workbench.ts:163,285,376,389-390,399,423`；graph/diff webview 對 zh-TW 使用者顯示**簡體**（`i18n/index.svelte.ts:21` `'zh-TW'→'zh'`，`zh.ts` 是簡體：统计、筛选、储藏）；再加 P0-2 的原始 key。英語使用者則會看到中文 placeholder。沒有 `package.nls.json`，view 名/命令名不可在地化。
- 建議：側邊欄 host 字串走 `vscode.l10n.t`（英文整句為 key）+ zh-tw/zh-cn bundle；webview 新增 `zh-tw.ts` 字典並在 `setLocale` 用完整 locale 先查（圍欄）；加 `package.nls.json` + `package.nls.zh-tw.json`。
- 成本：純文字但點多，中。

**P1-13 SCM 容器塞了 7 個 view，只有 Branches 設 `visibility`**
- 證據：package.json views.scm 六條 + 內建 Source Control；`:329` 只有 branches `"visible"`。
- 建議：Remotes / Tags / Stashes / Worktrees（可再加 History）設 `"visibility": "collapsed"`（純 package.json，只影響首次）。更大的 IA 選項：把 Branches…Worktrees 搬進 `snipcode-git` 容器，讓它成為像 IntelliJ Git tool window 的一站式入口，SCM 容器還給內建——只是改 `views` 的 key，成本同樣是純 package.json，值得用截圖比一次。

**P1-14 分支點擊的 QuickPick 對「目前分支」也提供 Checkout / Delete**
- 證據：`extension.ts:767-790` 不看 `branch.current`；右鍵選單反而正確（`viewItem == branch` 排除 `branch-current`）。Tag 的 QuickPick（:792-807）沒有 Checkout，右鍵卻有（`0_checkout`）。點擊即彈 QuickPick 也非 VS Code 慣例（阻斷鍵盤瀏覽）。
- 建議：QuickPick 依 `current` 過濾、tag menu 補 checkout（幾行，上游檔圍欄）；或改點擊 = 在 graph 中 reveal，checkout 改 inline `arrow-right`（package.json）。

**P1-15 ↓↑ 順序在兩個 view 不一致**
- 證據：Branches `↑ahead ↓behind`（`branches-view.ts:191-192`）vs Changes repo 節點 `↓behind ↑ahead`（`changes-tree.ts:76-78`）。
- 建議：統一為 VS Code status bar 慣例 `↓ ↑`（改 Branches）。`graph/src/tree/__tests__/git-toolbar.test.ts:373` 釘住 repo description，改哪邊都要同 change 更新測試。
- 成本：1 行，圍欄。

### P2

- **P2-1 repo 節點重複**：同一 repo 在 Staged/Unstaged 各出現一次，branch + badge 印兩遍，checkbox 只在 Staged 側（`changes-tree.ts:74-87`）。可選：只在第一個出現處印 badge；或反轉為 VS Code 慣例 repo → Staged/Unstaged（設計決策，先截圖比較）。
- **P2-2 Rename 沒有顯示舊路徑**：`FileNode.oldPath` 存在但未渲染（`changes-tree.ts:92-100`）。description 加 `← old/path` 或 tooltip，1-2 行。
- **P2-3 Filter 無啟用態**：`filterRepos` 只設 `view.message`（`changes-workbench.ts:397-401`）。加 `setContext('snipcode.changes.filtered')` + package.json 用 `filter-filled` 互斥顯示。
- **P2-4 Activity bar badge**：`changesView.badge = { value: stagedCount, tooltip }` 一行放 `refresh()`，即可在 Snipcode Git 圖示上顯示待提交數。
- **P2-5 Commit box 位置註解與實際不符**：`commit-box-view.ts:6` 與 extension.ts 註解說「at the top」，package.json:314 排第二（在下方）。擇一並對齊；VS Code 慣例在上、IntelliJ 新 UI 在下。
- **P2-6 Commit 按鈕缺 scope**：store 已有 `stagedRepoCount`，按鈕可顯示「Commit (2 repos)」；成功 banner 永不自動消失（`Workbench.svelte:16-17`）；訊息空時按鈕 disabled 卻無提示；`<html lang="en">`（`commit-box-view.ts:64`）。
- **P2-7 Stash 標籤主從顛倒**：`stash@{n}` 為 label、訊息為 description（`stashes-view.ts:50,53`）。VS Code/IntelliJ 皆以訊息為主。1 行。
- **P2-8 History view 細節**：檔案 label `[MODIFIED] name` 前綴吵（`src/historyTreeProvider.ts:93`，應改用 decoration/description）；tooltip 用 `toISOString()`（:80）；標題被改寫成 `Snipcode History — repo`（`src/historyView.ts:36`）而其他五個 view 用 `.description = repo`（`extension.ts:174-178`），統一為 description。root 檔，無圍欄。
- **P2-9 每個編輯器 tab 都有 Git Graph+ 與 Blame 兩個 icon**：`editor/title` 無 repo 條件。加 `when: gitOpenRepositoryCount != 0`。純 package.json。
- **P2-10 設定項全無描述**：12 個 `clipcode.*`（package.json:647 起）與所有 `gitGraphPlus.defaults.*` 都沒有 `description`，Settings UI 只看到 key；設定分區標題「Git Graph+」掛在「Snipcode」擴充下。純 package.json 文字。
- **P2-11 forAllRepos 訊息中英夾雜**：「Fetch：2/3 成功；repo-a: 無 remote，已略過」（`changes-workbench.ts:159-178`）。歸入 P1-12 一起處理。

---

## 3. 對照 JetBrains Commit tool window

| 能力 | IntelliJ | Snipcode 現況 | 判定 |
|---|---|---|---|
| 變更分組 | Changes / Unversioned / Conflicts（啟用 staging 時 Staged/Unstaged/Unversioned/Conflicts） | 只有 Staged / Unstaged；untracked、conflict 混入 | **有但弱** |
| 目錄樹 + 單鏈壓縮 / flat 切換 | 有（Group by directory/module） | 平面 + dirname description | **沒有** |
| 顏色編碼（藍改/綠增/灰刪/紅衝突） | 有 | 借 vscode.git，覆蓋不保證；衝突不紅 | **有但弱** |
| 多 repo | 有，repo 為第一層 | 有，group 為第一層 + repo checkbox + Filter Repos + Fetch/Pull/Push All 含逐 repo 進度 | **有**（sync-all 比 IntelliJ 清楚） |
| Partial commit | 每檔 checkbox（無 staging）；diff 內可勾 hunk | staging area + Diff tab hunk/line stage（更細），但 repo 層 checkbox 與 Staged 清單並存，形成雙重選取心智模型 | **有但模型衝突**，需明講 |
| Diff 預覽 | 右側 preview pane | 單一重用 Diff tab（`DiffPanel.instance`，`reveal(Active,false)` 不搶焦點） | **有**，值得肯定 |
| Amend | checkbox，自動帶入舊訊息 | 按鈕，不帶入，覆寫 | **有但弱** |
| Commit & Push | 有 | 無（只有 Push All） | **沒有** |
| 訊息檢查（拼字、subject 長度、空行、模板、歷史） | 有 | 無 | **沒有** |
| Rollback / Revert 檔案 | 有 | 無 | **沒有** |
| Shelve / Move to changelist | 有 | 無（stash 只在 SCM view 整批） | **沒有** |
| Ctrl+K / Ctrl+Enter | 有 | 無 | **沒有** |
| Incoming/outgoing 指示 | 有 | 有（repo 節點 ↓↑、Branches） | **有** |
| Author 覆寫 / Sign-off / GPG 切換 | 有 | 無（只能靠 git config） | **沒有** |
| Copy path / Show in Explorer / Open in editor | 有 | 只有 Copy as ClipCode；Open 實為 diff | **有但弱** |

---

## 4. 希望之後用截圖驗證的狀態

1. **多 repo + 衝突 + untracked + 巢狀 repo + rename + MM + 長路徑**：≥3 個 repo（其中兩個 basename 相同以觸發 disambiguation），一個 repo 有 `UU` 檔、一個 `??` 檔、一個未註冊的巢狀 repo 目錄、一個 `R`、一個 `MM`、一個 `src/main/java/com/example/deep/Foo.java`。看衝突檔落在哪、字母/顏色是否出現、MM 在 Staged 側的顏色、description 截斷。
2. **窄側邊欄（~250px）**：Changes 標題列 9 個 icon 的溢出行為、repo description `feature/very-long-name ↓12 ↑3` 截斷、Commit box 兩個按鈕排版。
3. **Commit box 生命週期**：打草稿 → 切到 Explorer → 切回（草稿是否消失）；staged repo = 1 時按 Amend（空訊息 disabled；填新訊息後舊訊息是否被覆寫）；成功 banner 是否殘留。
4. **zh-TW locale 混語**：在 Branches view 點分支 → Checkout → toast 是否顯示 `checkedOut`；同畫面對照 tree 英文標籤、commit box 繁中、graph webview 簡中；status bar tooltip 是否為 `Git Graph+ - clickToOpen`。
5. **空狀態**：無 repo 的 workspace 與乾淨 working tree → 是否只剩「Staged 0 / Unstaged 0」；SCM 容器七個 view 首次開啟時的高度分配。

---

**最便宜且效益最高的一批（全部純 package.json / 1 行程式）**：P0-1 `retainContextWhenHidden`、P0-2 l10n 三段修復、P1-5 右鍵選單、P1-7 `commandPalette` 隱藏、P1-8 標題列瘦身、P1-9 `viewsWelcome` + `withProgress`、P1-13 `visibility: collapsed`、P1-15 ↓↑ 順序、P2-4 view badge、P2-9 editor/title when、P2-10 設定描述。需要新程式碼的核心三項是 P0-3 衝突分組、P1-1 Discard、P1-2 自有 FileDecorationProvider。
