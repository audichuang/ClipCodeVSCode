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
2. **`graph/src/utils/message-bus.ts`**
   - `diffShow` payload 型別：`side, diff` → `stagedDiff, unstagedDiff`。
   - stage/unstage 訊息型別不變（保留 `side`）。
3. **`graph/webview-ui/src/diff/diff-store.svelte.ts`**
   - state 從 `side` + `diff` → `stagedDiff` + `unstagedDiff`（+ repoPath/file）。
   - `setDiff` 改 `setDiffs(repoPath, file, stagedDiff, unstagedDiff)`；`reset` 對應調整。
4. **`graph/webview-ui/src/diff/messaging.ts`**
   - `diffShow` 接收改存兩份；`postStageHunk`/`postStageLines` 帶明確 `side` 參數
     （由 section 傳入）。
5. **`graph/webview-ui/src/diff/Diff.svelte`**
   - 渲染最多兩個 section：每個 = 標題列（`Staged`/`Unstaged` 標籤 + 收合 ▾）
     + `FileDiffView`（`staged` prop 設對、`onStageHunk`/`onStageLines` post 對應 side）。
   - `mode`（inline/side-by-side）兩區共用一個 toggle。
   - **`FileDiffView.svelte` 不改**（現有 block 箭頭直接沿用：staged 區 `‹`、unstaged 區 `›`）。
6. **`graph/src/tree/changes-workbench.ts`**
   - `showInDiffView(node)` 丟掉 `node.group`，改 `diffPanel.show(node.repoPath, node.path)`。

## 邊角處理

- **只有一側有變更**：只渲染那一側的 section（仍帶標籤）。判斷依 `diff` 是否為
  null 或 hunks 為空。
- **兩側都空**：理論上不會（無變更的檔案不出現在 tree）；防禦性顯示「No changes」。
- **收合**：標題列可點收合 section 內容（長檔案兩區都展開會很長）。v1 就做，成本低。

## 測試

- **webview（vitest happy-dom）** — 新增 `Diff.svelte` 測：
  - 雙 diff → 兩個 section；只有 unstaged diff → 一個 section。
  - Staged 區的箭頭觸發時 post `side:'staged'`；Unstaged 區 post `side:'unstaged'`。
  - 收合 toggle 隱藏/顯示該 section 內容。
- **host（vitest 真 git）** — `DiffPanel`：
  - `show(repoPath, file)` 抓兩份 diff、`diffShow` payload 含 `stagedDiff`+`unstagedDiff`。
  - stage 後 `refreshIfCurrent(repoPath, file)` 重推兩份。
- 既有 `FileDiffView.test.ts`（35 測）介面未變，不受影響。

## 非目標（YAGNI）

- 跨區拖曳搬移、move 動畫。
- per-section 各自的 inline/SBS toggle（共用一個即可）。
- image/binary 在統一視圖的雙區呈現（沿用既有單一 ImageDiff 行為）。

## Gotchas

- `FileDiffView.svelte` 是 vendored 上游碼；本設計刻意**不改它**，改動集中在 host、
  message-bus、diff bundle 的 store/messaging/Diff.svelte。若最終仍需微調
  `FileDiffView`，改動包 `/* SNIPCODE-HOOK */` fence。
- diff bundle 必須 self-contained（見 `graph/AGENTS.md`）。
- stage/unstage 已透過 `runExclusive` 序列化，統一視圖不改變此保證。
