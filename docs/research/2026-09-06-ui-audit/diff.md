## Snipcode diff 呈現審查報告（只讀，未改任何檔案）

### 1. 現況描述

**共用渲染器**：三個表面（Diff tab、Commit details 的 Changes 分頁、PR compare tab）全部用同一支 `graph/webview-ui/src/components/commit/FileDiffView.svelte` 渲染，沒有第二套 diff renderer。差別只在 props（`staged / stacked / diffMode / hideModeToggle / onStageHunk / onReverse…`）與外層容器。資料型別 `DiffData{file,hunks,isBinary,isImage,fingerprint}` / `DiffHunk{header,oldStart,oldLines,newStart,newLines,lines}` / `DiffLine{type,content,oldLineNumber?,newLineNumber?}`（`lib/types.ts:135-159`）——**沒有** status、oldPath、mode、similarity、noNewline 等欄位。

**Diff tab（`DiffPanel.ts` → `diff.js` → `Diff.svelte`）**，從上到下：
1. VS Code editor tab 標題 `Diff: <basename>`（`DiffPanel.ts:129`）。
2. `.mode-bar`：一列靠右的 `Inline | Side by Side` 切換（`Diff.svelte:54-59`），**預設 Side by Side**（`:12`）。
3. `.sections`（唯一的垂直捲動容器）內依序堆疊最多兩個 `<section>`：**Staged**、**Unstaged**（該側 diff 為 null 就不出現）。每個 section 頂端一列 sticky `.section-header`：左邊 chevron + 小 badge 文字「Staged / Unstaged」（兩個 badge 同色 `--vscode-badge-background`，`:153-156`），右邊一顆 `codicon-diff` icon 按鈕「Open full file diff in editor」→ 用自家 `snipcode-diff:` content provider 開原生 `vscode.diff`（`DiffPanel.ts:224-236`）。
4. 每個 section 內一個 `FileDiffView stacked`，**但其 `.diff-toolbar`（路徑 + 檔名 + 模式切換）被整個 `display:none`**（`Diff.svelte:162`）——所以 tab 內看不到完整路徑、狀態字母、rename from→to、± 統計。
   - **Inline 模式**每個 hunk：一列 `.diff-hunk-header`「`Hunk 1: Lines 12-30`」+ 右側 hover 才出現的綠色 chevron「Stage Hunk」（`opacity:0`，`FileDiffView.svelte:884-887`）；有 gutter 拖選時多一顆「chevron + 數字」的 Stage Selected Lines。每一行：`舊行號(45px) | 新行號(45px) | +/-/空(14px) | 內容(white-space:pre, Shiki 高亮 + word-diff 底色)`。gutter 可 mousedown 拖選、Shift-click 延伸、Esc 清除、右鍵選單（`:172-223`）。
   - **Side-by-side 模式**：兩個各自 `overflow:auto` 的 pane（左舊右新）同步捲動；每個 hunk 之間只有一條虛線 `.hunk-separator`，**沒有 hunk header 列、沒有 Stage Hunk 按鈕、行號 span 沒有任何 mouse handler（不能拖選行）**（`:629-726`）；只有每個連續 +/- 區塊第一行右緣一顆 sticky 的藍色方形 chevron「Stage Change Block」（`:663-670`，`opacity:.55`）。
5. 操作回饋：按下後 `busy=true` → 按鈕 `opacity:.35`（無 spinner），host `git apply --cached` 後 `refreshIfCurrent` 重推整份 `diffShow`；section 以 `generation` 為 key（`Diff.svelte:62`）→ **每次 stage 都整個重新 mount**，highlight 快取被清（`FileDiffView.svelte:282-289`）。錯誤走頂端紅色 banner；15s 逾時只顯示提示不解鎖。
6. 圖片：`ImageDiff.svelte`（Side by Side / Swipe / Onion Skin，顯示 W×H 與 bytes）；非圖片二進位只有一行「Binary file」；rename-only / mode-only / 空 hunks → **空白，什麼字都沒有**。

**Commit details 內的 diff（`CommitDetails.svelte`，圖表 webview 底部面板）**：
- 底部面板高度 = `uiStore.bottomPanelHeight`（可拖、可全螢幕）。頂列 tabs：commit 時 `Commit | Changes(N)`；UNCOMMITTED 時 `Staged(N) | Unstaged(N)`（`:711-720`，一次只看一側，與 Diff tab 的「兩側疊放」不一致）。
- Changes 分頁左邊 `.files-panel`（預設 240px，拖桿可調 120–480）是**樹狀**檔案列表：`codicon-file` + 檔名 + 右側一個字母 `A/M/D/R/C/U/N`（寫死 hex 色，`:663-685`），**無 ± 統計、rename 只有字母 R、不顯示舊名**（`oldPath` 已在 wire 上 `:44-49` 但未渲染）。單擊選檔（可 Ctrl/Shift 多選）、**雙擊**才開原生 `vscode.diff`（`:957-959`, `:1128-1134`）。
- 右邊直接放 `FileDiffView`（非 stacked，`:1387-1394`），**預設 Inline**（`FileDiffView.svelte:296`），toolbar 可見（路徑 + Inline/SBS 切換）。commit 檢視時 hunk header 有紅色「Reverse Hunk」/「Reverse Selected Lines」；UNCOMMITTED 檢視時**沒有任何 stage 按鈕**（`onStageHunk` 未傳）。
- 多 commit 選取 → `sections-pane` 內每個 commit 一個 stacked FileDiffView，heading 顯示 shortHash + subject。

**Host 端**：Diff tab 兩側各自 `git diff --no-color [--cached] -- <file>`（untracked 用 `--no-index /dev/null`），`{encoding:'buffer'}` 後 sha256 當 fingerprint（`git-service.ts:1003-1043`）；stage/unstage 重新跑同一命令、比對 fingerprint、`patch-builder` 產 patch 後 `git apply --cached [--reverse]`（`:2524-2590`）。commit 單檔 diff 為 `git diff parent..hash -- <file>`（`:1607-1640`）。所有 diff 命令都**沒有** `-U<n>`、`-w`、`--ignore-cr-at-eol`、`--diff-algorithm`、`--numstat`；`-M` 只用在 `--name-status`（`:1439,1527,1532`）。

---

### 2. Findings（依嚴重度）

成本標記：**CSS/設定** < **小段新程式碼** < **host git 參數 + 訊息 plumbing**。Fence：`git-parser.ts`、`git-service.ts`、`FileDiffView.svelte`、`highlighter.ts`、`word-diff.ts`、`CommitDetails.svelte`、`MainPanel.ts` 為 upstream 檔案 → **需 SNIPCODE-HOOK**；`diff.ts`、`Diff.svelte`、`diff-store.svelte.ts`、`messaging.ts`、`DiffPanel.ts` 為 Snipcode 自有檔案（fence 可選）。

#### P0 — 會讓人看錯異動

**P0-1 Diff tab 的 bundle 沒有載入 `global.css`，24 處 CSS token 未定義 → hunk 邊界、pane 分隔線、hunk header 底色全部消失**
- 證據：`webview-ui/src/diff.ts:1-11` 沒有任何 css import；`main.ts:3` 有 `import './styles/global.css'`，`workbench.ts:4` 有 `workbench.css`。`DiffPanel.ts:449-467` 只 link `diff.css` + `codicon.css`。實測 built `webview-ui/dist/diff.css`（= `dist/graph-webview/diff.css`）：`--text-secondary` 用 12 次 / 定義 0、`--border-color` 9/0、`--bg-secondary` 2/0、`--bg-primary` 1/0；`main.css` 都有定義。
- 後果（CSS 規範：`border-top: 1px dashed var(--undefined)` 在 computed-value time 無效 → 整條 shorthand 變 `none`）：SBS 的 `.hunk-separator`（`FileDiffView.svelte:972-978`）、inline 的 `.diff-hunk{border-top}`（`:820-823`）、`.sbs-left{border-right}`（`:1094-1096`）全部不畫；`.diff-hunk-header{background}`（`:825-831`）透明。**相鄰兩個 hunk 在 Diff tab 裡看起來是連續的一塊**，只剩行號跳號可辨。另外沒有 `*{margin:0;padding:0;box-sizing:border-box}` reset → VS Code webview 預設 `body{padding:0 20px}` 很可能讓整個 diff 左右各縮 20px（需截圖確認）。
- 建議：`diff.ts` 加一行 `import './styles/global.css';`。Snipcode 自有檔案。**成本：一行**。副作用要驗：global.css 的 `button` 基底樣式、`body{overflow:hidden;height:100vh}` 會套進來——`.hunk-action-btn`/`.sbs-block-stage-btn` 已自訂 bg/border，應無礙，但請用截圖確認。

**P0-2 `\ No newline at end of file` 被 parser 丟掉 → 只改 EOF 換行的檔案，顯示成兩行一紅一綠、內容完全相同、無任何差異標示**
- 證據：`git-parser.ts:293-325` 只處理 `+`/`-`/` `，`\` 開頭的 marker 直接落到沒有分支被忽略；`DiffLine` 無 flag（`types.ts:154-159`）。word-diff 對相同內容算出空 range → 沒有底色。使用者會以為「這行沒變卻被標紅綠」。（`patch-builder.ts:33-79` 自己有處理 marker，所以 stage 是對的，只有顯示錯。）
- 建議：`DiffLine` 加 `noNewline?: boolean`；parser 遇到 `\` 行時把前一行標起來；`FileDiffView` 在該行內容末尾渲染一個 `⏎`/「No newline at end of file」小 pill（`--vscode-editorWarning-foreground`）。**成本：小段新程式碼（3 檔），upstream 檔需 fence**。

**P0-3 Rename + 修改的檔案，單檔 diff 被渲染成「整檔新增」**
- 證據：`git-service.ts:1607-1640` `commitFileDiff` 跑 `git diff parent..hash -- <newPath>`，pathspec 只含新路徑 → 舊路徑的刪除被 pathspec 過濾，git 無法配對 rename → 輸出 `new file mode` + 全 `+`。同樣問題在 Diff tab：`getUncommittedFileDiff` 的 `--cached -- <newPath>`（`:1007`）。`CommitFile.oldPath` 已在 wire 上（`CommitDetails.svelte:44-49`），但 `getFileDiff` payload 只送 `{hash,file}`（`:306-312`）；`MainPanel.ts:1990-2018` `openDiffInEditor`（commit/staged 分支）也沒用 oldPath——只有 `openCompareDiffInEditor`（`:2021-2046`）有處理。
- 另一面：rename-only（100% 相似）或 mode-only 變更 → hunks 為空 → `FileDiffView.svelte:567-628` 的 inline 分支迭代 0 個 hunk → **整個 body 空白無字**。
- 建議：(a) host：當呼叫端知道 `oldPath` 時傳 `-M -- <oldPath> <newPath>`（兩個 pathspec 讓 git 能配對）；webview 端 `getFileDiff` / `DiffPanel.show` 多帶 `oldPath`（`StatusChange.oldPath` 在 `getUncommittedDiff` 已有，`:964-965`）。(b) parser 讀 `rename from/to`、`old mode/new mode`、`similarity index` 進 `DiffData`（可選欄位）；FileDiffView 加 `{:else if renderHunks.length === 0}` → 顯示「Renamed from X (similarity 97%) / Mode 100644→100755 / No textual changes」。**成本：host git 參數 + payload plumbing + 小段 UI；`git-service.ts` 該區已在 SNIPCODE-HOOK 內**。附帶：目前 staged rename 走 hunk unstage 時 raw 沒有 `rename from` header → `assertHunkStageable`（`:71-75`）擋不到，`apply --cached --reverse` 一個 `new file` patch 會把 index 裡的新路徑整個拿掉，留下一個「純刪除」的 staged 狀態——行為問題，順帶指出。

**P0-4 CRLF 檔的 `\r` 留在 `content` 裡 → 只改 EOL 的行整行紅綠、看不到差異；word-diff 高亮落在看不見的字元上**
- 證據：`git-parser.ts:445` 只對路徑 `replace(/\r$/,'')`，內容 `line.substring(1)` 保留 `\r`；`.line-content{white-space:pre}`（`FileDiffView.svelte:1029-1033`）下 CR 不可見。`word-diff.ts:42-44` tokenize 把 `\r` 歸入 `\s+` token，會產生一段隱形高亮。
- 建議：顯示層在 parser 把內容尾端的 `\r` 去掉、同時標 `cr?: true`，FileDiffView 渲染 `␍` 小標記（只在一側有時特別醒目）。patch-builder 走另一條 raw Buffer 路徑（`:33-79` 自己 split），不受影響。**成本：parser 1-2 行 + 一個 span，需 fence**。進一步可提供 `--ignore-cr-at-eol` 檢視切換（見 P1-9）。

#### P1 — 明顯降低清晰度 / 效率

**P1-1 Diff tab 預設的 SBS 模式恰好是功能最少的模式；兩個表面預設不同**
- 證據：Diff tab 預設 `side-by-side`（`Diff.svelte:12`）、CommitDetails 預設 `inline`（`FileDiffView.svelte:296`）。SBS 分支（`:629-726`）沒有 hunk header、沒有「Stage Hunk」、沒有「Stage Selected Lines」，`.line-num` span（`:661,:710`）沒有 `onmousedown/onmouseenter` → 不能拖選行；`hunkLabel` 只在 inline 出現。使用者要 hunk 級操作必須先切回 Inline。
- 建議（擇一，最便宜優先）：(a) `Diff.svelte:12` 改預設 `'inline'`（一行）；(b) 在 SBS 左 pane 每個 `.sbs-hunk` 前也渲染同一個 `.diff-hunk-header` 區塊（把 `:571-608` 抽成 snippet 重用）並把 gutter handlers 掛到 SBS 的 `.line-num`；(c) 記住使用者上次選的模式（`getVsCodeApi().setState`），兩表面共用。**成本：(a) 一行 / (b) 模板搬移，需 fence**。

**P1-2 Diff tab 沒有檔案標頭：看不到完整路徑、狀態、rename、± 統計；tab 標題同名檔會撞**
- 證據：`Diff.svelte:162` 隱藏 `.diff-toolbar`；`DiffPanel.ts:129` 標題只有 basename。整個 repo 沒有 `--numstat`。
- 建議：在 `.mode-bar` 左側渲染一列「`dir/` **base**  · A/M/D/R  · `+N −M`」——± 可直接在 webview 從 `hunks` 數 add/delete 行（不需 git 參數）；狀態字母可由 tree node 的 `status` 隨 `diffShow` 一起送（`StatusChange.status` 已有）。標題改 `Diff: dir/base` 或 `base — dir`。**成本：小段 Svelte，Snipcode 自有檔案**。

**P1-3 每次 stage/unstage 都整段 remount → 高亮閃爍、hover/捲動狀態遺失**
- 證據：`Diff.svelte:62` key 含 `store.generation`（每次 push 都變）；`FileDiffView.svelte:282-289` `$effect` 在 `diff` 變動時清 `highlightedLines` → 先畫純文字再逐塊高亮。
- 建議：key 改為 `${repoPath}\0${side}`，讓 `diff` 以 prop 更新；圖片身份已由 `imageGeneration` prop 傳遞，ImageDiff 的 `$effect` 讀取該 prop 會重跑。再進一步：highlight 快取 key 已含 `content`（`:410-412`），可改成「保留舊 map、只補新 key」而非整個 `new Map()`。**成本：一行 key + 幾行 effect 調整，後者需 fence**。

**P1-4 沒有 tab-size → 縮排寬度 8（瀏覽器預設）vs 編輯器 4**
- 證據：整個 `webview-ui/src` 沒有 `tab-size`（grep 為空）；`.line-content{white-space:pre}`。
- 建議：`.line-content { tab-size: 4; }`；VS Code 沒有暴露 `editor.tabSize` 的 CSS 變數，若要跟隨設定可由 `DiffPanel.postLocale` 一併送 `tabSize` 並設 inline style。**成本：CSS 一行，需 fence**。

**P1-5 Inline 模式水平捲動時行號/±欄跟著捲走**
- 證據：`.hunk-header-inner` 有 `position:sticky;left:0`（`FileDiffView.svelte:838-844`），但 `.line-gutter`（`:992-997`）沒有；`.diff-content{width:max-content}`（`:810-816`）。
- 建議：`.line-gutter{position:sticky;left:0;z-index:1;background:inherit}`——注意 `.diff-add/.diff-delete` 的底色是半透明 rgba，sticky gutter 會透出下方文字，需改成 `background: var(--vscode-editor-background)` 疊一層同 tint 的 `::before`，或把行底色改成不透明 `color-mix`。**成本：CSS，需截圖驗證**。

**P1-6 Hunk 級按鈕預設不可見；行級按鈕離操作點很遠**
- 證據：`.hunk-stage-btn{opacity:0}` hover 才出現（`:884-891`），而 SBS `.sbs-block-stage-btn{opacity:.55}` 常駐（`:898-926`）——同一功能兩種可發現性。拖選後的「Stage Selected Lines」放在 hunk header（`:590-598`）只顯示 chevron + 數字，且 `.diff-hunk-header` 不 sticky → 長 hunk 往下拖選時按鈕已捲出畫面。
- 建議：`.hunk-stage-btn` 改 `opacity:.55`、hover 1；`.diff-hunk-header{position:sticky; top: <section-header 高度>}`（Diff tab 的 section header 高約 26px，可用 CSS 變數）；行級按鈕加文字標籤（i18n 已有 `file.stageLines`）。**成本：CSS + 一個 span，需 fence**。

**P1-7 沒有 next/prev hunk 導覽與鍵盤操作（Diff tab、Commit details）**
- 證據：`Diff.svelte` 只有模式切換；唯一鍵盤是 Esc 清選取（`FileDiffView.svelte:427-431`）。**PrView 已有現成 pattern**：`PrView.svelte:387-395` 用 `querySelectorAll('.diff-hunk, .sbs-left .sbs-hunk')` + `scrollIntoView`。
- 建議：把該 pattern 搬進 `Diff.svelte` 的 `.mode-bar`（↑↓ 按鈕 + `F7/Shift+F7` 或 `Alt+↓/↑`），並在目前 hunk 加 `outline`（已有 `.hunk-hover` 樣式可重用 `:965-969`）。**成本：小段新程式碼，Snipcode 自有檔案**。

**P1-8 word-diff 過度碎片化：整行重寫時仍逐 token 高亮**
- 證據：`word-diff.ts:145` 任何共享 bigram（`scores>0`）就配對兩行；`computeWordDiff:62-102` 對 LCS 補集全部高亮，沒有「變動比例過高就退回整行」的門檻（`lineLevelFallback:25-30` 已存在但只用於長度/DP 上限）。tokenize（`:42-44`）把空白與標點都當獨立 token，重寫行會靠空白/括號被 LCS「對齊」，產生一串 2–3 字元的碎塊。
- 建議：(a) `pairRewriteLines` 相似度門檻改 `>= 30~40`；(b) `computeWordDiff` 末尾：若高亮字元數 > 行長 60–70% 或 range 數 > 5 → 回傳 `lineLevelFallback`（IntelliJ/VS Code 都有類似 heuristic）。**成本：2–4 行 TS，需 fence**。

**P1-9 檢視選項缺失：ignore whitespace / 上下文行數 / 展開 context / 演算法**
- 證據：`git-service.ts:1003-1030` 命令固定 `diff --no-color [--cached] -- file`；`workingFileDiffRaw/stagedFileDiffRaw`（`:2484-2502`）鏡射同一命令；fingerprint 對 raw bytes（`:1035-1052`）。
- 限制：加 `-w`/`--ignore-space-change` 產生的 patch 不能 `git apply`，所以**忽略空白只能是「檢視模式」，該模式下要 disable stage 按鈕**（`stageBusy` prop 可直接借用）。`-U<n>` 則安全：patch-builder 只依 hunk 結構，只要 `getUncommittedFileDiff` 與 `*FileDiffRaw` 同步加同一個 `-U` 即可（兩處建議抽成一個 `uncommittedDiffArgs(side, file)`）。
- 建議：最小可行——`.mode-bar` 加「Whitespace: show/ignore」與「Context: 3 / 10 / Full(-U999999)」兩個 toggle → `diffShow` request 帶 options → host 組參數。「點擊 hunk 間隙展開 ±N 行」的 IntelliJ 體驗可用 Full 模式 + collapse unchanged 近似。**成本：host git 參數 + 兩處命令同步 + toggle UI；`git-service.ts` 該區已在 fence 內**。

**P1-10 語法高亮主題固定 dark-plus / light-plus；High Contrast Light 會被當成 dark**
- 證據：`highlighter.ts:87-93` 只載這兩個主題；`activeShikiTheme():140-144` 與 `CommitDetails.svelte:663-664 statusColor` 只判斷 `body.vscode-light`。VS Code 對 HC-light 蓋的 class 應為 `vscode-high-contrast-light`（請以截圖/DevTools 確認）→ 若成立，白底上會是 dark-plus 的 token 色。
- 建議：兩處加 `|| classList.contains('vscode-high-contrast-light')`（一行，需 fence）。主題不完全一致是 Shiki-in-webview 的固有限制，可接受；至少把 fallback 文字色用 `--vscode-editor-foreground`。

**P1-11 沒有 ± 統計、rename 舊名不顯示、hunk 的函式 context 沒用到**
- 證據：無 `--numstat`；`CommitDetails.svelte:995-998,1255-1257` 只渲染一個字母；`oldPath` 只用在 copy 功能（`:520`）。`DiffHunk.header` 有完整 `@@ … @@ function()` 但 `hunkLabel`（`FileDiffView.svelte:240-247`）只印「Hunk N: Lines a-b」。
- 建議：(a) 檔案列表 tooltip/description 顯示 `old → new`（資料已有）；(b) `getCommitDiff` 多跑一次 `diff --numstat -M`（或 `-z --name-status` 改 `--numstat` 併兩欄）把 `{add,del}` 併進 `files`，列表右側渲染 `+12 −3`（`--vscode-gitDecoration-addedResourceForeground` / `deletedResourceForeground`）；(c) `hunkLabel` 加上 `hunkMatch[5]` 的 trailing context（parser 已在 `header` 保留）。**成本：(a)(c) 幾行；(b) host 參數 + 型別**。

#### P2 — 打磨

- **P2-1 寫死顏色**：`.diff-add .line-prefix{#4caf50}`/`#f44336` 與 light 覆寫（`FileDiffView.svelte:1023-1027`）、`statusColor` 12 個 hex（`CommitDetails.svelte:663-685`）、`.diff-empty-line{rgba(128,128,128,.05)}`（`:988`）。改用 `--vscode-gitDecoration-{added,modified,deleted,renamed,untracked}ResourceForeground` 與 `--vscode-diffEditor-diagonalFill`；HC 主題下 `insertedLineBackground/removedLineBackground` 可能為 null → 落到 rgba fallback，建議加 `body.vscode-high-contrast .diff-add{outline:1px dashed var(--vscode-diffEditor-insertedTextBorder)}`。**CSS，需 fence**。
- **P2-2 行高固定 20px**（`:980-984`）不隨 `--vscode-editor-font-size` 縮放；改 `line-height:1.5`（或 `calc(var(--vscode-editor-font-size)*1.5)`）。**CSS**。
- **P2-3 Staged/Unstaged badge 同色**（`Diff.svelte:153-156`）；加 icon（樹已用 `check` / `diff-modified`，`changes-tree.ts:70`）或不同 tint。**CSS/markup，Snipcode 自有**。
- **P2-4 長行無 wrap 選項**（VS Code 有 `diffEditor.wordWrap`）；Inline 模式可加 toggle 切 `white-space:pre-wrap`；SBS 因兩 pane 各自排版，wrap 會錯位，不建議。**CSS toggle**。
- **P2-5 Inline 模式下 `.section-header` 只 sticky-top 不 sticky-left**，內容比視窗寬時 badge 會被捲走（需截圖確認）。
- **P2-6 ImageDiff 文字未 i18n**（`ImageDiff.svelte:127-129,135,148` "Side by Side / Swipe / Onion Skin / Before / After"）。
- **P2-7 行級選取限單一 hunk**（`lineSel.hunkIdx` 單值；`buildForwardPatchLines(raw, hunkIndex, …)` 單 hunk）——跨 hunk 拖選會重設。可接受，但 UI 應在跨 hunk 時給提示而非默默重選。
- **P2-8 mode/rename 檔的 hunk 按鈕不預先 disable**：`assertHunkStageable`（`git-service.ts:71-75`）只在按下後丟錯。parser 若補 `hasModeOrRenameHeader` 就能在按鈕上加 tooltip 並 disable。
- **P2-9 submodule / 非圖片二進位**：submodule 顯示為 `-Subproject commit …` 純文字行（可接受，可加 label）；二進位只有「Binary file」，可加大小/mode。
- **P2-10 大檔**：3000 行 render cap + 5000 行 highlight cap + 「Show full diff」按鈕（`:277,:415`）——合理，無需改。

---

### 3. 對照表

| 能力 | JetBrains Diff Viewer | VS Code 原生 diff editor | Snipcode |
|---|---|---|---|
| Side-by-side / Unified | 有（兩者，可記住） | 有（兩者） | **有但弱**（兩者皆有，但 SBS 無 hunk header/行選取；兩表面預設不同、不記住） |
| Ignore whitespace | 有（4 種模式） | 有（`ignoreTrimWhitespace`） | **沒有** |
| Word / char 級高亮 | 有（含碎片化退讓 heuristic） | 有（char 級 inner diff + heuristic） | **有但弱**（token LCS，無門檻，只對 replace 型區塊） |
| Collapse unchanged + 展開 context | 有（折疊未變區、±N 展開） | 有（`hideUnchangedRegions` + 展開箭頭） | **沒有**（固定 -U3，只有 hunk 間隔） |
| Next / prev change | 有（F7 / Shift+F7 + gutter 標記） | 有（F7 / Shift+F7 + 工具列） | **有但弱**（僅 PrView；Diff tab / commit details 無） |
| Hunk revert / stage | 有（gutter 雙向 chevron，每個 change） | 有（editor 內 Stage/Revert Selected Ranges、quick-diff peek） | **有**（Diff tab：hunk/line/block stage；commit details：reverse hunk/lines；但 SBS 缺 hunk 級、行選取限單 hunk） |
| Staged + Unstaged 同檔同畫面 | 沒有（Staging Area 模式也是分頁） | 沒有（分兩個 editor） | **有**（Snipcode 獨有優勢） |
| Inline 編輯 | 有（右側可編） | 有（modified 側可編） | **沒有**（唯讀 webview；有「開原生 diff」逃生口） |
| Rename from→to 顯示 | 有 | 有（標題兩路徑） | **沒有**（列表僅字母 R；單檔 diff 誤為整檔新增，P0-3） |
| ± 行數統計 | 沒有（僅檔數） | 沒有（SCM 僅字母） | **沒有** |
| EOL / no-newline / 空白差異可視化 | 有（⏎、空白高亮） | 有但弱（renderWhitespace） | **沒有**（P0-2、P0-4） |
| 語法高亮 | 有（IDE 完整、主題一致） | 有（主題一致） | **有但弱**（Shiki 34 種文法、固定 dark/light-plus） |
| 圖片 diff | 有（並排/透明度） | 有但弱（並排預覽） | **有**（並排 / swipe / onion + 尺寸位元組） |
| 三方合併 | 有 | 有（merge editor） | **沒有** |
| 大檔保護 | 有 | 有（maxComputationTime） | 有（3000 行 cap + 展開） |

---

### 4. 希望之後用截圖驗證的狀態

**A. Diff tab 基本結構（驗 P0-1、P1-6、body padding）**
資料：一個 ~60 行的 `.ts` 檔；改第 5、40 行 → `git add`；再改第 20、55 行不加。開 Diff tab，分別截 **SBS（預設）** 與 **Inline**。看：hunk 之間有沒有虛線/邊框、左右 pane 中間有沒有分隔線、hunk header 有沒有底色、diff 左右是否各被縮 20px、hover 前 Stage Hunk 按鈕是否不可見。**同一狀態再套一次 `import './styles/global.css'` 後重截**做前後對照。

**B. EOF 換行 + CRLF（驗 P0-2、P0-4）**
資料：檔 1 只刪掉最後一行的結尾換行；檔 2 用 `unix2dos` 把一個 5 行檔全轉 CRLF。兩者皆 unstaged，開 Diff tab Inline。預期看到「紅綠兩行內容一模一樣、無任何高亮」。

**C. Rename + 修改（驗 P0-3、P1-11）**
資料：`git mv a.ts b.ts`，改 b.ts 兩行，`git add`；另 `git mv c.ts d.ts` 不改內容並 `git add`。截 (1) Diff tab 對 b.ts、d.ts 的 Staged section；(2) commit 後在 graph 選該 commit 的 Changes 分頁點 b.ts / d.ts。預期：b.ts 全綠「新增」、d.ts 空白無字、列表只有字母 R。

**D. 長行 + 縮排 + 整行重寫（驗 P1-4、P1-5、P1-8、P2-5）**
資料：一行 > 250 字元、以 tab 縮排三層；另一處把 `const a = foo(bar, baz);` 改成 `let result = compute(x, y, z);`。Inline 模式水平捲到最右截圖；並放大重寫行看 word-diff 碎塊分佈。

**E. 主題（驗 P1-10、P2-1）**
資料：狀態 A 同一份。分別在 **Light High Contrast**、**Dark High Contrast**、**Default Light Modern** 三個主題下截 Diff tab 與 commit details 的 Changes 分頁；看 Shiki token 色與底色對比、狀態字母顏色、+/− 行底色是否退成 rgba fallback。
