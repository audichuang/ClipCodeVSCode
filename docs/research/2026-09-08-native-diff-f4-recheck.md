# Native Diff / F4 第二輪複驗

日期：2026-09-08。範圍：HEAD f6a92fa 上的目前未提交改動。此為審查，未修改產品程式碼。

## 結論

前一輪主要案例已有修復，但仍有三項正確性問題，不宜宣稱全面完成。

### P2：跨側選行後 F4 使用舊的 Unstaged 選取

位置：`graph/webview-ui/src/diff/Diff.svelte:130–136`。

在原生 VS Code Extension Development Host 重現：同一檔案已暫存修改第 5 行、未暫存修改第 25 行；先點未暫存第 25 行行號，再點已暫存第 5 行行號，按 F4。實際開啟 `sides.ts (Working Tree)`，狀態列 `Ln 25, Col 1`，而不是最後操作的已暫存側。兩個子元件各自保留選取，解析函式固定優先採用 Unstaged。應記錄最後操作的側別與行號，或切側選取時清除另一側的跳轉狀態。

### P2：關閉面板沒有使待處理原生跳轉失效

位置：`graph/src/panels/DiffPanel.ts:343` 的 onDidDispose 與 `:595` 的 dispose。

序號機制已處理 show(A) → show(B)，但未處理關閉。以延遲 uncommittedStatus 的重現測試確認：開始 A 跳轉 → dispose → 釋放狀態結果，仍執行 vscode.diff 開啟 `/r/a.ts`。關閉也應使 nativeOpenSeq 失效。測試紀錄：`/tmp/snipcode-native-dispose-review.log`；重現測試保留於 `/tmp/snipcode-native-dispose-review.test.ts`，不留在產品測試目錄。

### P2：hasHead 把 Git 執行失敗當成 unborn

位置：`graph/src/git/git-service.ts:2572–2575`。

catch-all 將任何失敗轉成 false。以實際方法注入 `spawn git ENOENT` 確認也回傳 false。這不等於 HEAD 不存在。原生比對的新呼叫點會據此使用空左側；如果該次探測暫時失敗、後續 Index 讀取成功，會把既有檔案錯誤呈現為整檔新增。應只將明確的 missing HEAD 結果視為 unborn，其他操作錯誤向上傳遞。這是錯誤分類檢查，未在實機注入 Git 故障。

## UI 評估與限制

實機 Dark Modern 下，工具列與 Staged/Unstaged 分組更緊湊，卡片裝飾減少，程式碼閱讀空間較一致。Hunk 按鈕雖平時透明，但 CSS 有 :focus 顯示規則，不能判定為鍵盤焦點不可見。

另有需補驗的 CSS 風險：`FileDiffView.svelte:1265–1282` 將 sticky 行號底層的實色背景改為單層透明主題色，失去遮蔽後方文字的保證。本輪原生水平捲動未成功移動內容，因此未將文字穿透列為已實機重現。建議保留實色底層，再疊加增刪／選取色。

「背景全部降低到 10%」也不精確：10% 是 fallback；實際 VS Code 主題 token 有值時仍採主題值。本輪未驗所有 Light / High Contrast 主題。

## 已驗證通過

- 真 Git unborn repo：首次 git add 後從 Webview 按 F4，原生 Staged 比對左側空白、右側正確顯示內容，未出現 invalid HEAD 錯誤。
- 真 Git staged-only delete：從 Webview 按 F4，原生 Staged 比對顯示刪除內容，未開啟不存在的磁碟檔。
- 程式碼與針對性測試確認 A → B 的舊請求失效邏輯已加入。
- 硬編碼 F4 window handler 已移除，使用已註冊命令管道。
- Graph 全套：163 測試檔，2,491 passed / 11 skipped。
- Svelte check：0 errors / 0 warnings。
- Extension 與 Webview build 成功。

測試工作區：`/tmp/snipcode-f4-recheck/review.code-workspace`，含雙側修改、unborn 與 staged-only delete 三個 repo。未變更 cat 的檔案或 Git 狀態，未 commit / push。
