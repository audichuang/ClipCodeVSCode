# VS Code 版 Git 操作審查與改善方案

Date: 2026-07-10
Status: Audit completed; recommendations only, not implemented

## 1. 目的與範圍

本文件針對 ClipCodeVSCode（Snipcode）目前所有主要 Git 操作進行審查，重點不是重寫架構，而是回答以下問題：

1. 是否可能操作到錯誤 repository、錯誤 stash 或錯誤 commit。
2. 大型 repository、大型檔案與大型 PR 下，記憶體、程序數與延遲是否可控。
3. repository 切換、重複點擊與背景刷新時，舊結果是否可能覆蓋新狀態。
4. VS Code Git API 與直接呼叫 Git CLI 的分工是否合理。
5. 哪些改善應先做，哪些不值得現在投入。

審查範圍包含：

- extension host 的 SCM 複製流程：[`src/extension.ts`](../../src/extension.ts)
- Git 內容讀取與 graph copy：[`src/gitContent.ts`](../../src/gitContent.ts)、[`src/graphCopy.ts`](../../src/graphCopy.ts)、[`src/catFile.ts`](../../src/catFile.ts)
- History view：[`src/historyView.ts`](../../src/historyView.ts)、[`src/historyTreeProvider.ts`](../../src/historyTreeProvider.ts)
- vendored git-graph-plus 的 Git service、repository discovery、MainPanel 與 PR view：[`graph/src/git/git-service.ts`](../../graph/src/git/git-service.ts)、[`graph/src/services/repo-discovery.ts`](../../graph/src/services/repo-discovery.ts)、[`graph/src/panels/MainPanel.ts`](../../graph/src/panels/MainPanel.ts)、[`graph/webview-ui/src/components/pr/PrView.svelte`](../../graph/webview-ui/src/components/pr/PrView.svelte)
- 現有測試、啟動策略、快取與 mutation refresh 行為

本文件不改變 IntelliJ 與 VS Code 共用的 clipboard format，也不建議把 vendored graph Git service 直接匯入 root extension host。

## 2. 結論摘要

目前 Git 基礎不是差，而是已具備不少正確設計：

- 使用 argv 呼叫 Git，而不是組 shell command，常見 command injection 風險低。
- 需要解析路徑的流程多數使用 `-z`，並設定 `core.quotePath=false`，能處理空白、tab、換行與非 ASCII 路徑。
- graph Git runner 已有 timeout、max buffer、read cache、in-flight deduplication、generation invalidation 與 mutation serialization。
- file watcher 多數走局部刷新，而不是所有事件都重建整張圖。
- linked worktree 的 git directory 已有處理。

因此，不建議全面換成 `vscode.git` API，也不建議再導入一套泛用 Git framework。最有效的路線是保留目前 hybrid 架構：

- `vscode.git`：SCM 狀態、repository discovery 輔助、VS Code credential/auth 整合。
- Git CLI：graph、history、批次 blob、refs、stash、PR compare 等需要完整 Git 語意的操作。

優先順序應是：

1. 先修正可能操作錯 repository、錯 stash、混合不同 commit snapshot 的安全／正確性問題。
2. 再讓檔案複製與 PR 流程具備 streaming、上限、取消與 stale-result 防護。
3. 最後降低 Flow、operation state、stats 與啟動時的 Git process 數量。

嚴重度結論：

| 等級 | 結論 |
|---|---|
| P0 | 未發現目前可直接判定為必然資料毀損或遠端破壞的問題。 |
| P1 | 有數個高影響 correctness／data-safety 風險，應優先處理。 |
| P2 | 有明顯的大型 repository／PR 效能、race condition 與結果完整性問題。 |
| P3 | 有可維護性與防回歸問題，適合在前兩階段完成後補強。 |

## 3. P1：優先修正的安全與正確性問題

### P1-1. 繼承的 Git 環境變數可能把操作導向錯誤 repository

#### 現況

多個 raw Git spawn 直接繼承 `process.env`，例如：

- graph Git runner：[`git-service.ts`](../../graph/src/git/git-service.ts#L471-L473)、[`git-service.ts`](../../graph/src/git/git-service.ts#L1882)、[`git-service.ts`](../../graph/src/git/git-service.ts#L2796-L2798)
- repository discovery：[`repo-discovery.ts`](../../graph/src/services/repo-discovery.ts#L237-L239)
- root batch reader：[`extension.ts`](../../src/extension.ts#L107-L108)

若啟動 VS Code 的父程序帶有 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE` 或 `GIT_OBJECT_DIRECTORY` 等 repository-scoping 變數，即使 command 使用 `git -C <repoB>`，Git 仍可能依環境變數轉向 repo A 的 git dir、index 或 object store。

本機驗證已重現兩組：設定 `GIT_DIR` 與 `GIT_WORK_TREE` 指向 repo A 後，對 repo B 執行 `git -C repoB rev-parse --show-toplevel` 會回報 repo A；設定 `GIT_INDEX_FILE` 指向 repo A 的 index 後，`git -C repoB rev-parse --git-path index` 仍回報 repo A 的 index path——只清 `GIT_DIR`／`GIT_WORK_TREE`／`GIT_COMMON_DIR` 三個變數擋不住 index／object store 層級的污染。

#### 風險

- 讀到錯誤 commit、branch 或 blob。
- stash、reset、pull、push 等 mutation 作用在非預期 repository。
- 問題高度依賴使用者啟動環境，CI 與開發者機器不一定能重現。

#### 建議

每個 raw Git process 在 merge 完自訂 env（`process.env` + `extraEnv`／`gitEnv`）後，統一移除經審核的 repository-scoping 變數，至少包含：

```text
GIT_DIR
GIT_WORK_TREE
GIT_COMMON_DIR
GIT_INDEX_FILE
GIT_OBJECT_DIRECTORY
```

denylist 逐項附 integration test 佐證，不可只清前三個；同時**不得**清掉 credential、askpass、proxy 與 locale 類 env（`GIT_ASKPASS`、`SSH_ASKPASS`、proxy 設定等），避免破壞既有的認證整合。可建立純函式 `sanitizeGitEnvironment()`，但 root 與 vendored graph 各自保有薄封裝，避免跨越 vendor boundary。

#### 驗收測試

- unit test：mock spawn，確認 denylist 中的 key 不會進入 child env，且 `GIT_ASKPASS` 等保留 key 原樣通過。
- integration test：建立兩個暫存 repository，分別以 `GIT_DIR`／`GIT_WORK_TREE` 與 `GIT_INDEX_FILE` 污染 env，操作仍只能讀／改指定的 `cwd`。
- 保留必要的 credential、locale 與使用者自訂 Git env，不做整包白名單化。

### P1-2. clean working tree 的 auto-stash 可能誤套用既有 stash

#### 現況

fast-forward 與 pull 的 auto-stash 流程先呼叫 `stashSave()`，完成後固定呼叫 `stashPop(0)`：

- fast-forward：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L816-L827)
- pull：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L981-L988)
- stash primitives：[`git-service.ts`](../../graph/src/git/git-service.ts#L2198-L2222)

問題是 clean tree 執行 `git stash push` 會 exit 0，但不會建立新 stash。若使用者原本已有 `stash@{0}`，後續固定 pop index 0 就可能套用並刪除使用者原有 stash。

手動 stash handler 已採用操作前後計數比對：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L1165-L1174)。這證明目前 codebase 已意識到「exit 0 不代表建立 stash」，但 auto-stash 兩條路徑尚未套用同一保護。

#### 風險

- **pull 為主要、可直接重現的案例**：[`PullModal.svelte`](../../graph/webview-ui/src/components/modals/PullModal.svelte) 的 stash 是純 checkbox，且可透過 defaults store 持久化為預設開啟，沒有任何 dirty working tree 前置檢查。clean tree + 勾選 stash → `git stash push` exit 0 但不建立 stash → `finally` 固定 `stash pop 0` 就會誤 pop 使用者既有的 `stash@{0}`。附註：modal 上該 checkbox 旁顯示 `--autostash` badge，但實作是手動 `stash push`／`stash pop`，並非 Git 原生 `pull --autostash`（原生 autostash 沒有這個 bug），這個 badge 具誤導性。
- **fast-forward 為次要路徑**：正常流程下的 `stash: true` 來自上游 dirty check 加上使用者在 CheckoutCommitModal 主動選擇 stash，clean tree 通常走不到這條路；但仍存在兩個缺口：(a) TOCTOU——dirty check 完成後、使用者按下 confirm 前，工作樹可能已變回 clean；(b) stale payload——[`CommitGraph.svelte`](../../graph/webview-ui/src/components/graph/CommitGraph.svelte) 的 `pendingCheckoutDirtyPayload` 在 FastForwardModal 的 `onClose`（約 L1965）不會清除，remote branch 雙擊／Enter 開啟 modal（約 L1642、L1661）也不會覆寫它，`onConfirm`（約 L1972）則無條件沿用目前持有的值。因此「先對 dirty 分支開 FF modal → 取消 → 之後對 clean tree 從 remote branch 再開一次 FF → confirm」會帶著殘留的 `stash: true` 一起送出。

#### 建議

1. `stashSave()` 應回傳「是否真的建立」以及建立後的 stable object ID。
2. restore 時只針對該 object ID，不使用固定 index。**必須明定清理 lifecycle**，因為 Git 的 `stash pop <OID>`／`stash drop <OID>` 會直接拒收 raw OID（實測 git 2.43：`error: '<oid>' 不是一個貯存引用`），而 `stash apply <OID>` 雖可執行、卻永遠不會 drop——字面照做會把 auto-stash 永久留在 stash list。正確流程是：確認本次確實建立 → `stash apply <OID>` → apply 成功後，在 `stash list` 中找出仍指向該 OID 的 `stash@{n}` 才 drop 該 index；apply 發生 conflict 時保留 stash 不 drop。另注意現有 `stashApply`／`stashPop`／`stashDrop` API 都只接受 numeric index（[`git-service.ts`](../../graph/src/git/git-service.ts#L2198-L2226)），需一併擴充。
3. auto-stash、主要 operation、stash restore 必須在同一個 handler-level mutation transaction 內，避免其他 mutation 插入。
4. 若 Git 版本與操作支援原生 autostash，可評估直接使用原生命令（或改用私有暫存 ref 而非 stash stack）；否則保留明確 transaction。
5. FastForwardModal 關閉（包含取消）時清除 `pendingCheckoutDirtyPayload`，並在每次開啟 modal 前重新推導 dirty 狀態，不沿用前一次殘留值。

#### 驗收測試

- clean tree + 已有 stash：完成 pull 後，原 stash OID、內容與數量完全不變。
- dirty tree + 已有 stash：只 restore 本次建立的 stash。
- 主要 operation 失敗：仍嘗試 restore，並同時保留原始錯誤與 restore 錯誤。
- mutation queue 中有第二個操作：不得介入 stash transaction。
- 注意：現有 [`MainPanel.test.ts`](../../graph/src/panels/__tests__/MainPanel.test.ts#L337) 固定期待 pull 後無條件 pop（未確認 stash 是否真的建立）——**該測試鎖住的是現況錯誤行為，實作本票時必須同步反轉**，否則會擋下修正。

### P1-3. PR compare 未固定 base/head snapshot，可能混合不同時間點的資料

#### 現況

PR compare 是兩階段 `Promise.all` 併發，而非單純依序執行：[`git-service.ts`](../../graph/src/git/git-service.ts#L1969-L2048)。第一階段 `log`、`merge-base`、`rev-list --left-right --count` 全都用 symbolic base/head ref 併發執行；第二階段的兩個 diff（name-status 與 full patch）的 base 端已改用第一階段 `merge-base` 解析出的 OID（僅在 merge-base 失敗時才退回 symbolic base），但 **head 端全程從未 pin 成 OID**，兩個 diff 命令的 head 參數都還是 symbolic ref——TOCTOU 風險主要落在 head。

webview 端同樣沒有完全脫離 symbolic ref：[`PrView.svelte`](../../graph/webview-ui/src/components/pr/PrView.svelte) 的 `openFile`（約 L348-355）傳出的 `ref1`（base）通常是 compare response 裡的 mergeBase OID，但 `ref2`（head）是 symbolic head 字串；`copyAll`（約 L399-408）送出的 `hash` 同樣是 symbolic head，host 端會在收到訊息後重新再解析一次，與原始 compare 的解析時間點不同。

若期間發生 fetch、commit、branch move 或 `update-ref`，commit list、file list、patch、開啟檔案與複製內容可能各自來自不同 tip，且風險集中在 head 端。

#### 風險

- UI 顯示的 commit 數與 diff 不一致。
- 使用者點開或複製到的內容，不是畫面上剛看到的版本。
- race 通常只在活躍 repository 或大型 compare 中出現，難以穩定重現。

#### 建議

compare request 開始時只 resolve 一次：

```text
baseRef -> baseOid
headRef -> headOid
```

後續所有 commit、file、patch、open 與 copy 都使用同一組 OID。response 應攜帶 snapshot OID，webview 不再只保留 symbolic ref。

#### 驗收測試

- compare 進行中移動 head ref，整份 response 仍對應原 head OID。
- response 完成後再次移動 ref，open/copy 仍讀取 response 中的 OID。
- base/head 無法 resolve 時，回傳明確錯誤，不做半套 compare。
- 注意：現有 [`PrView.test.ts`](../../graph/webview-ui/src/components/pr/__tests__/PrView.test.ts#L125) 與同檔 L204 固定期待 open/copy 送出 symbolic ref（`ref2: 'feat'`、`hash: 'feat'`）——**這些測試鎖住的是現況錯誤行為，與本票的 invariant 相反，實作時必須同步反轉**。

### P1-4. repository 切換後，舊 refresh 可能回寫新 repository UI

#### 現況

repository switch 與 full refresh 都是 async，且 codebase 已有一部分防護：

- 既有防護：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts) 大量讀取 handler（約 30 餘處呼叫點）已使用 `isCurrentRepoSnapshot()` 搭配 sequence guard，在套用結果前比對 snapshot 是否仍屬當前 repository；`refreshing`／`refreshQueued` 佇列也保證切換 repository 後，若當下正有 refresh 在跑，之後會再排一次修正 refresh。
- 缺口一：`refreshAll()`（約 L1949-2055）在 `Promise.all` 完成後、寫入 `cacheLogSnapshot` 與 post `fullRefresh` 訊息前，沒有任何 repo 一致性檢查——切換前啟動、closure 已捕捉舊 `gitService` 的查詢完成後，仍會把舊 repository 的資料寫進 cache 並送給正在顯示新 repository 的 webview。
- 缺口二：stale 資料可能**持續存在**，不只是短暫閃爍——若排隊的新 repository refresh 之後失敗，webview `App.svelte` 的 `error` handler 只設定錯誤訊息，`repoList` handler（約 L149-159）也不會清空 commit／branch／stash／tag store。這些殘留是可操作的 ref；使用者在 repo B 畫面點擊 repo A 留下的殘留項目時，操作會由目前 repo B 的 service 以 ref 名稱執行，構成錯 repo mutation 風險——這是本項仍列為 P1 的理由。
- 缺口三：sidebar provider 的 cache 寫入普遍缺乏守衛，範圍不只 `doFetch` 的寫入順序。五個 provider 中只有 Branches 的 `doFetch` 在寫 cache 前驗證 `fetchId`（[`branches-view.ts`](../../graph/src/views/branches-view.ts#L44)）；Remotes／Tags／Stashes／Worktrees 的 `doFetch` 都是先寫 cache 才檢查 `fetchId`（例如 [`remotes-view.ts`](../../graph/src/views/remotes-view.ts#L36-L41)），`fetchId` 只擋 tree 重新 fire，擋不了較舊的 request 覆寫 cache。此外**五個 provider 的 `getChildren()` fallback 路徑（含 Remotes 的 `branchCache`）在 await 舊 service 之後一律無條件寫 cache，完全沒有任何守衛**（[`branches-view.ts`](../../graph/src/views/branches-view.ts#L79-L85)、[`remotes-view.ts`](../../graph/src/views/remotes-view.ts#L49-L80)、[`tags-view.ts`](../../graph/src/views/tags-view.ts#L42-L44)、[`stashes-view.ts`](../../graph/src/views/stashes-view.ts#L42-L44)、[`worktrees-view.ts`](../../graph/src/views/worktrees-view.ts#L43-L45)）。

#### 建議

1. 每次 repository switch 增加 `repositoryEpoch`；每個 async refresh 在開始時捕捉 `epoch + service identity + repository root`，在 `refreshAll()` 寫 cache、post message 前再次比對，不一致就丟棄結果。
2. epoch／service identity 必須涵蓋五個 sidebar provider 的**每一次** cache write 與 return——包含 `doFetch`、`getChildren()` fallback 與 Remotes 的 `branchCache`——不能只調整四個 `doFetch` 的寫入順序。
3. repository 切換，或排隊的修正 refresh 失敗時，清空或標記 stale 對應的 commit／branch／stash／tag store，不讓上一個 repository 的殘留 ref 繼續可被點擊操作。
4. 若 API 支援 signal，同時 abort 舊 request，避免只丟結果卻繼續消耗 Git process。

#### 驗收測試

- repo A refresh 延遲，切到 repo B 後才完成：不得在 B 畫面出現 A 的任何資料。
- 快速 A → B → A：只有最後一次 epoch 可更新 UI。
- stale refresh 不得觸發額外 sidebar refresh。
- 切換 repository 後，若排隊的修正 refresh 失敗，UI 不得殘留上一個 repository 的 branch／stash／tag 項目可供點擊操作。
- sidebar provider 收到較舊的 request 在較新 request 之後才完成時，cache 不得被舊資料覆寫。

### P1-5. batch blob reader 在完整 buffer 後才套用大小限制，缺少 timeout／取消／總量上限

#### 現況

root batch reader 先收集所有 stdout chunk，再 `Buffer.concat()`：[`extension.ts`](../../src/extension.ts#L93-L119)。接著 parser 才解析內容：[`catFile.ts`](../../src/catFile.ts#L20-L46)，最後 graph copy 才檢查單檔大小：[`graphCopy.ts`](../../src/graphCopy.ts#L199-L206)。

因此 `maxFileSize` 目前只限制「是否輸出到 clipboard」，無法限制 Git child stdout 與 Node heap 已經接收的資料。流程也缺少：

- process timeout
- `AbortSignal`
- 單次操作 aggregate byte cap
- kill 後等待 child `close` 的完整生命週期

#### 風險

- 大型 blob 或大量檔案造成 extension host 記憶體尖峰。
- 使用者取消、切換 repository 或發出更新的 copy request 時，舊 process 仍繼續跑。
- 單檔都在限制內，但總量很大時仍可能耗盡記憶體。

分級註記：本項三個風險都屬 availability／resource bounding（extension host OOM 會讓整個 extension 失能），不涉及錯 repo 或資料 mutation。列在 P1 是把 extension host 失能視為高影響 availability 風險；若團隊嚴格採「P1 = correctness／data-safety」分級，本項可視為 P2-high，實作排程不變（本來就排在 Phase 1，而非 Phase 0）。

#### 建議

建立 root-local、bounded 的 `GitBlobReader`：

```ts
readMany(
  repoRoot,
  requests: Array<{ key: string; ref: string; path: string }>,
  options: {
    maxBytesPerFile: number;
    maxBytesTotal: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<BlobReadResult[]>
```

結果使用明確 union：

```text
text | binary | oversize | missing | error
```

parser 應 streaming 消費 `git cat-file --batch`：先讀 header 中的 object size，確認限制後才保留 body；超限 body 仍需正確 drain，才能繼續解析下一個 object。abort／timeout 時 terminate child，並等待 `close` 後才 resolve/reject。

#### 驗收測試

- 超大 blob 不會被完整保留在 heap。
- 多個中型 blob 超過 aggregate cap 時停止並回報部分結果。
- abort 後 child process 結束，不留 zombie，也不寫 clipboard。
- binary、missing、oversize 與 Git error 可被 UI 分別統計。

### P1-6. 路徑大小寫正規化混淆了「比較 key」與「傳給 Git 的真實 path」

#### 現況

graph path 工具與 repository discovery 對 POSIX path 是**無條件** `toLowerCase()`（不分平台），而且同款 comparator 一共有三份：

- host 端：[`graph/src/utils/path.ts`](../../graph/src/utils/path.ts#L12-L14) 的 `canonical()`
- repository discovery：[`repo-discovery.ts`](../../graph/src/services/repo-discovery.ts#L40)
- **webview 端還有第三份**（文件先前版本遺漏）：[`graph/webview-ui/src/lib/utils/path.ts`](../../graph/webview-ui/src/lib/utils/path.ts#L10-L11) 的 `normalize()`／`samePath()`，被 `App.svelte` 的 `repoList` 處理與 Toolbar 的 repo pill active 判斷使用。只修 host／discovery 而不修 webview，case-sensitive volume 上 `/work/Foo` 與 `/work/foo` 在 webview 仍會被視為同一個 repo（兩個 repo pill 可能同時顯示 active、`activeRepoInfo` 取到錯誤項目）。

在 case-sensitive filesystem，`/work/Foo` 與 `/work/foo` 是不同路徑，轉小寫可能合併兩個 repository，或讓 `samePath` 之類的比較把一次真正的切換誤判成 no-op。精確地說：case-fold 在所有 OS 都會執行，但錯誤行為只在實際 case-sensitive 的 filesystem 上可觀察（Linux 預設、macOS／Windows 的 case-sensitive volume）。

另一側，root Git content reader 只在 Windows 將 `repoRelativePath` 轉小寫：[`gitContent.ts`](../../src/gitContent.ts#L7-L12)（以 `process.platform === 'win32'` 為條件，POSIX 不受影響）。這個小寫化的 relative path 確實會作為第一個 candidate 傳給 `repo.show`，若真正 object path 為 `Src/A.ts`、傳入的是 `src/a.ts`，這個 candidate 會 miss；但 [`gitContent.ts`](../../src/gitContent.ts#L33-L38) 的 candidate 清單還包含原始大小寫的絕對路徑作為 fallback，通常能讀到內容。因此 Windows 這一側目前實際影響是「多一次失敗嘗試、依賴 fallback candidate」，不宜再宣稱混合大小寫 tree path 在 Windows 上必然讀不到。

#### 建議

明確分離：

- `displayPath`／`gitPath`：永遠保留 Git 與 filesystem 回傳的原始大小寫。
- `comparisonKey`：只在確定 filesystem comparison 為 case-insensitive 時做 case fold。

不得把 comparison key 傳回 Git command。修正範圍必須同時涵蓋三份 comparator（host `canonical()`、discovery `normalize()`、webview `samePath()`），漏掉任何一份都會讓症狀換個位置重現。

#### 驗收測試

- POSIX 上兩個只差大小寫的 repository 可同時存在並正確切換，且 webview repo 清單顯示為兩個獨立項目、active 標記正確。
- Windows 上 Git tree 含混合大小寫路徑時，可依原始 tree path 讀取。
- rename 僅改變大小寫時，不會遺失 old/new path。

### P1-7. 多步 mutation handler 執行中可切換 repository，後半段作用在新 repository

#### 現況

這是本輪交叉複查新發現、原文件未涵蓋的缺口（P1-4 只處理讀取／refresh 的 stale 回寫，這裡是 mutation 本身跨 repo）：

- `handleMessage` 開頭只捕捉 `repoAtMessageStart = this.repoPath`（path 字串，不是 service 實例）：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L536-L537)。
- pull 的 auto-stash 三步（`stashSave` → `pull` → `stashPop(0)`）每一步都重新讀 `this.gitService`：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L981-L988)；fast-forward handler 同一寫法。
- `swapRepo` 會直接替換 `this.gitService`：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L471-L480)，而 `switchRepo` message 的處理**不經過 mutation lock**，也沒有任何「操作進行中」的 host 端旗標阻擋。
- `withMutationLock` 的 `mutationChain` 是 per-service instance field（[`git-service.ts`](../../graph/src/git/git-service.ts#L87-L93)）：切 repo 後新 service 有獨立的 lock chain，無法與舊 service 的 in-flight mutation 互相排隊。
- webview 端 Toolbar 的 fetch／pull／push 按鈕在 `uiStore.operating` 期間會 disable，但 **repo pill 沒有**（[`Toolbar.svelte`](../../graph/webview-ui/src/components/layout/Toolbar.svelte#L130-L147)）——操作進行中使用者可照常打開下拉並切換 repository。

失敗情境：在 repo A 觸發帶 auto-stash 的 pull，`stashSave` await 期間切到 repo B → handler resume 後 `pull` 與 `stashPop(0)` 都作用在 repo B——pop 掉 B 的 `stash@{0}`，且 A 的 auto-stash 永久遺留未 restore。

#### 建議

1. handler transaction 在進入時一次捕捉並固定 `{ service, repoPath, epoch }`，全程使用捕捉到的 service，不再於 await 之間重讀 `this.gitService`。
2. mutation transaction 進行中延後或拒絕 repo switch：host 端把 `switchRepo` 排到 transaction 完成後執行，webview 端 repo pill 依 `uiStore.operating` disable（與 fetch/pull/push 按鈕一致）。
3. 不能只在 await 後偵測到切換就 abort——中斷會把 repo A 留在「已 stash、未 restore」的狀態；transaction 必須完整跑完 restore 才允許切換。

#### 驗收測試

- pull／fast-forward auto-stash 進行中送出 `switchRepo`：所有步驟仍作用於起始 repository，切換在 transaction 完成後才生效。
- 上述情境下，repo B 的既有 stash 前後 OID、內容與數量完全不變。
- transaction 因 Git error 失敗：仍在起始 repository 完成 stash restore，之後才處理排隊的切換。

## 4. P2：效能、併發與結果完整性改善

### P2-1. PR view 一次啟動多個完整查詢，且缺少真正取消與 lazy diff

目前 compare 一次取得的品項是 `log`（commit list）、`merge-base`、`rev-list --left-right --count`（ahead/behind）、name-status diff（file list）與 full patch；webview 也明確標記尚未 lazy load：[`PrView.svelte`](../../graph/webview-ui/src/components/pr/PrView.svelte#L647-L674)。另外，以 `diffs.find(...)`（L674）對每個檔案反覆線性搜尋，檔案數增加時形成 O(n²) 組合成本。

request ID 目前能避免部分 stale response 顯示，但無法停止已經啟動的 Git process。

建議拆成：

1. 首屏只取 snapshot OID、summary、commit 第一頁與 file list。
2. commit list 分頁。
3. patch 依展開檔案或 viewport 載入。
4. 每個 compare request 都有 `AbortController`；新 request、關閉 view、切 repo 時 abort 舊 request。
5. 以 `Map<path, diff>` 取代反覆 `find()`。
6. timeout／size cap 命中時顯示「截斷」狀態，不把不完整結果偽裝成完整 diff。

目標是 PR 首屏不執行 full patch command，使用者只為真正查看的檔案支付 diff 成本。

### P2-2. 多個 copy command 可能讓較慢的舊操作覆蓋較新的 clipboard

full copy、SCM selection copy、graph copy 與 History copy 都包含 async Git／filesystem 讀取，最後才寫 clipboard。若使用者快速連點，較早但較慢的 request 可能最後完成，覆蓋較新的結果。

建議建立 extension-host 共用 `copyGeneration`：

1. 新 copy operation 增加 generation 並 abort 前一個 signal。
2. 每個長步驟後檢查 generation。
3. 只有仍是最新 generation 的 request 可以呼叫 `clipboard.writeText()` 與顯示成功通知。

不同 copy command 應共用同一 generation，因為系統 clipboard 本身就是單一共享輸出。

### P2-3. graph copy 不必要地把 `vscode.git` repository list 當硬性前置條件

command handler 會在 `api.repositories` **完全為空**（`length === 0`，含 `api` 本身為 falsy）時直接中止：[`extension.ts`](../../src/extension.ts#L153-L160)。精確地說，這個 gate 只擋「repository list 完全是空的」這一種情況；列表非空但不含目標 repo 時，本來就會放行——**主要工作由 batch reader 直接以 payload root spawn `git cat-file --batch` 完成，不依賴 vscode.git 認得該 repo**（`resolveRepo` 本身只搜尋 `api.repositories`，沒有 payload-root fallback：[`extension.ts`](../../src/extension.ts#L128-L133)）。現有測試已證明 `resolveRepo` 為 undefined 時仍可工作：[`graphCopy.test.ts`](../../test/graphCopy.test.ts#L242-L270)。

已知例外：committed path 含 CR／LF 時 batch 讀取會跳過該檔（[`graphCopy.ts`](../../src/graphCopy.ts#L108-L110)），改走 per-file fallback，而 fallback 需要 `resolveRepo` 成功（[`graphCopy.ts`](../../src/graphCopy.ts#L147-L156)）——若目標 repo 不在 `api.repositories`，這類檔案會變成 `missing`。因此「目標 repo 不在 API 仍可完成」的主張只適用於可由 batch 正常處理的一般 committed path。

建議把 `vscode.git` API 降為 repository resolution／credential integration 的輔助來源，不作 graph copy 的硬性 gate。Git extension 尚未初始化時，仍應嘗試從 payload root 與 runtime Git 完成操作。移除這個 gate 時，需同步做兩件事：(1) 讓 `makeGraphCopyDeps()`（[`extension.ts`](../../src/extension.ts#L122-L140)）接受 optional 的 `api` 參數——目前該函式內部仍會直接 dereference `api` 物件本身（例如 `api.git`、`api.repositories`），`api` 為 `undefined` 時會直接丟例外；(2) 為 batch-skipped／failed path 提供不依賴 `resolveRepo` 的 raw-Git、binary-safe single-file fallback，補上 CR／LF path 的缺口。

### P2-4. SCM 全選 copy 的 first-wins dedupe 可能丟失結構性狀態

收集迴圈在 [`extension.ts`](../../src/extension.ts#L493-L524)；「working、untracked、merge、index」的 group 順序實際定義在 `ordered` 陣列：[`extension.ts`](../../src/extension.ts#L576-L582)，之後 first-wins 去重：[`extension.ts`](../../src/extension.ts#L583-L593)。

同一路徑若 staged 為 `NEW`／`RENAMED`，又有 unstaged `MODIFIED`，first-wins 可能只留下 `MODIFIED`，導致 clipboard label 丟失「新增」或「移動」語意。

建議每個 path 聚合兩個不同維度：

- structural status：NEW／DELETED／MOVED／MODIFIED，依 Git index 與 working tree 合成。
- content source：working tree、index、HEAD 或指定 commit。

對同一 path 先合成，再產生 clipboard record；不要讓 resource group 順序隱含決定最終 label。

### P2-5. History view 逐檔序列讀取，且 repository switch snapshot 不完整

History copy 對選取項目逐個 `await readFileAtCommit()`：[`historyView.ts`](../../src/historyView.ts#L96-L110)。選取 N 個檔案會產生 N 次序列 Git 讀取。Tree provider 在 refresh generation 改變時仍可能回傳舊 tree：[`historyTreeProvider.ts`](../../src/historyTreeProvider.ts#L53-L62)，而 command 執行時又可能讀取當前 repository，形成 tree 與內容來源不一致。

此外 History clipboard payload 尚未攜帶 source root：[`historyView.ts`](../../src/historyView.ts#L114)，多 repo／跨工具 restore 的可追溯性較弱。

建議：

- 依 repository + ref 分組，使用同一個 bounded batch reader。
- tree node 攜帶 immutable repository root、commit OID、generation。
- 執行 command 時驗證 snapshot 仍有效，不再重新推導「目前 repository」。
- clipboard payload 補上 source root，但不改變既有跨 IntelliJ／VS Code 格式契約。

### P2-6. 失敗、binary、missing 與 oversize 被合併成「沒有內容」

[`gitContent.ts`](../../src/gitContent.ts) 部分錯誤會 catch 後回傳 `undefined`；graph copy 也會把多種原因合併處理。repository 無法解析、object missing、binary、oversize 與真正 Git error 對使用者的意義不同。

建議內部一律使用 outcome union，最後通知摘要，例如：

```text
已複製 18 個；略過 binary 2、超限 1、找不到 1；Git 讀取失敗 1。
```

這同時改善可觀察性，也避免 silent partial success 被誤認為完整 copy。

### P2-7. Git effect classifier 同時有過度刷新與漏刷

[`git-service.ts`](../../graph/src/git/git-service.ts#L127-L166) 以 command name／subcommand heuristic 判斷是否 invalidate read cache。現在所有 flow／bisect 指令容易被當 mutation，即使是 `flow version`、`bisect log`。

比這更嚴重的是 `submodule` 完全不在這個 classifier 內：不論是 `read`、`worktreeMutation` 或任何分類，`invalidatesReadCache()` 都沒有把 `submodule` 列入，全部落到 `default: return false`。實際效果是 `submodule update` 既不會取得 mutation lock，也不會清 read cache——handler（[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L1549-L1552)）完成後只送 operation complete，沒有任何 refresh 呼叫。加註：目前在 webview UI 找不到任何實際觸發這個 handler 的 sender（`getSubmodules`／`submoduleUpdate` 只出現在 message bus 型別定義，沒有元件或按鈕會送出這兩種訊息），屬於 latent／unreachable path——因此 submodule 這一半的實際優先級是 P3／latent，接上 UI 時才升級；目前**可達**的影響只有 `flow version`／`bisect log` 被誤當 mutation 造成的多餘 serialization 與 cache invalidation（效能問題）。對應這張票應二選一：正式接上 UI 並補齊 classifier／mutation lock／refresh，或依 YAGNI 直接刪除這個目前無人呼叫的 dead handler。

短期應精確分類 subcommand。中期建議 command wrapper 接受明確 effect：

```text
read | worktreeMutation | refMutation | remoteMutation
```

由呼叫端宣告，runner 只負責依 effect 做 generation invalidation、serialization 與 refresh。這比持續擴大字串 heuristic 更容易測試。

### P2-8. 幾個低風險的 Git process 數量改善

#### Git Flow dropdown

Toolbar 開啟時會同時要求 flow status 與 branches：[`Toolbar.svelte`](../../graph/webview-ui/src/components/layout/Toolbar.svelte#L58-L67)，MainPanel 再分別處理：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L1497-L1539)。`getFlowConfig()` 目前還會以多次 config command 逐欄讀取：[`git-service.ts`](../../graph/src/git/git-service.ts#L2636-L2669)。安裝 git-flow 的 repository 中，單次開啟可能接近 15 個 Git process。

建議提供單一 flow snapshot API，並用一次 `git config --get-regexp` 取得相關設定，搭配短期 cache／dedupe。目標：開啟一次 dropdown 不超過 3 個 Git process。

#### Operation state

[`git-service.ts`](../../graph/src/git/git-service.ts#L2150-L2167) 以三次 `rev-parse` 偵測 operation。已知 resolved git dir 後，可直接檢查 rebase／merge／cherry-pick marker，目標是 0 個額外 Git process。

#### Contributor stats

[`git-service.ts`](../../graph/src/git/git-service.ts#L2520-L2544) 與 handler：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L1410-L1414) 會掃描完整 history 兩次：第一次 `shortlog -sne` 算作者 commit count，第二次 `log --format=%aI` 算 weekday／hour 分佈（供 7×24 heatmap）。可用一次 mailmap-aware `git log`（輸出 author、email、author date）在 Node 端同時計算作者 commit count 與 weekday／hour bins——維持 `byAuthor` 與 `byWeekdayHour` 兩個既有資料契約不變——目標是 1 個 Git process。

#### Startup prefetch

root extension 使用 `onStartupFinished`：[`package.json`](../../package.json#L25)，graph 啟動時又 eager prefetch 多個 provider：[`graph/src/extension.ts`](../../graph/src/extension.ts#L186-L193)。providers 本身已能在 `getChildren()` lazy 載入，因此先移除無使用者需求的 eager prefetch；後續再量測是否值得把 graph activation 進一步延後。

### P2-9. Activity log 可能顯示 remote URL 中的 credential

Git service 會產生命令顯示字串並寫入 activity log：[`git-service.ts`](../../graph/src/git/git-service.ts#L457-L479)，例如 remote add：[`git-service.ts`](../../graph/src/git/git-service.ts#L1635-L1639)，最後由 MainPanel 提供給 UI：[`MainPanel.ts`](../../graph/src/panels/MainPanel.ts#L1367)。

若 URL 含 `https://user:token@host/...`，activity log 可能直接顯示 credential。

建議只對「展示／記錄用 command」執行 URL userinfo redaction，實際 argv 完全不變。至少覆蓋 HTTP(S) remote userinfo 與常見 token query parameter，並加 snapshot tests 確認 log 不包含 secret。（activity log 只記錄 argv 組成的顯示字串；credential helper／askpass 的回傳內容不會流入 log，無須納入 redaction 範圍。）

## 5. P3：維護性與防回歸

### P3-1. `SNIPCODE-HOOK` fence 應自動檢查平衡

vendored graph 中使用 `SNIPCODE-HOOK-BEGIN/END` 隔離本產品修改；目前 PR 相關區段、message bus 與部分測試的 fence 可讀性與平衡狀態不一致。手動維護容易在上游同步時遺漏。

建議新增輕量檢查器：

- 預設每個檔案 BEGIN／END 必須配對且不可錯誤巢狀。
- 明確列出少數 whole-file exemption。
- CI 與本機 test command 都執行。
- 不為此導入新 dependency；簡單 Node script 即可。

## 6. 建議的目標架構

### 6.1 保留 hybrid Git integration

```mermaid
flowchart LR
  UI["VS Code commands / webview"] --> Host["Extension host orchestration"]
  Host --> VSC["vscode.git: SCM state / discovery / auth"]
  Host --> Blob["Bounded GitBlobReader: copy / history"]
  UI --> Graph["Vendored graph GitService"]
  Blob --> CLI["Git CLI"]
  Graph --> CLI
```

原則：

- root extension 與 vendored graph 保持模組邊界。
- 共用的是行為契約與測試案例，不是互相 import 大型 service。
- 不引入新的 Git abstraction dependency。

### 6.2 Copy pipeline

```text
snapshot repository/ref/path
  -> aggregate status
  -> bounded batch read
  -> classify outcomes
  -> verify copy generation
  -> format existing clipboard contract
  -> write clipboard once
```

關鍵 invariant：超限前不保留完整 blob；stale request 永遠不能寫 clipboard。

### 6.3 PR compare pipeline

```mermaid
sequenceDiagram
  participant W as Webview
  participant M as MainPanel
  participant G as GitService
  W->>M: compare(baseRef, headRef, requestId)
  M->>G: resolve base/head once
  G-->>M: baseOid + headOid
  M->>G: summary + first commit page + file list by OID
  G-->>M: immutable snapshot
  M-->>W: post snapshot with OIDs
  W->>M: request one file diff by OID
  Note over M,G: New request or repo switch aborts old work
```

### 6.4 Mutation transaction

`mutationQueue` 不只包單一 Git command。stash → pull/fast-forward → restore 這種具備共同正確性邊界的流程，必須以 handler transaction 一次序列化；transaction 進入時固定 `{service, repoPath, epoch}`，完成前 repo switch 一律延後（見 P1-7）；transaction 完成後只做一次 effect-driven invalidation 與 refresh。

## 7. 分階段改善路線

### Phase 0：資料安全與 snapshot correctness

1. sanitize repository-scoping Git env（`GIT_DIR`／`GIT_WORK_TREE`／`GIT_COMMON_DIR`／`GIT_INDEX_FILE`／`GIT_OBJECT_DIRECTORY`）。
2. 修正 auto-stash identity（含 apply→verify→drop lifecycle）與 handler transaction。
3. PR base/head resolve 為固定 OID。
4. repository epoch／request epoch 防止 stale refresh（涵蓋五個 sidebar provider 的所有 cache write）。
5. 分離 path comparison key 與 Git path（含 webview comparator）。
6. handler transaction 固定 `{service, repoPath, epoch}`，mutation 進行中延後 repo switch（P1-7）。

這一階段不應夾帶 UI 重構或流程優化。

### Phase 1：bounded copy pipeline

1. 實作 streaming `GitBlobReader`、per-file／aggregate cap、timeout、abort。
2. 加入全域 copy generation。
3. 移除 graph copy 對 `vscode.git` repository list 的硬 gate。
4. 合成 SCM structural status 與 content source。
5. History 改為 per-repo/ref batch，固定 repository snapshot。
6. outcome union 與部分失敗摘要。

### Phase 2：大型 PR 體驗

1. compare metadata/file list 與 patch 分離。
2. commit pagination。
3. per-file／viewport lazy diff。
4. process-level cancellation。
5. diff Map 與明確 truncation UI。

### Phase 3：Git process reduction

1. Flow snapshot 合併與 cache。
2. operation marker 改用 filesystem check。
3. contributor stats 單次 history scan。
4. 移除 eager provider prefetch。
5. 完整整理 command effect classifier 與 submodule refresh。

### Phase 4：可觀察性與 vendor hardening

1. activity log credential redaction。
2. missing/binary/oversize/error telemetry 與通知。
3. `SNIPCODE-HOOK` fence balance checker。
4. 將關鍵 race／env pollution 案例加入 integration suite。

## 8. 驗收指標

| 場景 | 完成條件 |
|---|---|
| Git env pollution | 父程序設定 `GIT_DIR`、`GIT_INDEX_FILE` 等 repository-scoping 變數時，所有操作仍只作用於明確指定 repository。 |
| Auto-stash | clean tree 且已有 stash 時，pull／fast-forward 前後既有 stash OID 與內容不變；auto-stash restore 後不遺留在 stash list。 |
| 跨 repo mutation | 多步 mutation handler 執行期間切換 repository：所有步驟仍作用於起始 repository，切換延後到 transaction 完成。 |
| PR snapshot | compare 期間或完成後移動 ref，不會改變該畫面的 open/copy 內容。 |
| Repository switch | 舊 repo 的 refresh 永遠不能更新新 repo UI、cache 或 sidebar。 |
| Oversized blob | 記憶體不隨完整 blob 大小成比例成長；結果回報 oversize，且 child 正常結束。 |
| Copy race | 只有最後一次 copy request 能寫 clipboard 與顯示成功。 |
| PR 首屏 | 初始載入執行 0 次 full patch command；同時最多一個 active compare request。 |
| History copy | 同一 repo/ref 的 N 個檔案使用一個 batch process，而非 N 個序列 process。 |
| Flow dropdown | 一次開啟不超過 3 個 Git process。 |
| Operation state | 已知 git dir 後不需額外 Git process。 |
| Contributor stats | 一次完整 history scan 即產生所需統計。 |
| Startup | 未開啟對應 UI 時，不 eager prefetch graph providers。 |
| Activity log | remote URL 含 credential 時，任何 activity message 都不包含明文 secret。 |

除功能測試外，Phase 1 與 Phase 2 應建立固定 benchmark fixture，至少涵蓋：

- 10,000 個 changed paths。
- 單一超大 blob。
- 多個接近單檔上限、但合計超過總量上限的 blobs。
- 1,000 commits／1,000 changed files 的 compare。
- compare、copy 與 repository switch 的人工延遲 race。

## 9. 不建議現在做的事（YAGNI）

- 不全面以 `vscode.git` 取代 Git CLI；其 public API 不涵蓋目前所有 graph／blob／stash／compare 語意。
- 不導入新的泛用 Git library。
- 不先建立常駐 `git cat-file` daemon；先以每次 operation 一個 bounded batch process 解決主要問題。
- 不用任意提高 concurrency 掩蓋序列流程；先 batch、dedupe、lazy load 與取消。
- 不平行 push 多個 remotes；遠端 mutation 的錯誤恢復與使用者預期更重要。
- 不更動 clipboard text contract，避免破壞 IntelliJ ↔ VS Code cross-tool restore。
- 不把 root feature 深度耦合到 vendored graph internal service。
- 不趁此重寫與問題無關的上游 graph 程式碼。

## 10. 本次已排除或已有保護的項目

下列項目在本次審查中未被列為主要缺陷：

- 一般 shell injection：Git 呼叫多數走 argv spawn，且 pathspec 使用 `--` 分隔。
- rename、tab、newline 與非 ASCII path：主要解析流程已使用 `-M -z` 與 `core.quotePath=false`，並保留 old path。
- read cache 的 stale in-flight write：generation 機制已有保護，不需重寫整套 cache。
- linked worktree git dir：現有 resolver 已處理 `.git` file／common dir 情境。
- file watcher：已有局部更新設計，問題集中在 repository/request 跨界 race，而非「所有 watcher 都應重做」。

## 11. 建議實作切票方式

為降低 review 風險，建議每張票只建立一個可驗證 invariant：

1. Sanitize Git child environment（denylist 含 `GIT_INDEX_FILE`／`GIT_OBJECT_DIRECTORY`，逐項附測試）。
2. Auto-stash returns/restores exact created object（apply → verify `stash@{n}` → drop；conflict 時保留）。
3. MainPanel mutation transaction（固定 `{service, repoPath, epoch}`；transaction 期間延後 repo switch，webview repo pill 依 operating 狀態 disable）。
4. PR compare resolves immutable OIDs。
5. Repository/request epoch gate（涵蓋 `refreshAll()` 的 cache 寫入／post，以及五個 sidebar provider 的**所有** cache write：`doFetch`、`getChildren` fallback、Remotes `branchCache`）。
6. Preserve Git path casing（host、discovery、webview 三份 comparator 一起修）。
7. Streaming bounded blob reader。
8. Copy generation and cancellation。
9. SCM status aggregation。
10. History batch snapshot。
11. PR lazy diff and pagination。
12. Git process-count quick wins。
13. Activity log redaction and hook-fence CI check。

每張票先加入能重現現況的失敗測試，再做最小修正；root 與 graph 的改動分開 review，避免 vendor diff 與 host behavior 混在同一個大型提交。

通用注意：部分既有測試把現況的**錯誤行為**鎖成預期值（已知兩處：P1-2 的 `MainPanel.test.ts#L337`、P1-3 的 `PrView.test.ts#L125`／`L204`）。實作各票時，先確認既有綠燈測試斷言的是「正確行為」還是「現況行為」，屬後者的要與修正同票反轉，不可為了保綠燈而遷就。

## 12. 驗證基線與文件狀態

審查時的測試基線：

- root test suite：135 passed，0 failed。
- graph test suite：1929 passed，11 skipped。

本文件主張已於 2026-07-10 經逐條程式碼核對與修訂：P1-1 的 `GIT_DIR`／`GIT_WORK_TREE` 環境污染已以本機實驗重現（設定這兩個變數指向 repo A 後，對 repo B 執行 `git -C repoB rev-parse --show-toplevel` 會回報 repo A；移除變數後才正確回報 repo B）；root test suite 135 passed 的基線已複核，結果一致。

2026-07-11 追加一輪跨模型複查（Codex／GPT-5.6 對抗性審查，findings 再經獨立驗證確認後採納），本版修訂即來自該輪結果，重點包括：

- 新增 P1-7（多步 mutation handler 跨 repo 漂移），並確認 `switchRepo` 不經 mutation lock、`mutationChain` 為 per-service、repo pill 在 operating 期間未 disable。
- `GIT_INDEX_FILE` 污染已本機重現（`git -C repoB rev-parse --git-path index` 回報污染後的 path），P1-1 denylist 據此擴充。
- `git stash pop <OID>`／`drop <OID>` 拒收 raw OID、`apply <OID>` 不會 drop，已在 git 2.43 實測，P1-2 據此補上 restore lifecycle。
- 完整基線複核：`npm run build` 成功、root test suite 135 passed／0 failed、graph test suite 1929 passed／11 skipped，皆與文件宣稱一致。

尚待驗證（不影響本文件結論，但實作對應票時需先確認）：Windows 真機上 `vscode.git show/buffer` 對 mixed-case tree path 的 fallback 行為；`stash apply/drop` 在專案支援的最低 Git 版本上的行為差異。

本文件只記錄審查結果與建議方案；尚未實作上述修改，也未宣稱任何風險已修復。後續若開始實作，應先從 Phase 0 拆票並鎖定對應 regression tests。
