# Snipcode Git 主場：Inline Blame + 多 repo 提交工作台 — 設計文件

- 日期：2026-07-11
- 狀態：已通過 brainstorming，待使用者複審 → writing-plans
- 目標讀者：實作此功能的 AI agent / 開發者

## 背景與動機

原生 VS Code 的 git 提交／暫存體驗被廣泛認為難用；社群長年懷念 IntelliJ 的
git 工具（inline blame、逐 hunk 提交、跨 repo 統一提交）。獨立 app「rebased」
（DetachHead/rebased，實為只留 git 的 IntelliJ Community fork，JVM）大受好評，
但它結構上重（CPU 高、啟動慢、macOS 簽章問題），因為它其實還是個 IDE。

Snipcode 的機會：**留在 VS Code 內、輕量、與編輯器/擴充/AI 生態無縫**，把原生
SCM 最難用的「工作區／提交」那一側接管掉，同時保留 Snipcode 獨有的 ClipCode
剪貼簿武器。Snipcode 現有的 `graph/`（vendored git-graph-plus）已涵蓋歷史側操作
（interactive rebase、cherry-pick、reset、reflog、bisect、amend…），本設計專攻
它刻意讓給 VS Code SCM 的**工作區側**缺口。

## 整體形狀：一個產品、三個表面

1. **編輯器內 — Inline Blame**（Slice A，獨立）：長在正在看的檔案上，不碰 webview。
2. **獨立面板「Snipcode Git」— 多 repo 提交工作台**（Slice B，旗艦）。
3. **既有的 Graph webview — 原封不動**：graph 操作、PR、history、reflog、
   interactive rebase 全部保留，本次不碰。

兩個 slice 各自獨立出貨。Slice A 先做（快、有感、零 webview 依賴），Slice B 為旗艦。

## 明確不做（YAGNI）

- 提交面板裡的 paste/restore（已在 File 區）。
- 提交面板裡的 PR copy（已在 Graph）。
- 自製三欄 merge conflict 工具（維持委派 VS Code 內建，日後另議）。
- changelist 命名分組（先做 hunk staging；命名分組留第二階段）。
- blame 的「當前行 inline 常駐」模式（見 Slice A 決策：改為 per-檔案按鈕觸發）。

---

## Slice A — Inline Blame（編輯器內，host 端）

### 落點
- 新模組 `src/blame/`，純 host、不碰任何 webview。
- git 資料：spawn `git blame --porcelain`（複用 `src/graphCopy.ts` 的 spawn 模式）。
- 畫面：VS Code `TextEditorDecorationType`。

### 觸發方式（關鍵決策）
仿 IntelliJ annotate：**預設全關**，靠**編輯器標題列（`editor/title`）的一個
blame icon 按鈕**觸發，不是命令面板開關、也不是全域設定。

- 點按鈕 → 對**目前這個檔案**打開逐行 annotate；再點一次關閉。
- **per-editor 狀態**：A 檔開啟不影響 B 檔；切到 B 檔預設關，要在 B 自己點。
- 技術上按鈕仍綁一個 command id，但帶編輯器脈絡、只影響該檔——體驗即「點按鈕、
  per 檔案」。

（不做「當前行 inline 常駐」預設；一切以 per-檔案按鈕為準。）

### 顯示與互動
- 逐行左側顯示「作者 · 相對時間」。
- **age 顏色**：commit 時間映射色帶（新＝亮 accent，舊＝淡灰），可設定。
- **hover**：commit hash／作者／日期／訊息，附「在 Graph 開啟此 commit」連結
  （複用既有 graph open-at-commit 命令）。
- **點擊** annotation → 跳到 graph 的該 commit。
- **未提交的行**：顯示「你 · 未提交」。

### 資料流與效能
- blame 結果**快取**在 `file path + HEAD`；檔案存檔／HEAD 變動／編輯時失效。
- 全非同步 spawn；spawn 逾時有上限。
- 大檔以 `-L` 範圍處理（若日後加當前行模式）；本設計預設整檔 annotate 僅在按鈕
  開啟時才跑。

### 錯誤處理
非 git 檔／新檔／blame 失敗 → 靜默不顯示（不跳錯誤打擾）。

### 測試
- `git blame --porcelain` parser 單元測試（含未提交行、moved line、多作者）。
- age→顏色映射純函式測試。
- decoration 渲染（VS Code API）以 e2e smoke 帶一發。

---

## Slice B — 多 repo 提交工作台（獨立 webview 面板）

### 佈局模型（IntelliJ 模式，關鍵決策）
- **repo 只是顯示分組，不是提交單位。**
- **一個共用的 commit 訊息框**，勾選可**橫跨多個 repo**。
- 按 Commit → 對「有勾到變更的每個 repo」各下一次 `git commit`，**共用同一則訊息**
  （git 無法讓一個 commit 跨 repo，底層是 N 個 commit、UX 上是一次動作、一則訊息）。
- 全部 repo 同時列出、依 repo 折疊分組，從根本避開「切 active repo」競態
  （該競態是 CHANGELOG 最大 bug 來源）。

```
┌ Snipcode Git ─────────────────────────────┐
│ ▾ repo-A   3 changes                       │
│    ☑ M  src/foo.ts                         │
│         ▸ hunk 1 ☑   ▸ hunk 2 ☐            │
│    ☑ A  src/bar.ts                         │
│ ▾ repo-B   1 change                        │
│    ☑ M  lib/util.ts                        │
│ ─────────────────────────────────────────  │
│ ┌ commit message（共用一個）───────────┐   │
│ │ 修正手續費計算                        │   │
│ └───────────────────────────────────────┘   │
│ [Commit 勾選的變更]  [Amend]  [⧉ 複製成 ClipCode]│
└────────────────────────────────────────────┘
```

### 落點與 host
- **新的 webview view**，放在自己的 Activity Bar 容器（持久側欄）。自己的
  message bus / stores / UI。
- **共用 host `git-service.ts`**（純 CLI 層、UI 無關），新增工作區方法：
  - `getStatus(repo)`：`git status --porcelain=v2` 解析變更類型（M/A/D/R/?）。
  - `getWorkingDiff(repo, file)`：工作區 vs HEAD 的 diff，切成 hunks。
  - `stageHunks(repo, patch)`：`git apply --cached` 套選取的 patch；patch 建構
    **複用 `reverseCommitChanges` 已有的 hunk/行粒度邏輯**。
  - `commit(repo, message, opts)`。
  - 多 repo 探索複用 `services/repo-discovery.ts`。

### staging 運作（關鍵決策：虛擬／延遲 staging）
- 勾選框是**純 webview 狀態**，**按 Commit 前完全不碰 git index**。
- 按 Commit 時才把勾到的 hunk 組成 patch → apply 到 index → commit。
- 這是 IntelliJ 模型（提交前皆虛擬），競態最少，也不與使用者在 CLI 手動
  `git add` 的狀態打架。
- **不採用**「即時 staging」（每點一下即 `git apply --cached`）——會製造大量 git
  呼叫與競態。
- 待 plan 解決的實作細節：提交時如何與「使用者預先在 git index 已 staged 的內容」
  調和。建議方向：**以面板勾選為提交當下的事實來源**，用臨時 index / 精準 patch
  只提交勾選項，提交後不破壞其餘工作區狀態。

### 元件（webview UI）
- `RepoGroup`：可折疊、顯示變更數。
- `FileRow`：tri-state 勾選（全／部分／無 hunk 選取）＋變更類型徽章＋路徑。
- `HunkView`：展開檔案 → 每 hunk 一個勾選＋diff 行。
- `CommitBox`：共用單一訊息框 + Commit / Amend / ⧉ 複製成 ClipCode 按鈕。
- **待 plan 決定**：diff 呈現共用 graph 那套 Shiki diff 模組，或做精簡版（獨立
  面板拿不到 graph webview 的 Svelte 元件）。

### 資料流
1. 開面板 → host 探索 repos → 各自 `getStatus` → 分組樹渲染。
2. 檔案／HEAD watcher（debounce）刷新 status。
3. 勾選 hunk = 純 webview 狀態（無 git 呼叫）。
4. Commit → webview 送 `{message, repos:[{repo, selectedHunks[]}]}` → host **逐
   repo** 建 patch→apply→commit（走既有 `withMutationLock` 序列化）→ 回傳**每
   repo 結果**。

### 錯誤處理
- **部分失敗逐 repo 回報**（repo-A ✓ / repo-B ✗ 原因）；失敗**不清空訊息框**。
  （呼應 CHANGELOG「衝突暫停卻誤報成功」的教訓——絕不假裝整批成功。）
- 沒勾任何東西 → Commit 停用。
- **Amend 只在勾選集中於單一 repo 時可用**，否則停用並提示（amend 動的是各 repo
  的 HEAD，跨 repo 無意義）。
- pre-commit hook 失敗 → 把 hook 輸出攤給使用者。
- 處於衝突／merge 中的 repo → 顯示 banner，延用既有衝突流程（仍委派內建 merge）。

### 併發
- commit 為本地操作（無網路），仍走既有 `git-service` 的 `withMutationLock` 逐
  repo 序列化。

### ClipCode 接點（唯一）
「⧉ 複製成 ClipCode」= 取勾選的檔案／hunk，用既有 `src/clipboardFormat.ts` 的
`buildPayloadInternal` 組成 ClipCode payload（把現有「Copy Git Changes」從整檔擴
到選取 hunk）。paste 與 PR copy 不在此面板（各有歸屬）。

### 測試
- `git status --porcelain=v2` parser 單元測試。
- hunk patch builder 測試（複用／擴充 `reverseCommitChanges` 測試）。
- **commit-selected integration**（真 git repo）：選部分 hunk → commit → 斷言只
  提交那些、其餘留工作區。
- 多 repo 共用訊息 commit integration：兩 repo、一則訊息、各得一個 commit。
- 部分失敗路徑（repo-B commit 失敗時的回報與訊息框保留）。

---

## 出貨順序

1. **Slice A（Inline Blame）** — 獨立、快、感知價值高，先出貨累積動能。
2. **Slice B（提交工作台）** — 旗艦；多 repo 與 ClipCode 接點收在其中。

每個 slice 各自走 spec → plan → 實作循環；本文件同時涵蓋兩者的設計骨架，實作計畫
（writing-plans）會為各 slice 展開細部步驟。
