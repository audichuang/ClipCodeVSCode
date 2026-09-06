# Snipcode（VS Code）Git 複審報告 — d657fca..main（五分支合併，78 commits）

> 只讀審查，未修改任何檔案。所有 P0/P1 均已親自開檔驗證（含一項用 scratch repo 實測重現）；八個並行子審查（builder / CommitGraph / git-service / Diff 三表面 / PrView / 主面板 / 側邊欄+package.json / 跨面向掃描)涵蓋全部 81 個變更檔案。

## 1. Findings

### 🔴 P0 — `discardPaths` 用 `--source=HEAD`，會吃掉已 stage 的內容、刪除新增檔案

**證據**：`graph/src/git/git-service.ts:2482-2496`，關鍵行 `:2494`：
```ts
if (trackedPaths.length) await this.exec(['restore', '--worktree', '--source=HEAD', '--', ...trackedPaths]);
```
函式上方文件註解（`:258-259`，`changes-workbench.ts`）本身就寫著錯誤意圖「tracked paths restore from HEAD」——不是手滑，是設計時語意就想錯了。兩個入口的確認 modal（`changes-workbench.ts:265` `discard`、`:279` `discardRepo`）文字都只說「捨棄 X 的變更？此動作無法復原」，沒有任何字樣提示「已 stage 的內容也會一起被吃掉」；`discardRepo`（整 repo 一次捨棄）呼叫同一支函式，bug 在批次操作時等比例放大。

**重現條件**（已在 scratch repo 實測，非猜測）：
```
MM 檔案（先 stage 一次修改，再繼續編輯）→ Discard → 檔案變回 HEAD 版本，剛才 stage 的修改憑空消失
AM 檔案（新檔 add 後再編輯）→ Discard → 檔案直接從磁碟刪除（AD），新檔案不見了
```
對照組：拿掉 `--source=HEAD`（預設 source 即 index）兩種情況都正確。

**測試盲點**：新增的單元測試只斷言送出的 argv 字串（把錯誤語意釘進測試），新增的 `staging.integration.test.ts` 只測「index=HEAD」的最簡情境，沒有 `MM`/`AM` 組合，測試綠燈完全沒攔到這個 bug。

**建議修法**：3 行——argv 拿掉 `--source=HEAD`；文件註解的「restore from HEAD」同步改成「restore from the index」（不然下個維護者照錯誤註解把 bug 改回來）；補 `MM`/`AM` 整合測試。**成本：低**。

這是本次才加的新功能（S4），不是既有回歸，但「一個會吃掉已 stage 工作、刪除新檔案的捨棄按鈕」比沒有這顆按鈕更糟——維持 P0。

---

### 🟠 P1-1 — High Contrast Light 主題下，G11/G6 的 CommitGraph 對比修正完全沒生效

**證據**：`CommitGraph.svelte:2311`（淺色降對比）、`:2321`（高對比線寬）、`:2769`（`.ref-badge`）三處選擇器都只寫 `:global(body.vscode-light)` / `:global(body.vscode-high-contrast)`，沒有 `vscode-high-contrast-light`（CSS class 選擇器沒有包含關係，不會命中）。同一批改動裡的姊妹修法做對了：`highlighter.ts:141-146`（D14）明確判斷 `vscode-high-contrast-light`（VS Code 對 HC-light 主題加的正是這個 class，不是 `vscode-light`）。切到 HC-light 主題時，G11 要修的「淺色主題對比 1.5–2.3:1，低於 WCAG 3:1」完全沒被修到。

**建議修法**：三處選擇器補上 `, body.vscode-high-contrast-light`；順手 `grep -rn "vscode-high-contrast)" graph/webview-ui/src` 抓其餘遺漏。**成本：低（5 行）**。

---

### 🟠 P1-2 — Uncommitted 的 Staged/Unstaged 分頁（M2 救活的死碼）沒跟上 X3 的 rename 修正

**證據**（三層都親自確認）：
- `graph/src/utils/message-bus.ts:129`：`getUncommittedFileDiff` payload 型別 `{file, staged}`，沒有 `oldPath`（對照同檔 `:38` 的 `getFileDiff` 已有）。
- `graph/src/panels/MainPanel.ts:804`：呼叫 `getUncommittedFileDiff(file, staged)` 沒帶 `oldPath`，即使 `git-service.ts:1058` 早支援第三參數。
- `graph/webview-ui/src/components/commit/CommitDetails.svelte:358, 629`：兩處送 `getUncommittedFileDiff` 都沒帶 `oldPath`（對照同檔 `:326` 處理 commit 的 `getFileDiff` 有正確帶）；`uncommittedFiles` 清單本來就有 `oldPath` 資料，只是沒被讀出來用。

**重現條件**：點 UNCOMMITTED 列（M2 剛救活）→ Staged 分頁 → 選一個 rename 過的檔案 → 因為 `oldPath` 沒送到 host，配不到舊路徑，渲染成「整檔新增」——正是 X3 要修的症狀換了個入口。這是兩條並行分支（`ui/main-panel` 的 M2 與 `ui/diff` 的 X3）合併後才浮現的縫隙，任一分支單獨看都測不出來。

**建議修法**：三個檔案各補 `oldPath?: string` / 轉發 / 送出，約 5-10 行。**成本：低-中**。

---

### 🟠 P1-3 — 本批改動在 3 個 vendored 檔案引入新的 SNIPCODE-HOOK 圍欄未成對閉合

**證據**（用 start/end 計數比對 baseline 與現況，鎖定批次新增的部分）：

| 檔案 | baseline (d657fca) | 現況 (main) | 本批引入 |
|---|---|---|---|
| `graph/webview-ui/src/components/graph/CommitGraph.svelte` | 2/2（平衡） | 37/36 | **新引入 1 處未閉合**（`:654`，G7 hover row index 追蹤） |
| `graph/webview-ui/src/components/commit/FileDiffView.svelte` | 25/24（既有 1 處未閉合） | 43/41 | **新增第 2 處未閉合**（`:303`，D7 highlight cache 的 `$effect`；`:53` 是既有的，非本批） |
| `graph/src/git/git-service.ts` | 34/33（既有 1 處未閉合） | 51/50 | 本批新增的 `start: ui/diff D3 rename-aware pathspec`（`:1057`）巢狀開在既有區塊內卻無專屬 `end` |

AGENTS.md 明訂「Fence every Snipcode-only edit with `/* SNIPCODE-HOOK start/end */`」是硬規則，圍欄不成對會讓依賴這個標記做結構化解析的 upstream re-sync 工具誤判邊界。不影響執行期行為，但屬於文件明訂的硬規則違反。

**建議修法**：三處各補一個對應 `end` 或重新收斂巢狀範圍。**成本：低（3 行）**。

---

### 🟡 P2 系列

1. **Rename+修改的檔案不顯示舊路徑**：`Diff.svelte:147-148`（`fileDir`/`fileBase` 只算 `store.file`）、`FileDiffView.svelte:624-632`（「重新命名自 X」只在 `renderHunks.length===0` 才顯示）。有 hunks 的 rename 檔案（比純 rename 更常見）只看到 `R` 字母，看不到舊路徑。修法：toolbar 固定顯示 `oldPath ? "old → new" : file`，不限空 hunks。

2. **hover/選取 spotlight 啟動後，G2 淡化層次被壓平**：`CommitGraph.svelte:696-699` `Math.min(g2Opacity, 0.3)`，`g2Opacity` 只會是 `1`/`0.35`，兩種情況套 `Math.min` 後都恆等於 `0.3`——`highlighted` 引數在這個分支下不起作用（算術驗證過）。只影響 hover/選取期間「非 active rail 之間」的相對層次，不影響資料正確性。

3. **X6 後殘留死運算與過期註解**：`CommitGraph.svelte:888-895` 的 `fullByAbbrev` map 用全長 hash 去查一個以「縮寫」為 key 的 map 必定 miss，靠 `?? b.hash` fallback 救回正確值——功能不壞，但整段是死運算，註解與現況矛盾，容易誤導後續維護。

4. **Stash 無訊息時 label/description 重複顯示同一字串**：`views/stashes-view.ts:51,54`，極端情況（空訊息）才觸發，已被新測試明確釘住為預期行為，屬打磨項。

5. **格式重複 + 一個 X5 遺漏的第三種日期格式**：`CommitGraph.svelte:1392-1401` 自己重新宣告 `Intl.DateTimeFormat` 而非 import 共用的 `graph/webview-ui/src/lib/utils/format-date.ts`（`CommitDetails.svelte`、`CommitHoverCard.svelte` 有 import，`CommitGraph.svelte` 沒有），程式碼註解自己承認「MainPanel's side will switch this over to importing once the branches merge」——分支已合併，這件事沒發生。目前輸出字串恰好相同（不算行為回歸），但存在漂移風險。另外同檔 `:1577` 的 tooltip 仍用 `new Date(...).toLocaleString()`（X5 原本要消滅的兩種格式之一），與同一格內顯示的 `dateStyle:'medium'` 格式不一致——X5「一個 commit 的日期到處都一樣」的訴求在 tooltip 上沒有真正達成。按任務指示這屬於 CLEANUP agent 範圍，此處僅記錄現況供之後銜接。

6. **M6「Select for compare」目前只在右鍵選單**：對應 `b4f87c2` 只加了右鍵項目，`BottomPanel.svelte`/`ui.svelte.ts` 的常駐入口未觸及——是範圍留白非回歸，列入後續波次追蹤即可。

---

## 2. 確認無問題的清單（節錄，完整覆蓋見各分項）

**Graph builder**：G1 `pickColor` 撞色迴避正確；G2 HEAD BFS 對 merge/detached HEAD/空 repo/HEAD 超出視窗四種邊界都有明確非崩潰行為；G6 `isHead`/merge 判斷順序正確；G7 `pathIndex` 只增不減、rail 重用不會指錯；X4 UNCOMMITTED parents 改用 HEAD 全長 hash，三種邊界皆正確；X6 短碼→全長改法全域無殘留（除上述 P2-3）。

**CommitGraph 互動**：R1 雙擊 checkout 已移除且 badge 雙擊保留、不冒泡；M2 UNCOMMITTED 選取非死碼、右鍵 `openScmView` 仍在、分頁閃爍修正是根本修法非掩蓋；M13 roving tabindex 與 focus ring 正確；M14 鍵盤導覽互斥正確、搜尋框內不誤觸；M5 右鍵選單重排逐行比對確認**沒有任何項目消失**，Reset 已加 `danger:true`；效能面虛擬化視窗渲染，200~2000 commits 無 O(n) 以上重繪風險。

**git-service.ts**：衝突分組三處一致；R4/S7 巢狀 repo 過濾涵蓋所有入口；DIFF `oldPath` 在 Diff 分頁與 commit 檢視兩條路徑三層呼叫一致（唯一缺口即 P1-2）；`assertHunkStageable` 拒絕訊息確實顯示給使用者；`headCommitMessage()` 空 repo有 `.catch` 保護；兩層 lock 正確套用。

**Diff 三表面**：D7（本次最關鍵懷疑點）用「content-addressed cache + per-prop effect reset」正確處理換檔重繪，`FileDiffView.lifecycle.test.ts` 專項覆蓋，**沒有狀態殘留**；D5/D8/D9/D10/D12/D14 均正確；D2/D4 顯示標記與 `patch-builder.ts` 的 Buffer/latin1 路徑互不污染；X3 後續修正（`40e91a3`）呼叫鏈完整一致。

**PrView.svelte**：requestId race 正確做到 latest-wins；emptyReason 狀態機邊界正確；P5/P7/P6/P8 均正確；統計來源與 git 同源。

**主面板**：R2（本輪最擔心的安全項）三個破壞性 modal 已無 `.primary` 按鈕可被 Enter 誤觸，且有回歸測試；M9/M11/M12/P3/M4 均正確；X3 CommitDetails 端 `getFileDiff` 正確帶 `oldPath`。

**側邊欄/package.json**：R6 草稿 clear-on-success 完整（親自追三檔驗證）；S5/S10/S12/S13/S15/S16/S17/S3/S4(除底層語意)/S8/S9/S11 均正確；package.json JSON 合法、menus↔commands 無孤兒、無新增 keybinding 衝突、version 未動、56 個設定項皆有 description。

**跨面向**：i18n 三語 key 一致（parity 測試全過）；無殘留 `console.log`/`TODO`；歷史檢視顯示調整（`historyTreeProvider.ts`/`historyView.ts`）純屬顯示、無邏輯風險；`message-bus.ts` 圍欄不平衡（7/6）在 baseline 就已是 6/5，非本批引入。

## 3. 測試弱化審核結果

八個子審查逐一掃描全部 `*.test.ts` 差異，**沒有發現任何「弱化既有斷言讓測試通過」的情況**。斷言變動可分三類：

**A. 隨修法正確反轉的狀態測試**（AGENTS.md 鼓勵）：`git-toolbar.test.ts`/`views.test.ts`（S17 ↓↑順序）、Stash label/description 對調、CommitGraph UNCOMMITTED 單擊行為、`ResetModal.test.ts`（R2 class 改名+新增回歸測試）、`PrView.test.ts`（斷言更具體化）、`ActivityLog.test.ts` 整檔刪除 126 行（對應 X7 刪除死碼元件，非弱化）。

**B. 隨 DOM/介面擴充的必要同步**：`CommitGraph.test.ts` 選單 selector 因新增 icon 子節點而調整、`commit-box-view.test.ts`/`git-toolbar.test.ts` mock 欄位擴充。

**C. 「覆蓋不足」而非「弱化」（需追蹤）**：`discardPaths` 測試只斷言 argv、整合測試沒有 `MM`/`AM` 邊界——對應 **P0**；CommitGraph 的 M13/M14/G7 目前只有純函式單元測試，缺元件層級整合測試（非阻擋項）。

## 補充：兩位 CLEANUP/i18n agent 的範圍

本次審查排除了 X1（zh-TW→簡體、host l10n 未進 VSIX）與日期格式去重，這些屬於同時在別的 worktree 進行的 `ui/i18n`/`ui/cleanup` 分支範圍，未併入本次 diff，故不列入本報告。
