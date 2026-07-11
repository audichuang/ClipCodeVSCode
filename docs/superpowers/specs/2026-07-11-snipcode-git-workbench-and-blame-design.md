# Snipcode Git 主場：Inline Blame + 多 repo 提交工作台 — 設計文件

- 日期：2026-07-11
- 狀態：已通過 brainstorming + Codex 複審修訂，待使用者複審 → writing-plans
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

---

## 核心決策定案（Codex 複審後釘死）

這些是 Codex 複審點出、原設計留白或有誤，現已定案的關鍵決策。實作以此為準。

- **D1 — Index 契約（v1 保守）**：提交工作台**只在該 repo 的 git index 乾淨時**允許
  提交。偵測到已有 staged 內容 → 顯示 banner「該 repo 已有預先暫存的變更，請先在原生
  SCM 提交或重置後再用此面板」，並停用該 repo 的 Commit。**不做** index 重放／臨時 index
  reconciliation（延到 v2）。有了乾淨 index 前提，提交流程簡化為
  「選取 hunk 組 forward patch → `git apply --cached` → `git commit` → reset index 回
  乾淨」，無 staged/unstaged 混合的地獄。
- **D2 — 交易與鎖**：`git-service.ts` 現有的 `withMutationLock` 是 **per-instance、
  per-command** 的鎖，無法保障 `apply→commit` 整段交易、也不跨面板。需新增
  **host 層、以 repo 路徑為 key 的 mutation coordinator**，Graph／SCM 側欄／Workbench
  共用同一把鎖。Workbench 的一次提交必須把
  「stale 驗證 → apply --cached → commit → index 復原 → refresh」整段鎖在同一 repo key 下。
- **D3 — 支援矩陣（能力分級）**：以 `git status --porcelain=v2 -z` 建**結構化** status
  （分 index/worktree 狀態、record kind、old/new path、unmerged、submodule）。逐 hunk
  只保證**一般 tracked 文字檔**；binary／submodule／mode-only／symlink／rename／新檔
  intent-to-add → **整檔選取或唯讀顯示**，v1 不支援其逐 hunk。CRLF/autocrlf 必須以真
  git integration 測試驗證。
- **D4 — 提交適用政策**：repo 處於 **merge / rebase / cherry-pick / revert 進行中或
  index unmerged** → **擋提交**並顯示既有衝突流程 banner。detached HEAD → 允許但警告
  （commit 不在 branch 上）。unborn HEAD（無 commit 的新 repo）→ 允許（首個 commit）。
  bisect 中 → 擋。pre-commit hook 若改動 tree：commit 後比對 tree，若含未勾選檔案則
  回報異常（不靜默接受）。
- **D5 — Blame 互動**：`TextEditorDecorationType` **不回傳點擊事件**（已查證 VS Code
  API）。因此「跳到 commit」改為 **hover MarkdownString 內的 trusted command link**，不做
  裸點擊 annotation。未存檔 buffer 用 `git blame --contents -` 餵 `document.getText()`，
  cache key = `repo + HEAD + document.version`。
- **D6 — ClipCode 語意**：用**公開的 `buildGitPayload`**（`buildPayloadInternal` 未
  export，不動 clipboard wire format）。選取 hunk → 為每個選取檔案產生「將選取 hunks 套到
  base 後的**完整檔案 snapshot**」（不是塞 patch 片段，否則 Paste & Restore 會用片段覆蓋
  整檔）。多 repo → 把 repo 名納入 clipboard path 命名空間，處理同名檔（現格式僅單一
  `sourceRoot`，會撞路徑）。

---

## 明確不做（YAGNI）

- 提交面板裡的 paste/restore（已在 File 區）。
- 提交面板裡的 PR copy（已在 Graph）。
- 自製三欄 merge conflict 工具（維持委派 VS Code 內建，日後另議）。
- changelist 命名分組（先做 hunk staging；命名分組留第二階段）。
- blame 的「當前行 inline 常駐」模式（改為 per-檔案按鈕觸發，見 Slice A）。
- **index 重放 / 臨時 index reconciliation / 部分預先 staged 支援**（見 D1，延到 v2）。

---

## Slice A — Inline Blame（編輯器內，host 端）

### 落點
- 新模組 `src/blame/`，純 host、不碰任何 webview。
- git 資料：spawn `git blame --porcelain`（複用既有共用的 git binary/env/timeout
  adapter；`src/graphCopy.ts` 有 spawn + fallback 的既有寫法可參考）。
- 畫面：VS Code `TextEditorDecorationType`。

### 觸發方式
仿 IntelliJ annotate：**預設全關**，靠**編輯器標題列（`editor/title`）的一個
blame icon 按鈕**觸發，不是命令面板開關、也不是全域設定。

- 點按鈕 → 對**目前這個檔案**打開逐行 annotate；再點一次關閉。
- **per-editor 狀態**：狀態 key 綁 editor instance（或 URI）；同一檔分割到兩欄時各自
  獨立開關；editor dispose 時清理。A 檔開啟不影響 B 檔。

### 顯示與互動
- 逐行左側顯示「作者 · 相對時間」。
- **age 顏色**：commit 時間映射色帶（新＝亮 accent，舊＝淡灰），以少量 bucket 共用
  decoration type（避免每行一個 type）。可設定。
- **hover**：commit hash／作者／日期／訊息，附「在 Graph 開啟此 commit」**command link**
  （trusted MarkdownString，複用既有 graph open-at-commit 命令）。
- **未提交的行**：顯示「你 · 未提交」。
- 位置樣式選擇避免與常見 inline blame（GitLens）在行首重疊；採低干擾樣式。與 GitLens
  無 correctness 衝突（不同 decoration type 可並存），僅需避免視覺擠壓。

### 資料流與效能
- blame 結果**快取**在 `repo + HEAD + document.version`；存檔／HEAD 變動／編輯時失效。
- 未存檔 buffer：用 `git blame --contents -` 餵 `document.getText()`，行號才與 editor
  一致（一般 `git blame file` 讀磁碟會對不上）。
- 全非同步 spawn；spawn 逾時有上限。
- **大檔門檻**：超過門檻（行數/位元組）時，annotate 走 visible-range chunking 或提示，
  不無條件整檔跑。

### 錯誤處理
非 git 檔／新檔／blame 失敗 → 靜默不顯示（不跳錯誤打擾）。

### 測試
- `git blame --porcelain` parser 單元測試（含未提交行、moved line、多作者）。
- age→顏色 bucket 映射純函式測試。
- unsaved buffer（`--contents -`）行號對齊、split editor 各自狀態、HEAD 變動失效、
  大檔門檻、快速開關 → e2e / integration smoke。

---

## Slice B — 多 repo 提交工作台（獨立 webview 面板）

### 佈局模型（IntelliJ 模式）
- **repo 只是顯示分組，不是提交單位。**
- **一個共用的 commit 訊息框**，勾選可**橫跨多個 repo**。
- 按 Commit → 對「有勾到變更的每個 repo」各下一次 `git commit`，**共用同一則訊息**
  （git 無法一個 commit 跨 repo，底層是 N 個 commit、UX 上一次動作、一則訊息）。
- 全部 repo 同時列出、依 repo 折疊分組（避開「切 active repo」競態）。

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
- **新的 webview view**，放在自己的 Activity Bar 容器（持久側欄）。獨立的 view lifecycle
  合理（Graph 是 active-repo 歷史面板，Workbench 是 all-repo 工作區狀態，分開是好 seam）。
- **UI 基礎建設（避免整套重複）**：抽出**純 diff parser / types / renderer** 的共用 seam；
  v1 用簡單 diff CSS，**不需要 Shiki**（持久側欄不背 Shiki bundle）。但 `requestId`、
  timeout、sequence guard、**mutation coordinator（D2）** 必須與 Graph 共用，不可各做一份。
- **共用 host `git-service.ts`**（純 CLI 層），新增工作區方法：
  - `getStatus(repo)`：`git status --porcelain=v2 -z` → 結構化模型（D3）。
  - `getWorkingDiff(repo, file)`：因 D1 保證 index 乾淨，baseline = HEAD；diff 切 hunks。
  - `buildForwardPatch(file, selectedHunks)`：**新寫的 forward-selection patch builder**。
    現有 `graph/src/git/patch-builder.ts` 是**專為 `git apply --reverse`** 設計（未選
    addition 降為 context、未選 deletion 移除），語意相反，**不能直接複用**；只複用其
    unified-diff parser / line indexing / header-count / no-newline 處理等基礎。
  - `commitSelected(repo, message, patches, opts)`：`apply --cached` → `commit` →
    reset index 回乾淨。全程在 D2 的 repo 鎖內。
  - 多 repo 探索複用 `services/repo-discovery.ts`。

### staging 運作（D1 前提下）
- 勾選框是**純 webview 狀態**，按 Commit 前不碰 git index。
- 提交流程（單 repo，於 mutation 鎖內）：
  1. **stale 驗證**：比對送來的 selection 綁定的 `expected HEAD + working-content
     fingerprint + hunk digest` 與當前實際狀態；不一致 → 拒絕提交、要求重新檢視（不偷偷
     remap hunk index）。
  2. 確認 index 乾淨（D1）；非空 → 擋 + banner。
  3. `buildForwardPatch` → `git apply --cached`。
  4. `git commit`；pre-commit hook 後比對 tree（D4）。
  5. `git reset`（mixed，保留工作區）讓 index 回乾淨。
  6. 各階段 `try/finally` 復原，失敗不留污染 index。

### 元件（webview UI）
- `RepoGroup`：可折疊、顯示變更數；per-repo banner（index 非空 / 衝突中 / detached）。
- `FileRow`：tri-state 勾選（全／部分／無 hunk 選取）＋變更類型徽章＋路徑；不可逐 hunk 的
  類型（binary/submodule/rename…）顯示為整檔選取或唯讀。
- `HunkView`：展開檔案 → 每 hunk 一個勾選＋diff 行（簡單 diff CSS）。
- `CommitBox`：共用單一訊息框 + Commit / Amend / ⧉ 複製成 ClipCode。

### 資料流
1. 開面板 → host 探索 repos → 各自結構化 `getStatus` → 分組樹渲染。
2. 檔案／HEAD watcher（debounce）刷新 status；刷新後既有 selection 以 D2/stale 機制對齊。
3. 勾選 hunk = 純 webview 狀態（無 git 呼叫），但每個 selection 攜帶版本指紋。
4. Commit → webview 送
   `{message, repos:[{repo, expectedHead, files:[{path, fingerprint, selectedHunkDigests[]}]}]}`
   → host **逐 repo** 在鎖內執行上述 staging 流程 → 回傳**每 repo 結果**（見下）。

### 錯誤處理與跨 repo 部分失敗
- 回傳每 repo：`{repo, oldHead, newHead|null, phase, ok, reason?, cleanupOk}`。
- **成功的 repo 立即清除其 selection**；**失敗的 repo 保留 selection 與訊息框**，避免再按
  Commit 時對已成功 repo 重複提交。明示「N 個獨立 commit，無跨 repo atomic rollback」。
- 失敗分階段回報（stale / apply / hook / commit / reset 何者失敗）；apply 後失敗必 `finally`
  清 index。（呼應 CHANGELOG「衝突暫停卻誤報成功」——絕不假裝整批成功。）
- 沒勾任何東西 → Commit 停用。
- **Amend 只在勾選集中於單一 repo 時可用**，否則停用並提示。

### ClipCode 接點（唯一，見 D6）
「⧉ 複製成 ClipCode」= 取勾選的檔案／hunk，對每檔產生「選取 hunks 套到 base 後的完整檔
snapshot」，用公開 `buildGitPayload` 組成 payload；多 repo 路徑加 repo namespace。paste 與
PR copy 不在此面板。

### 測試（補齊 Codex 點出的高風險交易路徑）
- status parser（porcelain v2 `-z`）：MM/AM/RM、unmerged、rename old/new、submodule。
- forward patch builder：選部分 hunk 正確 stage、未選項不受影響；對照 reverse builder 不
  混用。
- **commit-selected integration**（真 git repo）：選部分 hunk → commit → 斷言只提交那些、
  其餘留工作區、**commit 前後 index 位元組/語意保持乾淨**。
- **D1**：index 非空 → 擋提交 banner。
- **stale**：HEAD/working/hunk 指紋不符 → 拒絕；formatter 在提交前插入新 hunk 的情境。
- **D2 交易**：Workbench `apply` 與 Graph `pull/reset/checkout` 交錯 → 序列化不互踩。
- **跨 repo 部分失敗**：repo-A 成功 / repo-B hook 失敗 → 回報正確、A 不重複提交、index 無
  污染；失敗後 retry。
- **D3/D4**：CRLF/autocrlf、binary、rename、new/delete、intent-to-add、submodule、
  mode-only；detached / unborn / merge / rebase / cherry-pick / revert / bisect 政策。
- **ClipCode**：hunk→snapshot round-trip（Paste & Restore 還原正確、非片段覆蓋）、多 repo
  同路徑 namespace。

---

## 出貨順序

1. **Slice A（Inline Blame）** — 獨立、快、感知價值高，先出貨累積動能。
2. **Slice B（提交工作台）** — 旗艦；多 repo 與 ClipCode 接點收在其中。

每個 slice 各自走 spec → plan → 實作循環；本文件同時涵蓋兩者的設計骨架，實作計畫
（writing-plans）會為各 slice 展開細部步驟。Slice B 的 plan 需優先處理 D2（mutation
coordinator）與 forward patch builder，因為它們是其餘步驟的地基。
