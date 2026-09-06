## 回報

Scratchpad 根目錄：`/tmp/claude-1000/-home-audichuang-research-IntellijPlugin/3ba11787-402e-4809-86ce-a9942d1aa165/scratchpad`（以下簡稱 `$S`）

### 截圖（皆已用 Read 逐張確認非空白）

| PNG | 尺寸 | 內容 |
|---|---|---|
| `$S/graph-dark.png` | 1400×900 | 主畫面 Dark Modern：Toolbar（repo/branch pill、Graph/Reflog/Stats/PR、fetch/pull/push ↑3 badge）、搜尋列、42 列 graph（UNCOMMITTED 列、stash 列、6 條 lane、3 個 merge、tag/branch/remote badge、develop 的 3 個 local-only 小點）|
| `$S/graph-light.png` | 1400×900 | 同畫面 Light Modern（`body.vscode-light`）|
| `$S/graph-dark-2x.png` | 2800×1800 | 同畫面 device-scale-factor 2，線條/圓點細節清晰，無鋸齒/半像素問題 |
| `$S/graph-dark-details.png` | 1400×900 | 選中 merge commit `4402780`（feature/auth-login → develop）後 BottomPanel「Commit」tab：author、SHA、兩個 parent 連結、subject + body（`Closes #118, #123`）|
| `$S/graph-dark-details-file.png` | 1400×900 | 同 commit，「Changes 9」tab 展開檔案樹，點開 `src/api/orders.ts` 的 FileDiffView（inline 模式、shiki 高亮）|
| `$S/graph-narrow-dark.png` | 900×700 | 窄視窗：subject 被截斷（`ui: sticky header and column…`），超長 branch badge **不**截斷；author 欄仍是 `Bob Martí···` |
| `$S/workbench-dark.png` | 320×400 | `Workbench.svelte` commit box：多行訊息 textarea、Commit（enabled）/ Amend（stagedRepoCount=1 → enabled）|
| `$S/diff-dark.png` | 1400×800 | `Diff.svelte`：Staged / Unstaged 兩段 side-by-side，各一個 hunk，stage/unstage 箭頭按鈕、Inline/Side by Side 切換 |

### Fixture 與合成 repo

- 合成 repo：`$S/synth-repo`（bare remote `$S/synth-origin.git`），產生腳本 `$S/make-repo.sh`（可重跑）
- Fixture：`$S/fixture.json`（55 KB），由 **真 parser** 產出——`$S/dump-fixture.ts` 以 esbuild bundle 成 `dump-fixture.cjs`，直接呼叫 `GitService.log/branches/tags/remotes/stashList/worktreeList/showCommitFiles/showCommitDiff/getUncommittedDiff/getUncommittedFileDiff` + `buildFullGraph`，payload 形狀與 `MainPanel.buildLogPayload`/`fullRefresh` 一致
- Repo 概況：42 commit、3 位作者（Alice Chen / Bob Martínez / Carol 王小明）、6 本地分支 + 5 遠端分支；HEAD=develop（ahead 3 → local-only）；`origin/main` 領先 main 3 個 commit；3 個 merge（hotfix→main、hotfix→develop、feature/auth-login→develop）；tag `v1.2.0`(annotated)、`v1.3.0-rc1`(annotated)、`v1.2.1`(lightweight)；1 個 stash；工作樹髒（`src/api/users.ts` staged+unstaged、`NOTES.md` untracked）→ 真 `UNCOMMITTED` 列；2 個 >120 字 subject、`#123`/`#140` issue ref、多行 body
- 可重拍工具：`$S/gen-html.py`（產 verify-dark/light.html，內嵌 60 個 `--vscode-*` 變數 + base64 codicon 字型）、`$S/verify-harness.ts.txt`（harness 原檔備份）、`$S/shot.sh`（port 5211，支援 scale/virtual-time-budget，從 stderr 擷取 `HARNESS_METRICS`）

### 幾何量測（1400×900 dark）

- Toolbar 高 44px；`.commit-row` 高 **30px**（`ROW_HEIGHT = 30` 在 CommitGraph.svelte 硬編碼）
- graph SVG 寬 **86px**（= `ceil(maxLeftMargin 78 × 1.05) + 4`）
- lane 中心 x：10.5 / 23.1 / 35.7 / 48.3 / 60.9 / 73.5 → **車道間距 12.6px**（= builder `UNIT_W 12 × X_SCALE 1.05`；`laneX(col) = col * 1.05`）
- 線條 stroke-width：**2**（主線，opacity .85）+ **5**（光暈，opacity .07）
- 點半徑：default **4**、head **5**、merge **4 + 內圈 2**；UNCOMMITTED 為 r5 虛線
- ref-badge：font-size **12.35px**（0.95em）、行高 17px、實際高 **21px**、padding `1px 7px 1px 10px`
- 第一列 subject 文字起點 x = **22.9px**；訊息欄 `padding-left = commitLeftMargin[i] × 1.05 + 4`
- BottomPanel 高 285px（≈ innerHeight × 0.35）
- **CSS 變數關係**：`--row-height:30px`、`--lane-width:14px`、`--graph-node-radius:4px`、`--toolbar-height`、`--bottom-panel-height` 在 `global.css` 定義，但 `webview-ui/src` 內**沒有任何元件讀取**（dead vars）；實際尺寸全由 svelte 常數（30 / 1.05 / r=4）與 builder `UNIT_W=12` 決定，`--row-height` 與 30 相等只是巧合，`--lane-width 14` ≠ 實際 12.6

### 渲染過程問題 / 觀察

- **Harness 限制**：無。`App.svelte` 整體掛載成功（fake host 回應 getLog/getBranches/checkFlowStatus/getCommitDiff/getFileDiff/…），沒退到 CommitGraph+Toolbar。Codicon 以 base64 內嵌 ttf 全部顯示。avatar 圈空白是 fake host 回 `dataUri:null`，預期。
- **沒有虛線「remote-only」點**：`remote-dot` 標記只由 CommitGraph 的 `currentBranchRemoteAhead` 驅動，且只算**目前分支**的 upstream 且 `behind > 0`。HEAD 在 develop（ahead 3、behind 0），所以 origin/main 領先的 3 個 commit 只呈現為灰字 `other-branch`，不是 harness 問題，是設計。
- **疑似真 bug（未修）**：`graph/src/git/git-graph-builder.ts` `buildUpstreamMap` 把 upstream 對到 `b.hash`，而 `BranchInfo.hash` 來自 `parseBranches` 的 `%(objectname:short)`（7 碼），但 `hashIndex`/`localAncestors`/`c.hash` 全是 `%H` 全長。結果：`localHash !== c.hash` 永遠成立（origin/develop 明明落後也被當 remote tip）、`hashIndex.get(shortHash)` 為 undefined → 祖先集合只剩一個短 hash → BFS 永不停止。fixture 中 42 個 dot 有 34 個 `remoteTip:true`（含 develop 整條祖先線）。目前**無可見症狀**，因為 CommitGraph 從未渲染 `dot.remoteTip`/`dot.localOnly`——`CommitGraph.svelte:1517` 的 `{@const isRemoteTip = …}` 是未使用的 dead code。屬「潛在 bug + 死碼」。
- UI 觀察供審查：(1) `.ref-badge` 無 `max-width`，超長分支名在 900px 也不截斷，反而擠掉 subject；(2) author 欄在 1400px 仍把 `Bob Martínez` 截成 `Bob Martí···`；(3) merge commit 的「Changes 9」把 develop 側的 `orders.ts`/`validation.ts` 也列為 `A`——這是 `showCommitFilesWithParents` 對每個 parent diff 後取聯集（`mergeNameStatus`），刻意設計；(4) details 面板日期用 `toLocaleString()`（顯示 `2026/8/2 上午6:14:38`），與 graph 欄的自訂格式不一致。
- 量測雜訊（非 bug）：`viewport.h:813`、workbench `textareaRect.width:484` 是 resize 前的讀值，`file` 已確認 PNG 尺寸正確；diff 的 `hunks:0` 是我選錯 selector。

### 清理

Vite 已停；`graph/webview-ui/verify-*.html`、`src/verify-harness.ts`、`verify-fixture.json` 已刪；未在 `graph/` 建任何測試檔。`git -C ClipCodeVSCode status --short` 輸出為空（乾淨）。
