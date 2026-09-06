## 0. 先說做對的地方（讓後面的嚴重度排序有可信度）

- 三點語意正確：檔案清單與 diff 都以 `mergeBase ?? base`→`head` 計算（`graph/src/git/git-service.ts:2247-2263`），commit 清單 `base..head`（:2204），ahead/behind 用 `rev-list --left-right --count base...head`（:2221）。
- rename 正確：`-M -z --name-status` + `parseNameStatusZ`（:2248, :2276-2296），parseDiff 取 `+++ b/` 路徑（`git-parser.ts:238, 429-441`）所以 `diffs.find(x => x.file === file.path)` 能對上新路徑；pure rename（hunks 為空）走 placeholder（`PrView.svelte:693`）。
- 競態防護：`requestId` echo（`PrView.svelte:450-462`；`MainPanel.ts:762-769`）、repo-switch 時 `awaitingBranches` 擋舊 repo 分支。
- 測試完整（`__tests__/PrView.test.ts` 1070 行）：涵蓋 default base、swap、filter、inline diff、hunk nav、splitter。**但沒有任何測試覆蓋「資料過期後刷新」與「空狀態文案」**——這兩個正好是下面 P0。

---

## 1. 現況描述（PR tab 版面）

**進入方式**：只有一條路——graph webview Toolbar 中央第 4 個 view-tab「PR」（`Toolbar.svelte:215-222`，與 Graph / Reflog / Stats 並列）。沒有 command、沒有 keybinding（`package.json` 無 compare 類指令）、branch 右鍵選單沒有「Compare with…」（`CommitGraph.svelte:895-935` 只有 checkout / merge into / rename / delete / copy name）。

**從上到下**：
1. **Header 列**（`.pr-header`，:738）：`[⎇ head-pill ▾]  into  [⎇ base-pill ▾]  ⇄`。
   - head pill 預設 = 目前分支（`defaultHead`, :189）；base pill 預設 = 目前分支 upstream → `origin/main` → 第一個 remote branch → null（`defaultBase`, :129-134）。
   - 兩個 pill 各開一個 dropdown：頂端 type-to-filter input（自動 focus，Enter 選第一筆、Esc 關），下面**平鋪** local + remote 分支（`filter(b => !b.detached)`, :54/:57，沒有分組標頭），沒有 tag、沒有輸入 commit hash。
   - swap 按鈕 `margin-left: 4px`（:878）→ 緊貼 base pill，不在最右（模板註解說「on the far right」，與 CSS 不符）。
2. **Banner 區**：`behind > 0` 顯示黃色警告「N commit(s) behind base」（:589）；`ahead > 0` 再一條藍色資訊「N commit(s) ahead of base」（:595）。兩條可同時出現，各佔一行。merge-base hash **沒有任何地方顯示**（`mergeBase` state 只用於 `openFile`, :353）。
3. **Sub-tab 列**（`.pr-subtabs`, :912）：`Files (N)` `Commits (N)`，右側（僅 Files 時）：`Inline | Side by Side` 切換、↑ 上一個變更、↓ 下一個變更、`[⧉ Copy Full Source]`。**沒有** +/- 總計、沒有 tree/flat 切換、沒有 collapse all。
4. **內容區**（`.pr-content`，單一捲動容器）：
   - **Files**：左欄 `.pr-file-list`（預設 240px，可拖拉 120-600px，`position: sticky; top: 0`, :1014-1019）每列 `[狀態字母] path`，平鋪、依 git 輸出順序、路徑尾端 ellipsis。右欄 `.pr-diff-stack` 把**所有**檔案的 `FileDiffView`（`stacked`, `hideModeToggle`, `heading={file.path}`, :694）一次全部堆疊渲染（不 lazy）。binary / image / 零 hunk 檔案改渲染 placeholder 列 + 「Open native diff」按鈕（:696-700）→ 走 `openDiff{ref1: mergeBase, ref2: head, oldPath}` 開 VS Code 原生 diff editor。
   - **Commits**：純 `div` 列（:718）`[7碼hash] subject [author 140px] [date 100px]`，`toLocaleDateString()` 只有日期沒有時間（:444），**不可點擊、不可多選、不可跳到 graph**。
5. **空/載入狀態**：載入中 spinner + 「Loading reflog」字串（借用 `reflog.loading`）；無檔案 →「No changed files」；無 commit →「No commits」。

**diff 渲染共用情況**：三處都用同一個 `commit/FileDiffView.svelte`——CommitDetails（單檔、非 stacked、自帶 toggle）、Snipcode Diff tab `diff/Diff.svelte`（stacked + `hideModeToggle` + 外層自製 collapse section header + 隱藏 `.diff-toolbar`）、PrView（stacked + `hideModeToggle` + `heading`）。所以不是第三套實作，但 **PrView 沒有跟 Diff.svelte 一樣加 collapse 外殼**，也沒有像 Diff.svelte 那樣處理 toolbar 重複（見 P1-4）。

---

## 2. Findings

### P0 — 會讓人誤判分支差異

**P0-1 資料過期不刷新：任何 git 變動後 PR tab 仍顯示舊結果**
- 證據：`PrView.svelte:448-483` `onMount` 只監聽 `commitsBetween` 與 `error`；`loadCommits` 只在 selectBase/selectHead/swap/repo-switch 觸發。`fullRefresh` / `logData` / `branchData` 抵達時（commit、fetch、pull、amend、checkout 後）沒有任何 effect 重發 `getCommitsBetween`。使用者在 PR tab 開著時 commit 一筆、或 fetch 到 base 新進度，畫面上的 commits / files / ahead-behind 全部是舊的，而且**沒有任何過期提示**。
- 建議：在既有的 `branchStore.branches !== lastBranchesRef` effect（:274-277）裡，當 `base && head` 都非 null 就 `loadCommits(base, head)`。branchData 每次 fullRefresh 都會重新賦值，這個 effect 已經是「host 有新 ref 資料」的信號。要避免 loading 閃爍，可以不清空舊 `files/diffs`（loadCommits 目前會清空，:143-150），只在回應到達時替換。
- 成本：webview 新程式碼約 5 行；全檔已在 `SNIPCODE-HOOK` 內。
- 補一個測試：post `branchData` 後應再出現一筆 `getCommitsBetween`。

**P0-2 「No changed files」是預設態、錯誤態、null 態、base==head 態的共用文案**
- 證據：初始 `loadingCommits=false, files=[]`（:87-93）→ 模板 `:642-645` 直接落到 `pr.noFiles`。四種情況都顯示同一句：
  1. 尚未發出請求（首幀、或 `defaultBase()` 回 null——**沒有 remote 的 repo 永遠停在這裡**，因為 fallback 鏈只有 remote branches，:129-134）；
  2. detached HEAD（`defaultHead` 回 null, :189-193）→ head pill 卻顯示 `branchStore.currentBranch?.name`（`(HEAD detached at …)`, :498）看起來像已選定，實際沒送請求；
  3. host 回 `error`（例如不合法 ref）→ 只清 loading（:477-480），紅色 error-bar 8 秒後消失（`App.svelte:170`, `ui.svelte.ts` setError timer），之後畫面停在「No changed files」；
  4. base == head 或 head 完全落後 base（ahead=0）→ 真的沒差異，但沒說「兩邊相同」或「head 已完全包含在 base 內」。
- 建議：加一個 `$derived` 狀態機 `emptyReason: 'pickBase' | 'detached' | 'error' | 'sameRef' | 'upToDate' | 'noDiff'`，各配一個 i18n key。`defaultBase` fallback 補上 local `main` / `master` / `develop`（`branchStore.localBranches` 現成）。error 時記住 `lastError` 字串顯示在 `.pr-empty` 裡而不是只靠全域 bar。
- 成本：文字 + 少量 webview 程式碼；`SNIPCODE-HOOK` 內。

**P0-3 兩條「比較」路徑語意不同且沒有標示**
- 證據：PR tab = `mergeBase..head`（三點）；graph 多選兩個 commit → `compareCommits(ref1, ref2)`（`CommitGraph.svelte:1341-1345`）= `git diff ref1 ref2` **直接 tree diff**（`git-service.ts:1430-1433`），ref1/ref2 由「顯示順序較舊/較新」決定。使用者選 `main` tip 和 `feature` tip 兩個 commit 時，會看到 main 上新 commit 的變更以「反向」出現在 feature 側，跟 PR tab 得到的結果不一致。且 CommitDetails 比較模式**沒有 header 說明在比較哪兩個 ref**（`BottomPanel.svelte:17-18` 直接 mount `<CommitDetails />`，top-tabs 只顯示 `Changes N`，`CommitDetails.svelte:721-729`）。
- 建議（不重寫）：(a) BottomPanel/CommitDetails 比較模式在 tabs 列顯示 `compareRef1 → compareRef2` 短 hash（uiStore 已有這兩個值）；(b) 兩個 commit 皆為分支 tip 時，在 multi-select 選單多一項「Open in PR tab (merge-base…)」→ 設 `uiStore` 新欄位 `prPreset = {base, head}` 後 `setViewMode('pr')`，PrView 的 default effect 優先讀 preset。
- 成本：(a) 文字/模板；(b) 新 store 欄位 + 選單一項 + PrView 讀 preset 約 20 行。CommitDetails/BottomPanel/CommitGraph 是 upstream 檔，需加 `SNIPCODE-HOOK` 圍欄。

### P1 — 明顯降低清晰度／效率

**P1-1 沒有任何統計：無 +/- 行數、無 per-file 行數、merge-base 不顯示、兩條 banner 各佔一行且 ahead 與 Commits 計數重複**
- 證據：`mergeBase` 只用在 :353；banner :589-600；host 無 `--numstat/--shortstat`（`git-service.ts` grep 無）。
- 建議：把兩條 banner 合併成一條資訊列：`↑ 5 ahead · ↓ 2 behind · merge-base a1b2c3d · 8 files · +120 −34`。+/- **可直接在 webview 從已在記憶體的 `diffs[].hunks[].lines` 計算**（`+`/`-` 開頭行數），零 host 改動；per-file 也同法放到左欄每列尾端（binary/placeholder 顯示 `bin`）。merge-base hash 可點擊 → `copyToClipboard`。只有要「與 git 完全一致」才需 host `--numstat -z -M`。
- 成本：CSS/文字 + 約 15 行 derived；`SNIPCODE-HOOK` 內。

**P1-2 左欄 sticky 檔案清單沒有 `max-height`/自己的捲動——檔案多時下半部無法到達**
- 證據：`.pr-files-layout .pr-file-list { position: sticky; top: 0; border-right… }`（:1014-1021），無 `max-height` / `overflow-y`。sticky 元素高於視窗時，被截掉的底部只有在右側 diff 堆疊捲到最底才會露出；100+ 檔的 PR 左欄後段點不到。
- 建議：`max-height: 100%` 在 sticky 內不可靠，用 `max-height: calc(100vh - <header+subtabs 高度>)` 或改用 `.pr-content` 之外的獨立 flex 欄（把 `.pr-files-layout` 改為兩個各自 `overflow-y:auto` 的欄，右欄成為 `prContentEl`——`jumpChange` 只讀一個容器，改綁右欄即可）。
- 成本：CSS（第一種）或 CSS + 改 `bind:this` 目標（第二種）；`SNIPCODE-HOOK` 內。**請截圖驗證**（見第 4 節）。

**P1-3 檔案清單是平鋪 + 尾端 ellipsis，長路徑看不到檔名；與 CommitDetails（tree）不一致**
- 證據：`.pr-file-path { text-overflow: ellipsis }`（:1117-1121），240px 寬時 `src/components/graph/CommitGraph.svelte` 只剩 `src/components/gra…`。CommitDetails 用 `buildFileTree`（:444）樹狀，FileDiffView 用 `.diff-dir`（暗、可縮）+ `.diff-base`（粗、不縮）（`FileDiffView.svelte:775-787`）。
- 建議：最低成本——左欄每列改成 `<span class="dir">dir/</span><span class="base">name</span>` 沿用 FileDiffView 的 CSS 規則（複製 3 條 rule）。進一步：加 `Tree | Flat` 切換，reuse `CommitDetails.svelte:444-478` 的 `buildFileTree`（可抽到 `lib/utils/path.ts` 旁邊）。
- 成本：CSS/模板（第一種）；抽 helper + 模板（第二種）。

**P1-4 每個 diff section 的路徑顯示兩次，卻沒有狀態字母、沒有 rename 的 old → new**
- 證據：PrView 傳 `heading={file.path}`（:694）；FileDiffView 同時渲染 `.diff-commit-label`（heading, `FileDiffView.svelte:517`）**與** `.diff-file-name`（:519-524）→ 兩行都是同一個路徑。狀態 A/M/D/R 與 `oldPath` 只在左欄和 placeholder 出現。
- 建議：`heading` 改傳 `${statusLabel} ${oldPath ? oldPath + ' → ' : ''}` 或乾脆不傳 heading，改用 Diff.svelte 的做法：外層自製 section header（狀態色字母 + path + 展開/收合 + 「Open native diff」+ per-file +/-），並 `:global(.diff-toolbar){display:none}`（`Diff.svelte:161`）。這同時解 P1-5。
- 成本：模板 + CSS；`SNIPCODE-HOOK` 內（FileDiffView 端不需改）。

**P1-5 沒有 per-file 收合、沒有「已檢視」、左欄沒有目前檔案高亮**
- 證據：`.pr-file-row` 無 `class:selected`（:656）；沒有 collapsed state；Diff.svelte 已有 `collapsed` + `section-toggle` 模式（`Diff.svelte:15-25, 62-80`）。
- 建議：照 Diff.svelte 抄一個 `collapsed: Set<string>` + 「Collapse all / Expand all」；用 `IntersectionObserver` 標左欄目前可見檔案（或簡化為 click 高亮）。
- 成本：webview 新程式碼約 30 行；`SNIPCODE-HOOK` 內。

**P1-6 Commits 子頁不可互動**
- 證據：`.pr-commit-row` 是 `div`（:718），無 onclick、無 hover、無 avatar、日期無時間（:444；graph 的 `CommitGraph.svelte:1294` `formatDate` 有時間，可直接搬用或抽到 utils）。
- 建議：點列 → `uiStore.selectCommit(hash)`（`ui.svelte.ts:41-52`，會開 bottom panel）+ `uiStore.setViewMode('graph')`；hash 右鍵/點擊 → `copyToClipboard`。**注意**：BottomPanel 靠 `commitStore.getCommit(hash)` 找 commit（`BottomPanel.svelte:7-11`），超出 history limit 的 commit 會顯示「Select a commit」——需要 fallback（例如先 `getLog` 再選，或提示）。
- 成本：webview 新程式碼；`SNIPCODE-HOOK` 內。

**P1-7 沒有「behind 側」的 commit 清單（JetBrains 兩欄、GitLens 雙向都有）**
- 證據：`commitsBetween` 只 `log base..head`（:2204），behind 只給計數。
- 建議（host，小）：把 `log base..head` + `rev-list --count` 兩個呼叫合成一個 `git log --left-right --cherry-mark --pretty=%m%x00%H%x00%s%x00%an%x00%aI base...head`；`%m` 是 `<` / `>` / `=`（`=` 為 cherry-pick 等價，可淡化顯示——這點連 IntelliJ 都沒做）。ahead/behind 由計數得出，省一個 spawn。message-bus payload 多 `baseOnlyCommits` 與 `equivalent: boolean`。
- 成本：host git 參數 + `message-bus.ts:205-220` payload 欄位 + Commits 子頁兩欄或分段；全在既有 `SNIPCODE-HOOK` 區塊內。**請先在 shell 驗證 `%m` 搭 `--pretty=format` 輸出**。

**P1-8 從 branch 進不來**
- 證據：`CommitGraph.svelte:895-935, 985-1000` branch/remote-branch ref 選單無 compare 項；`package.json` 無 command。
- 建議：ref 選單加「Compare with current branch…」（base=該分支、head=current）與「Compare … into current」（反向），實作同 P0-3(b) 的 `prPreset`。
- 成本：選單一項 + store 欄位；CommitGraph 為 upstream 檔需圍欄。

### P2 — 打磨

**P2-1 硬編英文，i18n parity 測試（`i18n/__tests__/parity.test.ts`）會強迫補 ko/zh key**：`Filter branches…`（:509, :556；可直接沿用 `toolbar.filterRepos` 的樣式新增 `pr.filterBranches`）、`No matching branches`（:531, :578）、`Swap base and head`（:583）、`Previous change` / `Next change`（:622, :625）、`Copy Full Source`（:629-631）、`Open native diff`（:700）、`Hunk` 前綴（`FileDiffView.svelte:246`，upstream）。載入文案借用 `reflog.loading`（「Loading reflog」/「加载引用日志中」）在 PR tab 顯示是錯的（:643, :712）。`toolbar.pr` 三語都是 "PR"——這裡沒有 PR 物件，「Compare」更誠實。（另：zh 整個 locale 是簡體，非本功能問題。）

**P2-2 選擇器只有 branch**：無 tag（`branchStore.tags` 現成）、無 commit hash 輸入、local/remote 混排無分組標頭；順序是 `git branch -a` 字母序（`git-service.ts:886`），current branch 沒有置頂。成本：模板 + `$derived` 分組。

**P2-3 Copy Full Source 語意不清**：複製的是 head 上每個變更檔的**完整內容**（deleted 用 marker），不是 patch；按鈕文字沒有說「N files @ head」。沒有「Copy patch / Save patch」（`saveCommitPatch` 只支援單 commit）。回饋走 `notifyCopied`（`src/extension.ts:182`）正確，但 toast 只有「N file(s) copied」沒說來源分支。成本：文字；range patch 需 host 一個 `git diff mergeBase head > file`。

**P2-4 `statusColor` 與 CommitDetails 重複且已 drift**（PrView :379-400 無 `N` case；`CommitDetails.svelte:663-683` 有）。抽到 `lib/utils/` 一處。成本：搬移。

**P2-5 窄視窗**：`.pr-subtabs` 6 個控件不換行（:912）、`.pr-header` 不換行；pill `max-width: 220px`。<600px 時 Copy 按鈕會被推出視窗。成本：CSS `flex-wrap` 或把 Copy 收進 `…` 選單。

**P2-6 大 PR 效能**：`commitsBetween` 一次 spawn 5 個 git、整份 range diff 文字 parse 後經 postMessage 送進 webview，且全部 FileDiffView 立即渲染（plan 明說 lazy 是 follow-up）。單檔有 `MAX_RENDER_LINES=3000` 保護，但 200 檔 × 幾百行仍會卡。建議先用 P1-5 的 collapse（預設收合超過 N 個檔案之後的 section）擋住，比 lazy fetch 便宜。

**P2-7 CommitDetails 比較模式 `openDiff` 沒帶 `oldPath`**（`CommitDetails.svelte:1130, 1155`），rename 左側會是空白——PR 路徑修了（`openCompareDiffInEditor` 支援 `oldPath`），這條沒有。成本：模板一行；upstream 檔需圍欄。

**P2-8 light theme**：PrView 全部走 `--bg-secondary / --text-secondary / --button-bg / --input-bg` 等 token（`styles/global.css:3-24`）＋ 中性 `rgba(128,128,128,…)` 疊層，light 下沒有硬編深色。status 色有 light 分支。無問題，只需截圖確認 `pr-banner-info` 的 `color-mix(button-background 12%)` 在 light 主題對比度。

---

## 3. 對照表

| 能力 | JetBrains Compare with Branch | GitHub PR 工具視窗 | GitLens Compare | Snipcode PR tab |
|---|---|---|---|---|
| 選 base / head 皆可 | 有 | 有 | 有 | **有**（pill + swap） |
| 選擇器含 tag / commit / 輸入任意 ref | 有 | 分支 | 有 | **沒有**（只有 branch） |
| type-to-filter | 有 | 有 | 有 | **有** |
| 從 branch 右鍵進入 | 有 | — | 有 | **沒有** |
| 三點（merge-base）語意 | 有 | 有 | 有 | **有** |
| merge-base 顯示 | 沒有 | 沒有 | 有（hover） | **沒有** |
| ahead / behind 計數 | 兩欄隱含 | 有 | 有 | **有但弱**（兩條 banner） |
| 雙向 commit 清單（A→B 與 B→A） | 有（兩欄） | 沒有 | 有 | **沒有**（只有 head 側） |
| cherry-pick 等價標記 | 沒有 | 沒有 | 沒有 | 沒有（`--cherry-mark` 可白拿） |
| commit 可點看單一 commit diff | 有 | 有 | 有 | **沒有** |
| 檔案 tree / flat 切換 | 有 | 有 | 有 | **沒有**（只有 flat） |
| per-file +/- | 有 | 有 | 有（hover） | **沒有** |
| 總計 files / +/- | 有 | 有 | 沒有 | **沒有** |
| rename 顯示 old → new | 有 | 有 | 有 | **有但弱**（只在左欄字母 R，section 不顯示） |
| inline diff 堆疊全檔 | 沒有（逐檔） | 有 | 沒有（逐檔） | **有** |
| inline / side-by-side | 有 | 有 | 有 | **有** |
| per-file 收合 / Collapse all | — | 有 | — | **沒有** |
| 已檢視（Viewed）/ 目前檔案高亮 | — | 有 | — | **沒有** |
| 上／下一個變更 | 有 | 有 | — | **有** |
| 開原生 diff editor | 有 | — | 有 | **有**（僅 placeholder 檔；一般檔沒有按鈕） |
| Compare with working tree | 有 | — | 有 | 沒有（在 graph 的 `compareToLocal`，不在 PR tab） |
| binary / image 處理 | 有 | 有 | 有 | **有但弱**（丟給原生 diff，無 ImageDiff） |
| 資料變動自動刷新 | 有 | 有 | 有 | **沒有**（P0-1） |
| 空狀態說明原因 | 有 | 有 | 有 | **沒有**（P0-2） |
| 複製 / 匯出 patch | 有（patch） | — | — | **有但不同**（Copy Full Source＝完整內容非 patch） |
| 窄視窗自適應 | 有 | 有 | 有 | **有但弱** |

---

## 4. 希望之後用截圖驗證的狀態

1. **標準 PR，light + dark 各一張**：`feature` 相對 `develop` ahead 5 / behind 2；8 files = 1 `A`、4 `M`、1 `D`、1 `R100`（`src/old/a.ts → src/new/a.ts`）、1 PNG。Files 子頁，第一個 diff 展開。驗證：兩條 banner 的高度、swap 按鈕實際位置（貼 base pill 還是最右）、rename section 標題是否顯示兩次路徑且看不出 old path、PNG 的 placeholder 列、`pr-banner-info` 在 light 主題的對比。
2. **長檔案清單**：同上但 120+ 檔（可用 `git mv` 一個資料夾製造），視窗高 800px。驗證 P1-2：左欄 sticky 清單第 40 檔以後是否要把右側捲到底才點得到；長路徑 `src/components/graph/CommitGraph.svelte` 在 240px 欄的截斷方式。
3. **三種空狀態**：(a) 沒有 remote 的 repo（base pill 應顯示「Select base branch」，內容區文字？）；(b) detached HEAD（head pill 顯示什麼、內容區顯示什麼）；(c) base == head 兩邊都選 `main`。驗證 P0-2 三者是否都是「No changed files」。
4. **過期狀態**：開著 PR tab（feature vs develop），在終端 `git commit --allow-empty -m x` 於 feature，等 graph 自動刷新後截 PR tab。驗證 P0-1：Commits 計數是否仍是舊值、無任何過期提示。
5. **窄視窗 ~600px 寬**：Files 子頁。驗證 `.pr-subtabs` 六個控件是否溢出、Copy Full Source 是否被推出可視區、pill 220px 截斷後 head/base 名稱可讀性。
