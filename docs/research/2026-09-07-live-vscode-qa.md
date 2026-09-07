# Snipcode 0.3.42 — 真實 VS Code 驗收（2026-09-07）

結論：核心改善有效，但仍有兩個明確的 UI 缺口，以及一個衝突提示問題；不宜把本輪視為全部驗收完成。此次只 pull、建置、測試與記錄，沒有修改產品程式，也沒有提交／推送此專案或發版。

## 版本與環境

- [EXECUTED] 本機 `main` 從 `ca5aef5` fast-forward 到 `35c3396`，與 `origin/main` 一致。使用者提供的 `d657fca..35c3396` 已包含在同步內容內。版本仍為 `0.3.42`。
- [EXECUTED] macOS arm64，正式 VS Code `1.136.1`，commit `a44adf7f53e00964ab890f9f8758a334f1fc15bc`。
- [EXECUTED] 原生 VS Code Extension Development Host 載入目前 checkout；操作真實 webview 和 TreeView，並用 git CLI 核對結果。沒有用 mock HTML 當作 GUI 驗收。
- [EXECUTED] 真實資料環境：`~/GoogleDrive/cat`。偵測到 25 個 repo，含一個 `wt/` 下的 worktree；fast pass 24 個約 56 ms，完整掃描 25 個約 365 ms。時間是單次本機暖快取觀察，不是效能基準。
- [EXECUTED] 寫入操作只在 `/tmp/snipcode-live-qa/fixtures/{alpha,beta}` 的拋棄式 repo 執行。

## 需要收尾的問題

### P2 — High Contrast Light 的非 HEAD 分支名稱消失

[EXECUTED] 在真實 VS Code 將 QA workspace 主題設為 `Default High Contrast Light`。`beta` 的 `main` 名稱可讀，另一條分支 `qa/conflict` 只剩淡青色框，文字是白色，白底下無法辨識。

[CODE-READ] `graph/webview-ui/src/components/graph/CommitGraph.svelte:2767` 加入的亮色規則確實存在，但 `:2787` 後面的 `body.vscode-high-contrast .ref-badge` 又設回 `color: #fff`。兩條選擇器權重相同，後者覆蓋前者；HEAD badge 的更高權重規則保住黑字，因此只有一般 badge 明顯失敗。

關鍵事實：VS Code 在 High Contrast Light **同時**加入 `vscode-high-contrast-light` 與 `vscode-high-contrast`，後者是相容性 class。已查本機正式 VS Code 的 `out/vs/workbench/contrib/webview/browser/pre/index.html:490` 至 `:495`，與實際畫面一致。現有註解假設兩者互斥，這個假設不成立。

重現：開啟具有兩條分支的 repo → Git Graph → 切 High Contrast Light → 查看非 HEAD badge。建議讓深色 HC 規則排除 HC Light，並在驗收環境使用真實的雙 class 組合。

### P2 — 從 Unstaged 開啟 rename 檔，統一 Diff 的 staged 區遺失 rename 資訊

[EXECUTED] `alpha` 有已暫存的 `new-name.ts → renamed.ts`，新路徑又有未暫存編輯（`RM`）。

1. 從側邊欄 **Unstaged / renamed.ts** 開啟 Diff：已暫存區顯示 `A +40 −0`，檔頭只有 `renamed.ts`。
2. 暫存未暫存的單一 hunk 成功，index 內容確實更新，沒有 `StaleDiffError`。
3. 從 **Staged / renamed.ts** 再開同一檔：立即正確顯示 `new-name.ts → renamed.ts`、`R +1 −1`、相似度 97%。

[CODE-READ] `graph/src/tree/changes-workbench.ts:460` 只傳入點擊節點的 `node.oldPath`。`RM` 的 staged 節點有 `oldPath`，unstaged 節點只有 `M`。`graph/src/panels/DiffPanel.ts:375` 同時讀取兩側 diff 時，兩側共用這個缺失的參數。

另用實際 GitService 和獨立小 repo 重現：純 rename 的 staged 節點是 `{path: 'new.ts', status: 'R', oldPath: 'old.ts'}`，unstaged 節點是 `{path: 'new.ts', status: 'M'}`。讀 staged diff 時，帶 `old.ts` 得到 0 個 hunk，不帶則得到整份新增的 1 個 hunk。

重現：提交 `old.ts` → `git mv old.ts new.ts` → 再編輯 `new.ts` → 分別從 Staged／Unstaged 開啟同一檔。建議統一 Diff 入口依 repo/path 補齊另一側的 rename metadata，不依賴使用者點了哪一組。

補充：[EXECUTED] 真正含 rename metadata 的 staged hunk 顯示「取消暫存此 Hunk」按鈕，但點擊會得到「rename change 不支援 per-hunk staging，請操作整檔」。拒絕有保護作用；按鈕仍可事先禁用並說明限制。

### P2 — 衝突確實擋提交，但主要錯誤通知指向錯誤原因

[EXECUTED] `beta` 保留 `UU README.md` 與 `A safe-staged.txt`，填寫訊息後 Cmd+Enter。提交被阻擋，HEAD 不變，衝突與 staged 檔仍保留，草稿也保留。

但主要通知是 `Commit failed: No repo checked to commit (or nothing staged)`，與已勾選且有 staged 檔的實際狀態矛盾。側邊欄另有 `Skipped repo(s) with unresolved conflicts: beta`，所以使用者必須自己對照兩處訊息。

[CODE-READ] `graph/src/tree/changes-workbench.ts:371` 先排除衝突 repo，`:380` 在可提交清單為空時一律丟出「沒有勾選／沒有暫存」。建議在全數因衝突被擋時，主要錯誤直接指出衝突 repo。

## 已實際通過的情境

| 情境 | 證據與結果 |
|---|---|
| cat 多 repo 偵測 | [EXECUTED] repo dropdown 完整列出 25 個 repo，含 worktree；切換後名稱、HEAD、歷史更新。 |
| 多 repo Changes | [EXECUTED] cat 顯示 107 個 staged 項目、9 個待提交 repo；檔案狀態 badge／顏色存在。 |
| commit 草稿保留 | [EXECUTED] 填入文字 → 切 Explorer → 切回 Snipcode Git，草稿保留；測試後清除。 |
| Uncommitted／HEAD | [EXECUTED] cat 的未提交節點接回 HEAD，HEAD 雙環與整列標示可辨識。 |
| Tree／Flat、inline diff | [EXECUTED] cat SQL 檔切換兩種列表並開啟 diff，預設 inline、增刪底色、語法色與檔尾無換行提示正常。 |
| PR 數字 | [EXECUTED] `inv-svc-bfs-common` 的 `origin...feature/cub-cloud-4-upgrade`：78 檔、+2284／−375、領先 7 個。與 `git diff --shortstat`、`git rev-list --left-right --count` 一致。 |
| PR 左右獨立捲動 | [EXECUTED] 右側從 `.gitignore` 捲至後續檔，左側列表與上方控制列保持原位。 |
| PR 摺疊、跨 repo、空狀態 | [EXECUTED] 全部摺疊可用；留在 PR 頁切 repo 會清除舊比較並重新載入；同 ref 明確顯示「是同一個 ref，沒有可比較的內容」，新 repo 缺 base 則提示選基礎分支。 |
| Stage All／nested repo | [EXECUTED] alpha、beta 共 5 個 staged 項目；未註冊 nested repo 保持 `N`／`?? nested/`，`git ls-files --stage` 無 `160000` gitlink。 |
| Cmd+Enter 跨 repo 提交 | [EXECUTED] 真正產生兩個 commit（alpha `c689373`、beta `25227e6`），訊息皆為 `QA: verify multi-repo commit shortcut`；顯示已提交 2 個儲存庫並清空草稿。 |
| 衝突隔離 | [EXECUTED] Merge Conflicts 獨立分組；衝突不會被普通提交吞掉。訊息問題如上。 |
| graph 雙擊／方向鍵 | [EXECUTED] 雙擊 commit 沒有 checkout；Down 可移動選取並更新提交細節。git 回驗仍在原分支。 |
| Delete Branch 安全焦點 | [EXECUTED] 初始焦點在 modal container；直接按 Enter 對話框保持開啟，沒有刪除。最後取消，`refs/heads/main` 仍存在。 |
| discard MM／AM | [EXECUTED] 真 Git 整合測試確認 discard 只回復到 index，保留已暫存修改及新增檔。GUI 另確認有 modal；未在 cat 執行 discard。 |

## 自動化與封裝

精簡輸出與資料對照保存在同層 `2026-09-07-live-vscode-qa/`：`host-summary.txt`、`graph-summary.txt`、`e2e-summary.txt`、`packaged-zh-tw-summary.txt`、`rename-entry.json`、`cat-integrity.json`。

- [EXECUTED] `npm test`：**185 passed，0 failed**。
- [EXECUTED] `cd graph && TMPDIR=/private/tmp npx vitest run`：**153 files passed；2365 passed，11 skipped，0 failed**。
- [EXECUTED] `cd graph/webview-ui && npm run check`：**0 errors，0 warnings**。
- [EXECUTED] `build:graph-webview`、`build:host` 完成，main／workbench／diff 三組 JS/CSS 皆產生。
- [EXECUTED] 現有 E2E 使用本機 VS Code 1.136.1 跑完整 suite：**7 passing**，含真實 CSP webview 啟動握手、歷史／工作區複製與 byte-identical 還原。
- [EXECUTED] 額外重跑 staging、rename、hunk、line 的真 Git 整合測試：**43 passed**（屬於上述 graph 套件的子集，不重複計入總數）。
- [EXECUTED] `vsce package` 成功，VSIX 內有 `package.nls.zh-tw.json`、`graph/l10n/bundle.l10n.zh-tw.json` 與三組 webview bundle。解包後另以 Extension Development Host 啟動封裝內容，graph 握手通過。
- [EXECUTED] 在全新測試 profile 安裝 Microsoft 繁中語言套件，再啟動解包的 VSIX：`vscode.env.language === 'zh-tw'`、`vscode.l10n.t('Discard') === '丟棄'`，以及完整「沒有勾選要提交的儲存庫」host 翻譯斷言均通過；graph 仍成功啟動。先前沿用測試 profile 的嘗試回報 `en`，不算翻譯通過；上述結果來自最後的全新 profile，沒有更動日常 VS Code 的語言。

### macOS 測試 harness 缺口

原始 `cd graph && npx vitest run` 是 2364 passed、1 failed、11 skipped。單獨重跑仍在 `MainPanel.crossRepoMutation.integration.test.ts` 等不到 `stash push` 攔截。

[EXECUTED + CODE-READ] 原因是本機 `TMPDIR=/var/folders/...`，bash 的 `$PWD` 為 `/private/var/folders/...`，但 `graph/src/git/__tests__/integration/git-shim.ts:70` 比較字串是否相等。改用 `TMPDIR=/private/tmp` 後該測試與全套均通過。這是 harness 路徑正規化問題，不是跨 repo transaction 已知失效；產品程式未因此修改。

## 資料完整性與範圍

[EXECUTED] 對 cat 的 24 個已有 HEAD 的 repo，比對測試前後的 HEAD、porcelain status、cached binary diff SHA-256、working-tree binary diff SHA-256：**全部一致**。另 1 個 repo 尚無 HEAD，初始快照記錄為讀取失敗，未宣稱完成同等前後比對；本次也未對其執行寫入操作。未追蹤檔內容不在 binary diff 雜湊涵蓋範圍內。

未做：公司遠端 push／pull、每一種 merge/rebase 工作流、所有主題／窄視窗尺寸組合、剪貼簿格式的全面人工操作。沒有建立新 tag，也沒有修改 publish workflow。這是一輪針對此次 UI 改善的真實情境驗收，不代表全部功能無缺陷。
