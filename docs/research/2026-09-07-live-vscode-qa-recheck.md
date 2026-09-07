# Snipcode 實機複驗 — 44ac056

日期：2026-09-07。結論：**同事列出的五項修正均通過驗證，可以關閉原問題。** 擴大實機掃描另發現 Git 2.55 的 Bisect 完成態相容性問題；不是這兩個 commit 引入的回歸。

## 環境與範圍

- [EXECUTED] 本機 main 從 `35c3396` fast-forward 到 `44ac056`，與 origin/main 一致，版本仍是 `0.3.42`。
- [EXECUTED] macOS arm64、VS Code `1.136.1`、Git `2.55.0`。重新建置後 Reload Window，使用真正的 Extension Development Host、原生 TreeView 與 webview。
- [EXECUTED] 使用 VS Code 內建的 **Default High Contrast Light** 與 **Default High Contrast**；沒有以 Light Modern 的色值冒充 HC Light。
- [EXECUTED] 寫入操作限定 `/tmp/snipcode-live-qa/fixtures/` 的 alpha／beta／gamma。cat 只用於讀取效能樣本，本輪沒有對 cat 執行 stage、commit、checkout、merge 或檔案寫入。
- [EXECUTED] 本輪從 `44ac056` 自行重建 VSIX 並驗證解包內容；沒有對同事原始 `live-qa-fixes-unreleased.vsix` 做 binary/hash 比對。
- 未修改產品程式，未提交／推送此專案，未建立 tag 或發布。前一輪報告保留。

## 五項修正結果

| 項目 | 實際重驗 | 結果 |
|---|---|---|
| QA-1：HC Light 徽章 | gamma 有 main、feature/other、qa/base、tag；非 HEAD 名稱黑字可讀。選 feature/other commit，底部詳情引用也可讀。切 HC Dark，線圖／詳情白字仍正常。 | **PASS** |
| QA-2：rename 每側 oldPath | alpha 執行 `git mv renamed.ts renamed-r2.ts`，再改新檔。先從 Unstaged 開，再從 Staged 開：兩次都是舊→新路徑、staged R／相似度 100%、unstaged M +1/−1。點暫存 hunk 後，index 的 value20 確實變成 200，staged 變 R +1/−1／相似度 97%，無 StaleDiffError。 | **PASS** |
| QA-3：全數因衝突被擋的訊息 | beta 保留 UU README.md 與 staged safe-staged.txt；取消勾選 alpha，填訊息後 Cmd+Enter。通知明確寫 `Cannot commit: unresolved conflicts in beta. Resolve them, then stage the files.`，HEAD 維持 a508b6d。另在 zh-tw 的封裝測試斷言繁中訊息。 | **PASS** |
| QA-4：macOS shim | 直接 `cd graph && npx vitest run`，沿用 `/var/folders/...` 的 TMPDIR，沒有設定 `/private/tmp` workaround。155 個檔案全部通過。 | **PASS** |
| QA-5：PR 狀態色盤 | gamma 的 qa/pr 相對 main 包含 A added.txt、D delete-me.txt、R100 demo.txt→renamed-demo.txt。在真 HC Light 看左右兩欄，新增／刪除／rename 狀態字色均可辨識。 | **PASS** |

## 擴大 HC Light 實機掃描

以下都是本輪在 VS Code 實際觸發、查看的狀態；不是只看 selector 測試。

| 元件 | 已查看的狀態 |
|---|---|
| CommitGraph | 非 HEAD／HEAD／tag 徽章、線條、日期；另做 HC Dark 回歸。 |
| CommitDetails | 引用徽章、提交資訊、父提交連結；另做 HC Dark 回歸。 |
| CommitHoverCard | 父提交浮動卡片，HC Light 與 HC Dark 皆可讀。 |
| Toolbar | repo 下拉；未驗 Git Flow 子選單（本機未安裝 git-flow）。 |
| SearchBar | 分支篩選下拉、搜尋欄、checkbox。 |
| ContextMenu | commit／branch 右鍵操作選單。 |
| Reflog | 真實 reflog 清單與操作類型篩選下拉。 |
| Modal | Reset／Merge 的 branch/hash pill、內容、按鈕。 |
| ColorSelect | Reset 類型下拉，選 hard 後顯示警告；最後取消，沒有執行 hard reset。 |
| InteractiveRebase | 預覽選 Drop：動作 badge、刪除線、「將丟棄 1 個提交」警告；取消該預覽。 |
| App | 另一次真的執行 Edit rebase，查看紫色 pause banner，再中止恢復分支；實際 merge 衝突的橘色 banner、未解決／已解決標記。 |
| ConflictFilesPopover | Merge 預測的「預計衝突檔案 / README.md」浮層。 |
| PrView | 3 檔 A／D／R 比較、rename 空 diff 說明、增刪統計。 |
| BisectBanner | 進行中藍色 banner 可讀；**完成態被下面的既有邏輯問題阻擋，不能標為已驗通過。** |

這是實際狀態抽樣，不代表每個元件的所有分支、所有尺寸與全部主題都驗過。Merge／rebase／bisect 測試結束後，beta／gamma 已退出操作狀態並恢復原分支；gamma 的 PR 樣本提交是刻意保留的測試資料。

## 額外 P2：Git 2.55 的 Bisect 完成態無法辨識

[EXECUTED] gamma 以 QA step 7 為 bad、step 3 為 good，從 graph 右鍵啟動 Bisect。連續標記兩次 bad 後，git 已找到 step 4；`git bisect log` 也記錄 first bad。但 UI 仍顯示「正在進行二分查詢」，保留好／壞／跳過按鈕，沒有完成態與 culprit 高亮。

真實 git 2.55.0 輸出：

```text
c07980670f739b4341606b7ca942f1bb39a9a01a is the first 'bad' commit
```

[CODE-READ] 兩處仍只比對沒有引號的 `is the first bad commit`：

- `graph/webview-ui/src/components/common/BisectBanner.svelte:16`：完成態。
- `graph/webview-ui/src/App.svelte:544`：culprit hash。

已比對 `35c3396`，原版也有相同 predicate，因此不是 HC selector 修改造成的回歸。建議兩處共同支援有／無引號的實際輸出，並用 Git 2.55 的原始文字補測。不能只改 banner，否則 culprit 仍不會標出。

可重跑診斷：`python3 docs/research/2026-09-07-live-vscode-qa-recheck/repro-bisect.py`。只操作自己建立的臨時 repo，輸出實際 Git 結果與目前 UI predicate 能否辨識。

## 較輕微的補充觀察

- [EXECUTED + CODE-READ] Merge 預測提示的 `Merge 衝突 1 個檔案` 仍用固定 `#f0a020`（`MergeBranchModal.svelte:124`），在白底約 **2.15:1**，比新的 ColorSelect 警告淡。這個選擇器不在本輪改動內，列為後續視覺改善，未計入五項失敗。
- [EXECUTED，原因尚未定位] 在 merge 衝突中，從終端改寫 README.md 並 `git add` 後，原生 SCM 已變 staged，graph banner 的觀察畫面仍停在 0/1；點 plugin 的「標記解決」後立即變 1/1。應另補外部 stage→banner 刷新的獨立測試；本輪不宣稱已定位根因或確認回歸範圍。

## 測試與封裝

| 檢查 | 本機實際結果 |
|---|---|
| npm test | 185 passed / 0 failed |
| graph vitest（不改 TMPDIR） | 2374 passed / 11 skipped，155 files passed |
| graph tsc --noEmit | exit 0 |
| svelte-check | 0 errors / 0 warnings |
| 三個 webview bundle＋host build | 成功 |
| 現有 E2E，正式 VS Code 1.136.1 | 7 passing / exit 0 |
| vsce package | 成功，約 1.33 MB |
| 解包 VSIX 後的 zh-tw host＋graph 啟動 | PASS；版本 0.3.42、locale zh-tw，新增訊息為「無法提交：beta 有未解決的衝突。請先解決衝突並暫存檔案。」 |

測試證據與效能數據在同層 `2026-09-07-live-vscode-qa-recheck/`。

## status 查詢成本

[EXECUTED] 用 `35c3396` 與 `44ac056` 的 GitService，讀同一檔 staged＋unstaged 兩側。每組先暖機一次，再交錯測五次；每次清 service read cache，**檔案系統仍是暖快取**。以下只含資料層，沒有 UI render／整個 workbench refresh。

| 樣本 | 前版中位數 | 新版中位數 |
|---|---:|---:|
| 小型 repo，無 untracked | 15.4 ms | 24.2 ms |
| 小型 repo，5000 個 untracked | 13.6 ms | 26.8 ms |
| cat / inv-svc-bfs-common 的 SQL diff | 14.6 ms | 30.1 ms |

成本確實增加；這組本機樣本沒有達到明顯卡頓量級。沒有測冷快取、網路磁碟、數十萬 untracked 或大量並行使用者操作，不據此保證那些情境的延遲。
