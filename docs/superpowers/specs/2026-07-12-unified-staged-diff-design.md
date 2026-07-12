# Unified Staged/Unstaged Diff View — Design

日期：2026-07-12 · 分支：`feat/unified-staged-diff`（自 `dev` 分出）

## Goal

把 Diff 編輯器分頁從「一個分頁只顯示一個 side（staged **或** unstaged），單向
箭頭」改成 **一個分頁同時顯示同一檔案的 Staged 與 Unstaged 兩區、箭頭雙向
stage/unstage**，靠近 IntelliJ 的雙向 move 體驗。

現行單側分頁的痛點：要在 staged / unstaged 之間切換分頁才看得到檔案的兩種狀態。
統一視圖讓「哪些已 stage、哪些還沒」一眼可見，並直接在同一畫面雙向搬移。

## 選定方案：Approach A（上下兩區）

一個 diff 分頁內同時渲染兩個**既有**的 diff：

```
╭─ foo.ts ───────────────────────╮
│ ▾ Staged (HEAD ↔ index)         │
│   12 + staged line        ‹     │   ‹ = unstage（往 working 搬回）
│   13 + staged line              │
│─────────────────────────────────│
│ ▾ Unstaged (index ↔ working)    │
│   20 + new line           ›     │   › = stage（往 index 搬進去）
│   21 - old line                 │
╰─────────────────────────────────╯
```

- Staged 區 = `git diff --cached`（HEAD ↔ index），箭頭 `‹` 執行 **unstage**。
- Unstaged 區 = `git diff`（index ↔ working），箭頭 `›` 執行 **stage**。
- 每區各自是原本的 diff，**hunk/line index 天生就對齊該側 diff**，所以 stage/unstage
  的 patch-builder 呼叫完全不用重映射。

### 為何不選 Approach B（單一 HEAD↔working diff + block 標記）

B 要三樹（HEAD/index/working）關聯，並把 block index 從 HEAD↔working diff
重映射回「stage 操作實際用的那一側 diff」的 index，易錯、風險高。A 完全復用
既有兩份 diff 與現成的 stage/unstage 路徑，風險低。

## 資料流

`DiffPanel` 從「以 (file, side) 為單位」改成「以 file 為單位」：

1. 開檔：`show(repoPath, file)`（丟掉 `side`）→ 同時抓
   `fileDiffData(staged)` + `fileDiffData(unstaged)` → 一次 `diffShow` 兩份 diff。
2. stage/unstage 訊息 **維持帶 `side`**（section 自己知道方向）→ host 的
   `stageLines`/`unstageLines`/`stageHunks`/`unstageHunks` handler **不動**
   （已從 payload 讀 `side` 決定方向）。
3. 操作後 `refreshIfCurrent(repoPath, file)`（丟掉 side）→ 重抓兩份、重推 →
   兩區一起更新（被搬走的 block 從一區消失、出現在另一區）。

## 改動點（全在既有檔案）

1. **`graph/src/panels/DiffPanel.ts`**
   - `current` 從 `{repoPath, file, side}` → `{repoPath, file}`。
   - `show(repoPath, file)` / `refreshIfCurrent(repoPath, file)` 丟掉 `side`。
   - `pushDiff` 抓兩份 diff，post `diffShow` payload = `{repoPath, file, stagedDiff, unstagedDiff}`。
   - stage/unstage 訊息 handler：邏輯不變（仍讀 `side`），只是操作後改呼叫
     不帶 side 的 `refreshIfCurrent(repoPath, file)`。
   - **不改 `graph/src/utils/message-bus.ts`**（codex 審查修正）：DiffPanel 的 diff bundle
     protocol **不走** typed `WebviewMessage`/`ExtensionMessage` —— `diffShow` / `diffReady`
     / `diffStageHunk` / `diffStageLines` 都是 DiffPanel.ts（producer）與 diff bundle
     messaging.ts（consumer）之間的 **raw / untyped** 訊息。改 message-bus 只是假型別安全、
     執行時仍會漂移。payload 形狀維持現況做法（raw），只改 producer + consumer 兩端。
     - `diffShow` payload：`{repoPath, file, side, diff}` → `{repoPath, file, stagedDiff, unstagedDiff}`。
2. **`graph/webview-ui/src/diff/diff-store.svelte.ts`**
   - state 從 `side` + `diff` → `stagedDiff` + `unstagedDiff`（+ repoPath/file）。
   - `setDiff` 改 `setDiffs(repoPath, file, stagedDiff, unstagedDiff)`；`reset` 對應調整。
3. **`graph/webview-ui/src/diff/messaging.ts`**
   - `diffShow` 接收改存兩份；`postStageHunk`/`postStageLines` 帶明確 `side` 參數
     （由 section 傳入）。
4. **`graph/webview-ui/src/diff/Diff.svelte`**
   - 渲染最多兩個 section：每個 = 標題列（`Staged`/`Unstaged` 標籤 + 收合 ▾）
     + `FileDiffView`（`staged` prop 設對、`stacked={true}` 讓外層單一長頁 scroll、
     `onStageHunk`/`onStageLines` post 對應 side）。
   - `mode`（inline/side-by-side）兩區共用一個 toggle。收合狀態切換檔案時重置。
   - **`FileDiffView.svelte` 不改**（現有 block 箭頭直接沿用：staged 區 `‹`、unstaged 區 `›`）。
5. **`graph/src/tree/changes-workbench.ts`**
   - `showInDiffView(node)` 丟掉 `node.group`，改 `diffPanel.show(node.repoPath, node.path)`。

## 邊角處理

- **只有一側有變更**：只渲染那一側的 section（仍帶標籤）。**presence 判斷依
  `diff !== null`，不是 `hunks.length === 0`**（codex 審查修正）—— binary / pure
  rename / mode-change 的 `DiffData` 是非 null 但 `hunks: []`，用空 hunks 判斷會把
  binary-only 一側錯誤顯示成「No changes」。
- **binary / image**：一側是 binary 時 `diff !== null` 仍渲染該 section，內容是
  `FileDiffView` 的 binary 殼（既有行為）。**真正的 image before/after 預覽是既有
  gap**（`ImageDiff` 送 `getImageAtRef`，DiffPanel 從未處理該訊息）——非本次目標，
  維持顯示殼、不 crash；列入 backlog，設計不宣稱「沿用可運作的 ImageDiff」。
- **兩側都 null**：理論上不會（無變更的檔案不出現在 tree）；防禦性顯示「No changes」。
- **收合**：標題列可點收合 section 內容（長檔案兩區都展開會很長）。v1 就做，成本低。

## Race / refresh 一致性（codex 審查）

- **combined fetch 共用一張 SequenceGuard ticket**：`show` 抓兩份 diff 用同一張
  ticket，`Promise.all` 兩份都完成後檢查一次 `isCurrent()`、只 post 一次 `diffShow`。
  rapid file navigation 仍是 latest-wins，不會半份舊半份新。
- **已接受的既有殘留**（非本次擴大）：`runExclusive` 只包 git mutation，tree/panel
  refresh 在鎖外；任何 `diffShow` 都無條件清 `busy`。因此極快速「stage 後在
  authoritative refresh 前再點一次」理論上可能帶到舊 diff 的 hunk/line index。**這是
  單側視圖既有的風險，統一視圖不改變 per-side stage 語意、不擴大它。**
  <!-- ponytail: 接受既有 race；要收緊就把 diffShow 與 mutation request 用
       operation id 關聯、mutation 進行中 gate 住 busy。等有實際重現再做。 -->
- **已接受的既有殘留（二）— 兩份 diff 非原子快照**（codex 實作審查 Major 1）：
  `push` 用 `Promise.all` 平行啟兩個 git read，read 刻意不等 mutation lock。若在兩
  read 之間有其他 mutation（外部 terminal git / 併發操作）interleave，可能組出
  split snapshot（極端下短暫誤顯示 No changes，或同一變更暫時兩區都出現）。單一使用者
  正常流程下 mutation 經 `runExclusive` 序列化、post-mutation refresh 在 mutation
  完成後才跑、busy gate 擋住重複點擊，故實際觸發需外部併發 git；且 FileWatcher 的下一次
  refresh 會自我修正。**接受為 v1 殘留**（與單側視圖同級風險，未擴大）。
  <!-- ponytail: 要真原子就把兩 read 併成單一 git 呼叫或包進 read 專用短鎖；
       等有實際重現再做。 -->
- **後續驗證**：補一個 deterministic race test（git-shim 卡住一次 mutation）確認
  上述殘留的實際可達性，再決定是否加 operation correlation。列 backlog，不擋 v1。

## 測試

- **webview（vitest happy-dom）** — 新增 `Diff.svelte` 測：
  - 雙 diff → 兩個 section；只有 unstaged diff → 一個 section；binary-only 一側
    （`diff !== null`, `hunks: []`）仍渲染 section（不顯示 No changes）。
  - Staged 區的箭頭觸發時 post `side:'staged'`；Unstaged 區 post `side:'unstaged'`。
  - 收合 toggle 隱藏/顯示該 section 內容。
- **需 UPDATE 的既有測試**（codex 審查：改 payload/store 會讓它們變紅，列為修改非新增）：
  - `graph/webview-ui/src/diff/__tests__/messaging.test.ts` — 依賴舊 `diffShow` payload / `postStage*` 簽章。
  - `graph/webview-ui/src/diff/__tests__/diff-store.test.ts` — 依賴舊 `setDiff`/`side`/`diff` state。
- **host（vitest 真 git）** — `DiffPanel`：
  - `show(repoPath, file)` 抓兩份 diff、`diffShow` payload 含 `stagedDiff`+`unstagedDiff`。
  - stage 後 `refreshIfCurrent(repoPath, file)` 重推兩份。
- 既有 `FileDiffView.test.ts`（35 測）介面未變，不受影響。

## 非目標（YAGNI）

- 跨區拖曳搬移、move 動畫。
- per-section 各自的 inline/SBS toggle（共用一個即可）。
- image before/after 預覽（既有 `getImageAtRef` gap，見「邊角處理」）；binary 只顯示殼。

## Gotchas

- `FileDiffView.svelte` 是 vendored 上游碼；本設計刻意**不改它**，改動集中在 host、
  message-bus、diff bundle 的 store/messaging/Diff.svelte。若最終仍需微調
  `FileDiffView`，改動包 `/* SNIPCODE-HOOK */` fence。
- diff bundle 必須 self-contained（見 `graph/AGENTS.md`）。
- stage/unstage 已透過 `runExclusive` 序列化，統一視圖不改變此保證。
