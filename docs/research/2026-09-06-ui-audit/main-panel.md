報告如下（所有引用檔案皆在 `/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/` 之下，以下以 `W/` 代表 `graph/webview-ui/src/`；**全部位於 vendored upstream 目錄，任何改動都需要 `SNIPCODE-HOOK` 圍欄**，不再逐條重複）。

## 0. 前提與修正

- **已見 5 張截圖**：`graph-dark.png`、`graph-light.png`、`graph-dark-details.png`（Commit tab）、`graph-dark-details-file.png`（Changes tab）、`graph-narrow-dark.png`（900px 寬）。每條 finding 標 `[截圖]` 或 `[程式碼推導]`。
- 任務描述有三處與實際不符，先更正：
  1. View tabs 實際文字是 **Graph / Reflog / Stats / PR**（`W/lib/i18n/en.ts:3-4`），只有 i18n **key** 還叫 `toolbar.history` / `toolbar.log`。命名混淆問題不存在。
  2. **Jump to HEAD、Source filter、Branch filter 都已存在**，位於 SearchBar 右側（`W/components/common/SearchBar.svelte:257-377`）；Ctrl+F 聚焦搜尋也有（`W/App.svelte:289-293`）。
  3. `CommitHoverCard` **不在 graph 列上**，只掛在 Commit tab 的 parent hash 連結（`W/components/commit/CommitDetails.svelte:868`，400ms）；graph 列只有純文字 tooltip（500ms，`W/lib/actions/tooltip.ts:29`）。

## 1. 現況描述（由上到下）

```
┌ Toolbar 44px ─────────────────────────────────────────────────────────────┐
│ [▢ synth-repo] [⑂ develop]      [Graph|Reflog|Stats|PR]   ☁↓ ↓ ↑③ | 🗄 | ⑂▾ | ↻ ⚙ │
├ SearchBar ~41px ──────────────────────────────────────────────────────────┤
│ [🔍 Search commits (message, author, hash, branch, tag)…] [◎] [≡Source▾] [⑂Branch▾] │
├ Header 32px (sticky, UPPERCASE 0.9em) ────────────────────────────────────┤
│ DESCRIPTION                                        AUTHOR    SHA    DATE │
│                                                    120px     75px   150px│
├ 每列 30px ───────────────────────────────────────────────────────────────┤
│ ◌ Uncommitted (1 staged, 2 unstaged)                                      │
│ ●─[badge][badge] subject…                          ◉ Bob Martí… 073e1fd 2026-08-02 PM 3:22 │
│ … (虛擬捲動；graph 太寬時橫向捲動，右三欄以 sticky overlay 釘住)           │
├ 拖曳把手 12px（80px 圓角線）─────────────────────────────────────────────┤
│ Bottom panel：預設 35% 視窗高，可拖 20–70%，max-height 80%，可全螢幕      │
│ [Commit] [Changes 9]                                          [⌃] [✕]    │
│ Commit tab：AUTHOR 48px avatar + name <email> + date │ (COMMITTER 同列，只在不同時) │
│            REFS badges / SHA(full) [copy][short] / SIGNATURE / PARENTS(link) │
│            message card（Markdown / Plain toggle）                         │
│ Changes tab：files-panel 240px（120–480 可拖）樹狀 + 字母狀態 │ FileDiffView │
└───────────────────────────────────────────────────────────────────────────┘
```
Chrome 合計 44+41+32 = **117px** 才到第一列；1400×900 視窗開底板後 graph 剩約 585px ≈ 19 列。Modal 固定 480px 寬（`W/components/common/Modal.svelte:89`）。

## 2. Findings

### P0

**P0-1 雙擊任何一列 = 直接 checkout，clean tree 時零確認** `[程式碼推導]`
- 證據：`W/components/graph/CommitGraph.svelte:644-662` `handleRowDblClick` → 單一 local ref 時 `doCheckout(name, false, {}, true)`，第四參數 `skipBehindCheck=true` 連 fast-forward 提示都跳過；`:269-306` 只有 dirty 時才開 modal。row 上沒有任何提示（`graph.dblClickCheckout` tooltip 只掛在 badge，`:1610` 附近）。
- 為何 P0：VS Code 慣例雙擊 = 開啟/釘住；JetBrains Log 雙擊 commit 不做破壞性操作。使用者想「打開」一個 commit 會換掉工作分支。
- 建議：拿掉 row 的 `ondblclick`（`:1539`），保留 badge 上的雙擊 checkout（已有 tooltip 說明）；或加設定 `gitGraphPlus.doubleClickRowCheckout` 預設 false。**成本：刪 1 行 / 1 個設定。**

**P0-2 CommitDetails 的 `Staged | Unstaged` 分頁完全無法到達** `[程式碼推導]`
- 證據：`CommitGraph.svelte:590-596` 與 `:1544-1551`（Enter）對 `UNCOMMITTED` 列都是 `selectedCommitHash = null` + `openScmView`；全 webview 沒有任何地方把 `'UNCOMMITTED'` 寫進 `selectedCommitHash`。`CommitDetails.svelte:714-720` 的雙分頁與 `:916-1087` 整段 uncommitted tree 是死碼。
- 影響：graph 內看不到工作樹變更，點一下就被丟去 SCM 側欄，與「graph 是主面板」的心智模型衝突。
- 建議：單擊 UNCOMMITTED 列 → `uiStore.selectCommit('UNCOMMITTED')`（既有 CommitDetails 路徑會在 `:263-275` 切到 changes tab）；把 `openScmView` 移到右鍵選單（`onUncommittedContextMenu :1260`）。**成本：改 2 個分支約 6 行，但需驗證 `getUncommittedFiles` 訊息流是否仍會被觸發。**

**P0-3 繁中使用者拿到簡體** `[程式碼推導]`
- 根因：`W/lib/i18n/index.svelte.ts:20-23` `setLocale` 把 `zh-TW` 截成 `zh` → 對到簡體字典；`graph/package.json:383-392` `gitGraphPlus.locale` enum 只有 `auto/en/ko/zh-cn`。
- 主面板最顯眼 10 個簡體字串（`W/lib/i18n/zh.ts`）：`统计`(5)、`筛选仓库…`(6)、`储藏（保存未提交的更改）`(12)、`未提交 (已暂存 {staged}, 未暂存 {unstaged})`(120)、`加载更多提交`(127)、`遴选`(164)、`从此处交互式变基`(166)、`将当前分支重置到此处`(167)、`选择一个提交以查看详情`(301)、`搜索提交（消息、作者、哈希、分支、标签）`(307)。另 `toolbar.history: 'Graph'` 在 zh 未譯而同組都譯了（3）；`graph.dblClickCheckout: '双击 Checkout'` 中英混用（159）。
- 建議：新增 `zh-tw.ts`（機轉 + 術語校對：儲藏→暫存/stash、遴選→cherry-pick、变基→rebase 依 AGENTS.md「zh 譯 git 術語」慣例決定），`dictionaries` 加 `'zh-tw'`、`setLocale` 保留 region 先查 `zh-tw` 再 fallback、enum 加 `zh-tw`。**成本：純文字 + 3 行邏輯。**

### P1

**P1-1 鍵盤快捷鍵全部只在 webview 內，未 contribute** `[程式碼推導]`
- `graph/package.json` 沒有 `contributes.keybindings`（grep 0 筆）；Ctrl+1/2/3/F/R 寫死在 `App.svelte:285-297`。VS Code Keyboard Shortcuts 編輯器看不到、不能改鍵。**PR 分頁沒有 Ctrl+4**（SNIPCODE-HOOK 漏補）。Refresh 按鈕 tooltip 用 `toolbar.refresh`（`Toolbar.svelte:360`）而 `toolbar.refreshDesc: 'Refresh (Ctrl+R)'` 存在卻沒人用（`en.ts:16`）。
- 建議：至少 tooltip 全部帶快捷鍵字樣（文字）；Ctrl+4 一行；長期把 focus-search/refresh 做成 command + `when: activeWebviewPanelId == ...`。

**P1-2 右鍵選單：Reset 不標 danger、無 icon、無快捷鍵、Checkout 埋在第 5 組** `[程式碼推導]`
- `CommitGraph.svelte:1097` Reset 無 `danger: true`（只有 submenu 裡的 Delete/Drop/Remove Worktree 有）；頂層 17–23 項全無 `icon`（`ContextMenu.svelte:211-219` 明明支援）；順序為 refs submenu → Create → Merge/Rebase → Reset → Reword/Amend/Fixup → **Checkout/Cherry-pick/Revert** → Compare → Copy。JetBrains 把 Copy Revision Number / Checkout Revision 放最前。
- 建議：`danger: true` 給 Reset（1 行）；Checkout + Copy SHA 移到第一組；頂層項補 codicon。**成本：重排陣列 + 文字。**

**P1-3 多選/比較的發現性** `[程式碼推導]`
- 進入多選只能 Ctrl/Shift+click；右鍵「Add to selection / Cancel selection」只在已 armed 時出現（`:1189-1197`）。`uiStore.enterMultiSelect()`（`W/lib/stores/ui.svelte.ts:124`）已存在卻沒有選單入口。
- 建議：單 commit 選單常駐一項「Select for compare…」→ `enterMultiSelect(hash)`；BottomPanel 的 `details.selectMoreCommits` 文案加上「Ctrl/Shift+click」提示。**成本：1 個 menu item + 文字。**

**P1-4 同一畫面兩種日期格式** `[截圖 graph-dark-details.png]`
- graph 列 `formatDate` 手寫 `2026-08-02 PM 3:22`（AM/PM 在時間前，非任何 locale，`CommitGraph.svelte:1294-1303`）；底板 `formatFullDate` 用 `toLocaleString()` → `2026/8/2 上午6:14:38`。
- 建議：兩處都改 `new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })`；相對時間（Reflog 已有 `relativeTime`）可加設定。**成本：~6 行。**

**P1-5 欄位固定寬、不可調/隱藏/排序；Author 120px 每列截斷** `[截圖 全部 5 張]`
- `CommitGraph.svelte:2315-2366` 120/75/150 硬編碼，`RIGHT_COLS_WIDTH` 也寫死（`:355`）。截圖每列 `Bob Martí…`。JetBrains 有 Columns 選單 + Commit Timestamp 切換。
- 建議：Author 改 `flex: 0 1 160px; min-width: 100px`（CSS）；加設定 `gitGraphPlus.graphColumns: ['author','sha','date']` 用 `{#if}` 控制（`RIGHT_COLS_WIDTH` 需改成 derived）。**成本：CSS + 小量程式碼。**

**P1-6 搜尋只掃已載入的 200 筆，「No results」是假陰性** `[程式碼推導]`
- `SearchBar.svelte:93-111` haystack 來自 `commitStore.commits`；沒有 regex / match case / author-only；`search.filters`、`search.authorFilter` key 存在但未用（`en.ts:314-315`）；"All"/"Local"/"LOCAL" 硬編碼英文（`:290,295,345`）。
- 建議：`search.noResults` 改為「No results in {n} loaded commits — Load more」並在 count 旁放 Load more 按鈕（既有 `getLog` limit 機制）；hash 精確查詢改走已有的 `searchByHash` 訊息。**成本：文字 + ~10 行。**

**P1-7 Modal 的 Enter/焦點政策不一致，且破壞性 modal 一半可用 Enter 確認** `[程式碼推導]`
- `Modal.svelte:38-48` fallback Enter 只找 `button.primary`。全 43 個 modal 中 17 個沒有 mount focus。結果：`DeleteBranchModal`/`DeleteTagModal` 明確 `Btn?.focus()` 到 `.danger-btn` → **Enter 直接刪**；`DeleteRemoteBranch`/`DeleteRemoteTag`/`RemoveWorktree`/`StashDrop`/`AbortConfirm` 沒 focus 又非 `.primary` → **Enter 無效**。`Reset`（可 `--hard`）用 `.primary` → Enter 直接 reset。
- 建議：定一條規則「破壞性 = 不預先聚焦、不吃 Enter；非破壞性 = fallback Enter」，刪掉 Delete*/Reset 的 focus 兩行即可。另 `Modal.svelte:66` `"Close (Esc)"`/aria `"Close"` 硬編碼英文。**成本：刪 2 行 + 1 個 i18n key。**

**P1-8 底板位置與高度不記憶** `[程式碼推導]`
- `App.svelte:90` 每次啟動都重算 35%；`bottomPanelHeight` 不持久化。寬螢幕沒有右側佈局選項（JetBrains 預設右側）。
- 建議：先做便宜的：拖曳結束時把高度存 `vscode.setState`/workspaceState 回填。右側佈局是新程式碼，列為後續。

**P1-9 Changes 樹只有字母狀態，無 ±、無 flat/tree 切換、無全部展開/收合** `[截圖 graph-dark-details-file.png]`
- `CommitDetails.svelte:997/1256` 只有 `A/M/D/R/C`；`details.browseFiles` key 與 `FileTreeBrowser.svelte` 存在但未見接線。JetBrains 有 group by directory / flat + Expand/Collapse All。
- 建議：files-panel 頂加一列小工具列（flat/tree toggle 用既有 `buildFileTree` 或直接 `files` 陣列；expand all = 把所有 dir 丟進 `expandedDirs`）。**成本：~20 行 + CSS。**

**P1-10 可及性：整條虛擬清單全是 tabindex=0，且焦點框全關** `[程式碼推導]`
- `CommitGraph.svelte:1543` 每列 `tabindex={0}` → Tab 要走完幾百列；`:2155/:2274/:2457` `.commit-row/.meta-row/.ref-badge:focus-visible { outline: none }`；`role="row"` 外沒有 `role="grid"`，header 非 `columnheader`；Toolbar view tabs 沒 `role="tablist"/aria-selected`（`Toolbar.svelte:194-223`）；ContextMenu 只吃 Esc，無 ↑↓ 巡覽（`ContextMenu.svelte:244-246`）。
- 建議：roving tabindex（只有 selected 列 `0`，其餘 `-1`）；`:focus-visible` 改為 `outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px`（不會被滑鼠觸發，原註解擔心的 Esc 情境可用 `.selected` 蓋掉）。**成本：CSS + 1 個 class 條件。**

**P1-11 鍵盤巡覽缺口** `[程式碼推導]`
- 有 ↑↓ 與 Ctrl+↑↓ parent/child（`W/lib/graph-navigation.ts`，含 path memory，做得好）。缺：Home/End/PageUp/PageDown；Enter 在已選列是 no-op（`:1544`）而非切換底板/開 diff；Esc 清搜尋後焦點無處可去（`SearchBar.svelte:177` 只 `blur()`），方向鍵失效直到點擊；沒有切換底板/全螢幕的鍵。JetBrains 用 ←→ 跳 parent/child，可考慮同時支援。
- 建議：`handleGraphNavKey` 加 Home/End/Page 四鍵（用既有 `computeScrollTop`），Esc 後 `container.focus()`。**成本：~15 行。**

### P2

- **P2-1 Toolbar 高度與 chrome 厚度**：44px toolbar + 36px 按鈕 + 22px icon（`Toolbar.svelte:394,612-617`）比 VS Code 面板頭（35px/16px icon）粗；三層 chrome 117px。建議 36px/28px/16px，CSS 即可。窄視窗：`.toolbar` 無 wrap/min-width（`:390-399`），<700px 時中間 tabs 與右鈕會重疊 —— **未驗證，需截圖**。
- **P2-2 Current-branch pill 不可點**（`Toolbar.svelte:184-189` 是 `<span>`）。VS Code 狀態列點分支名 = checkout picker。建議 onclick → 開 Branch filter dropdown 或 post `gitGraphPlus.checkoutBranch`。
- **P2-3 Repo pill tooltip 只顯示名稱**（`:134`），nested/submodule 看不到路徑；JetBrains root 色條 hover 顯示路徑。改 tooltip 為 path，文字級。
- **P2-4 CommitHoverCard 實際無法「進入」**：parent link `onmouseleave` 立即銷毀卡片（`CommitDetails.svelte:425-431`），卡片自己的 `onmouseleave`/`onNavigate` 永遠觸發不到，且模板內沒有任何 click 用到 `onNavigate`（`CommitHoverCard.svelte:507-532`）。建議照 `ConflictFilesPopover.svelte:30-33` 加 150ms grace timer，或刪 `onNavigate` prop。
- **P2-5 Reflog 自帶一份 search-bar 複製品**（`Reflog.svelte:251-360`）而不重用 `SearchBar`，樣式已開始漂移（Reflog 用相對時間 `Elapsed`，graph 用絕對）。
- **P2-6 `ActivityLog.svelte` 孤兒**：webview 無人 import，host 仍服務 `getActivityLog`（`graph/src/panels/MainPanel.ts:1482`）。建議刪除（或決定要做成第 5 個 tab，別懸著）。
- **P2-7 硬編碼英文**：`"Loading..."`（`Toolbar.svelte:289`）、`"No staged changes"/"No unstaged changes"`（`CommitDetails.svelte:1079,1085`）、`'Copy Full Source'`（多處 SNIPCODE-HOOK）、SearchBar 的 All/Local/LOCAL、Modal 的 Close。
- **P2-8 Modal 固定 480px 無 size prop**：`InteractiveRebase.svelte:289` 與 `SquashModal` 的 todo 清單塞在 480px 內（hash + action select + subject）。加一個 `wide` class 即可。
- **P2-9 BottomPanel 空狀態 `details.selectCommit` 幾乎不可達**：`App.svelte:528` 只有有選取時才渲染底板，所以只剩 `armedHint` 會出現。文案可只留一種。
- **P2-10 Sort order 只在設定裡**（`gitGraphPlus.graphSortOrder`），toolbar/⚙ 沒有快速切換；JetBrains 在 Graph Options 下拉。可在 ⚙ 旁加下拉，或至少 tooltip 提到。

## 3. 對照 JetBrains Log tab

| JetBrains 功能 | Snipcode | 備註 |
|---|---|---|
| 四 pane（Branches / Commits / Changed Files / Details） | **有但弱** | Branches 在 VS Code 側欄 TreeView（另有報告）；Details 在底部而非右側 |
| 欄位可選（author/date/hash/CI）、Commit Timestamp 切換、Show Root Names | **沒有** | P1-5 |
| 篩選列 Branch | **有** | SearchBar Branch 多選 + 搜尋 |
| 篩選列 User | **沒有** | key `search.authorFilter` 已預留 |
| 篩選列 Date | **沒有** | |
| 篩選列 Paths | **沒有** | |
| Go to Hash/Branch/Tag（Ctrl+F dialog） | **有但弱** | 子字串搜尋含 hash/branch/tag，但只搜已載入 200 筆（P1-6） |
| 搜尋 Regex / Match Case / 歷史 | **沒有** | |
| Commit Details：message/hash/author/email/date/signature/branches | **有** | 多了 Markdown 渲染與 committer 並列；缺「包含此 commit 的 branches」清單與 root 名 |
| Changed Files 右側 + Group by directory / flat + Expand/Collapse All | **有但弱** | 底部、固定樹狀（P1-9） |
| 多選 Compare Versions / Squash / Drop / Cherry-pick | **有** | 2 個→compareCommits，3+→sections；Squash/IR/Cherry-pick 多選都在；發現性弱（P1-3） |
| 右鍵：Copy Revision、Cherry-pick、Checkout Revision、Reset、Revert、Edit Message、Fixup、Squash、IR from here、New Branch/Tag、Create Patch、Compare with Local | **有** | 順序與 danger 標示弱（P1-2） |
| 右鍵：Undo Commit、Push All up to Here、Show Repository at Revision、Go to Parent/Child、View in browser | **沒有** | Parent/Child 只有鍵盤 Ctrl+↑↓ |
| 多 root 色條 + In All Repositories | **沒有** | 單一 active repo，用 repo pill 切換 |
| Highlight：Current branch 藍底 / My commits 粗體 / Merge 灰 / Not cherry-picked 灰 | **有但弱** | 只有 other-branch 0.6 透明度 |
| author ≠ committer 星號 | **有但弱** | 只在 Details 顯示 Committer 欄，列上無標記 |
| Sort（date/topo）、First Parent、No Merges、Collapse Linear、Long Edges | **有但弱** | 只有 sort，且藏在設定（P2-10）；其餘屬線圖 agent 範圍 |
| Ctrl+L 聚焦搜尋 | **有** | Ctrl+F，但未 contribute（P1-1） |
| Reflog 分頁 | **多出** | JetBrains 無獨立 reflog UI，是 Snipcode 優勢 |

## 4. 希望之後用截圖驻證的狀態

1. **右鍵選單**：在同時帶 local branch + tag 的 commit 上開啟 → 看項目數、分隔線、Reset 是否與 Delete 同色、submenu 疊放。
2. **多選 armed 3 個 commit + 底板開啟**：確認 compare-base 藍條、sections 堆疊呈現、`selectMoreCommits` 文案時機。
3. **Toolbar 在 600px 與 480px 寬**：確認中間 tabs 與右側按鈕是否重疊/溢出（目前無 wrap 規則，純推導）。
4. **搜尋中**：有結果的 `search-dim 0.3` 對比度、無結果時的黃色邊框 + "No results" 是否足夠醒目、`Jump to HEAD` 按鈕 active 態。
5. **`gitGraphPlus.locale: zh-cn` 下的主面板 + Delete Branch modal**：確認簡體字串位置與 danger 按鈕被自動聚焦（Enter 即刪）。
