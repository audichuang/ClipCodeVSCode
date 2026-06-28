# Spec: ClipCode History 視圖(Git 歷史版本複製)

Date: 2026-06-28
Status: Draft(待 Codex 複查 + 使用者 review)
研究依據:`docs/research/2026-06-28-git-history-api-research.md`(API 能力已實機驗證)
前置交接:`HANDOFF-git-history-view-2026-06-28.md`

## 1. 目標與動機

VSCode port 目前缺 IntelliJ 版的「在 Git Log commit 檔案樹上挑檔、複製該 commit 版本內容」功能。
VSCode 內建沒有歷史 commit 的檔案樹,也不能注入第三方擴充(GitLens/Git Graph)的右鍵選單,
因此**自製一個 TreeView 側邊欄視圖**:列 commit → 展開成變更檔資料夾樹 → 多選 → 右鍵
`ClipCode: Copy Full Source`,複製選中檔在該 commit 的內容。

複製格式與既有 staged/unstaged 複製、與 IntelliJ 三邊一致(沿用 `buildGitPayload` + label)。

### 非目標(YAGNI)

- merge commit 的 combined diff(只取相對第一 parent 的變更,見 §5)。
- 跨分支 / 全 ref 的 commit 視圖(只看目前 repo 的預設 log 範圍)。
- 自建 Activity Bar 圖示(掛在內建 SCM 容器底下)。
- 自動跟隨 SCM 面板的 repo 選擇(改為記住上次手動選的)。
- checkbox 勾選集合(改用原生多選)。

## 2. 範圍邊界

**做**:新 TreeView 視圖、多 repo 手動切換、commit 分頁載入、變更檔資料夾樹、原生多選、
右鍵複製、同檔去重、重用既有格式/設定。

**不做**:既有的 staged/unstaged 複製(已存在於 SCM 面板,不動);任何第三方依賴;自行 spawn git。

## 3. 視圖落點與貢獻點(package.json)

- `contributes.views.scm` 新增一個 view:
  - id:`clipcode.history`
  - name:`ClipCode History`
  - icon:`$(history)`
- `contributes.viewsWelcome`(可選):無 repo / 無 commit 時顯示引導文字。
- `contributes.commands` 新增:
  - `clipcode.history.switchRepository`(title:`ClipCode: Switch Repository`,icon:`$(repo)`)
  - `clipcode.history.copyFullSource`(title:`ClipCode: Copy Full Source`)
  - `clipcode.history.loadMore`(title:`Load More`)— 由「載入更多」節點觸發
  - `clipcode.history.refresh`(title:`Refresh`,icon:`$(refresh)`)
- `contributes.menus`:
  - `view/title`:`switchRepository`、`refresh`(`when: view == clipcode.history`)
  - `view/item/context`:`copyFullSource`(`when: view == clipcode.history`)
- `activationEvents`:新增 `onView:clipcode.history`。
- `view/item/context` 的 `when` 需收窄到實檔/資料夾/commit 節點,避免出現在 loadMore/loading/error 節點:
  `when: view == clipcode.history && viewItem =~ /^(commit|folder|file)$/`。

### 環境需求(engine bump,取代原 feature-detect 方案)

- **`engines.vscode` 從 `^1.92.0` bump 到 `^1.108.0`**,並把 `devDependencies` 的
  `@types/vscode` 一併釘到 `^1.108.0`(對齊真實最低版,避免對著更新的型別編譯卻在舊 runtime 執行炸)。
- 原因(Codex 複查實證,比對各 VSCode tag 的 `git.d.ts`):
  - `LogOptions.skip`(分頁)自 **1.93** 起才存在。
  - `diffBetweenWithStats` 自 **1.108** 起才存在。
- 取 1.108 作為最低版 → `skip` 與 `diffBetweenWithStats` **皆保證存在**,可直接使用,
  **不需** runtime feature-detect、不需本地切片分頁、不需 `diffBetween` 後備。程式最簡且行為正確。

## 4. 多 Repo 模型

- **一次只顯示一個 repo** 的歷史。當前 repo 存於記憶體,並持久化到 `workspaceState`(key 例如
  `clipcode.history.lastRepoRoot`,存 `rootUri.toString()`)。
- 決定當前 repo 的順序:
  1. `workspaceState` 記住的上次 repo(若仍在 `api.repositories` 內)。
  2. 否則 `api.repositories` 中 `repo.ui.selected === true` 的那個(首次種子;**不**訂閱 `ui.onDidChange`)。
  3. 否則 `api.repositories[0]`。
  4. 都沒有 → 空視圖 + welcome 文字。
- `switchRepository` 指令:`window.showQuickPick(api.repositories.map(rootUri basename))` → 選定後更新
  當前 repo、寫回 `workspaceState`、refresh 樹。
- 訂閱 `api.onDidOpenRepository` / `onDidCloseRepository`:清單變動時刷新;若記住的 repo 被關 → 回退到上面順序。
- **Git 擴充停用守衛(Codex BLOCKER 修正)**:`GitExtension.getAPI(1)` 在 Git 被停用時會**丟例外**(非回傳空)。
  activate 取 API 時必須:① 先檢查 `gitExtension.exports.enabled`、② `getAPI(1)` 包 try/catch、
  ③ 訂閱 `gitExtension.exports.onDidChangeEnablement`(停用→啟用時再取 API + refresh)。
  Git 未安裝/停用 / 無 repo → 顯示 welcome 文字,不報錯。

## 5. 資料層(`src/gitHistory.ts`)

純資料封裝,**不碰 UI**,可單測(以 fake repo 物件注入)。

```ts
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // SHA-1 repo 的 empty tree

listCommits(repo, { limit, skip }): Promise<Commit[]>
  → repo.log({ maxEntries: limit, skip })

listCommitFiles(repo, commit): Promise<Change[]>
  const ref1 = commit.parents[0] ?? EMPTY_TREE;
  return repo.diffBetweenWithStats(ref1, commit.hash);     // DiffChange[] ⊇ Change[]
  // engine ≥1.108 保證有 diffBetweenWithStats;不需 feature-detect / diffBetween 後備。

readFileAtCommit(repo, hash, change): Promise<string | undefined>
  → 重用既有 readRepositoryContent 邏輯,ref = commit hash;
    deleted → DELETED_FILE_MARKER;失敗退 buffer + decodeText;二進位(含 \0)→ undefined 跳過。
```

### API 事實(已驗證,見研究文件)

- `repo.log({ maxEntries, skip })`:分頁;`Commit.parents: string[]`(root=`[]`、merge=2+)。
- `diffBetweenWithStats(ref1, ref2)`:內部對 `EMPTY_TREE` 走 `git diff-tree`(處理 root commit),
  其餘走三點 `ref1...ref2`;回傳 `DiffChange extends Change`(有 `uri/originalUri/renameUri/status`)。
- `diffBetween(ref1, ref2)`:走三點;**不**處理 empty tree(對 root commit 會丟
  `fatal: Invalid symmetric difference expression`)→ 故不採用,改用 `diffBetweenWithStats`。
- `show(ref, path)` / `buffer(ref, path)`:path 為 repo 相對。

### 邊角處理

| 情境 | 行為 |
|---|---|
| 一般 commit(單 parent) | `diffBetweenWithStats(parents[0], hash)` = 此 commit 引入的變更(正確)。 |
| root commit(無 parent) | `diffBetweenWithStats(EMPTY_TREE, hash)` 特例 → 全部檔標 NEW。**僅 SHA-1 repo**:硬編 `4b825dc…` 是 SHA-1 的 empty tree;SHA-256 repo 的 empty tree hash 不同、`===` 比對不中 → root commit 會 fail(邊角的邊角,不處理,見 §11)。 |
| merge commit | 相對第一 parent;會列出整條併入分支的檔(量可能大)。**已知簡化**,不做 combined diff。 |
| rename / move | status=RENAMED;對新路徑(`change.uri`/`renameUri`)`show(hash, rel)`;label `[MOVED]`。 |
| deleted | status=DELETED;`DELETED_FILE_MARKER` + label `[DELETED]`。 |
| 二進位 / 非 UTF-8 | `decodeText` 偵測 `\0` → 跳過;非 UTF-8 best-effort(沿用既有)。 |

（環境/版本需求見 §3「環境需求」:engine `^1.108.0`,`skip` 與 `diffBetweenWithStats` 皆保證存在。）

## 6. 樹結構(`src/historyTreeProvider.ts`)

`TreeDataProvider<HistoryNode>`,節點型別:

```
CommitNode  { kind:'commit', repo, commit }                       ← 訊息首行 + 短hash;tooltip:作者/日期/full hash
FolderNode  { kind:'folder', repo, commit, segments[], children } ← 單鏈壓縮(src/auth 併一列)
FileNode    { kind:'file',   repo, commit, change, relPath }      ← label 前綴 [NEW]/[MODIFIED]/[DELETED]/[MOVED]
LoadMoreNode{ kind:'loadMore' }                                   ← 末端;觸發抓下一頁
```

- 頂層:目前 repo 的 commit 清單(最新在上)+ 末端 `LoadMoreNode`(還有更多時)。
- `CommitNode` 展開時**才** lazy 載入變更檔(`listCommitFiles`),建出資料夾樹。
- **資料夾單鏈壓縮**:只有單一子資料夾的鏈合併成一個節點(`src` → `src/auth` 併為 `src/auth`),對齊 IntelliJ 與核可的 mockup。
- `contextValue` 區分節點(`commit`/`folder`/`file`/`loadMore`/`loading`/`error`),供右鍵 `when` 判斷
  (右鍵僅對 `commit`/`folder`/`file` 出現,見 §3 的 `viewItem` 收窄)。
- 載入中 / 載入錯誤:該 commit 顯示 placeholder 子節點(`Loading…` / `Failed to load changes`,`contextValue` 為 `loading`/`error`)。

### 節點→檔案收集契約(Codex MAJOR 修正:收合 commit 也要能複製)

因 commit 子檔是 lazy 載入,**收合(從未展開)的 `CommitNode` 沒有 realized 子節點**,naïve 遞迴會收集到 0 檔。
故定義:
- `listCommitFiles(repo, commit)` 結果**快取**於該 `CommitNode`(展開與右鍵共用同一快取)。
- `getFilesForNode(node): Promise<FileRef[]>`:
  - `CommitNode` → `await ensureCommitFilesLoaded(node)`(沒載過就現在 `listCommitFiles`),回傳全部檔。
  - `FolderNode` → 回傳其子樹所有 `FileNode`(用已建好的樹)。
  - `FileNode` → 回傳該檔。
- 複製流程一律走 `getFilesForNode`,因此「右鍵一個從未展開的 commit → 複製全部檔」可正確運作。

### 分頁

- 預設每頁 `maxEntries: 50`,`skip = loadedPages * 50`。
- 點 `LoadMoreNode` → 抓下一頁 append → 若回傳數 < 50 表示到底 → 移除 `LoadMoreNode`。

## 7. 選取與複製互動(`src/historyView.ts`)

- `window.createTreeView('clipcode.history', { treeDataProvider, canSelectMany: true })`。
- 原生多選:**點選 + Shift 選區間 + Ctrl/⌘ 單獨加選**,可跨 commit 累積。**無 checkbox。**
- 右鍵 `ClipCode: Copy Full Source`(`view/item/context`)。
  **命令簽名(Codex MAJOR 修正)**:`canSelectMany` 的 tree 命令會收到
  `copyFullSource(clicked?: HistoryNode, selected?: HistoryNode[])`——arg1 是被點的項、arg2 是整個多選集合。
  收集來源節點的順序:**`selected`(若含 `clicked`)→ 否則 `[clicked]` → 再否則 `treeView.selection`**
  (涵蓋右鍵未選中項、命令面板呼叫等情境;不可只讀 `treeView.selection`)。
- 對每個來源節點呼叫 `getFilesForNode`(見 §6 契約)再攤平、去重:
  - `FileNode` → 該檔;`FolderNode` → 子樹所有檔;`CommitNode` → 該 commit 全部檔(含未展開者)。
- **同檔去重**:依 **repo 相對路徑** 去重;同路徑跨多個被選 commit 出現時,取
  **commitDate 較新** 的 commit 版本(`commitDate` 缺時退「在 log 中較前者=較新」)。
- 收集後:逐檔 `readFileAtCommit` → 套既有 settings(filters / `maxFileSizeKB` / `fileCountLimit`)→
  `buildGitPayload`(deleted/index 內容情境用 fallback payload,沿用既有 `usesRegularSpacing` 判斷)→
  `vscode.env.clipboard.writeText`。
- 通知(若 `showCopyNotification`):`已複製 N 個 Git 檔` + 既有 skipped/limit 後綴。
- 無選取 → `showWarningMessage('No files selected.')`。

## 8. 內容與格式重用 + 小重構

- **重用**:`clipboardFormat.ts`(`buildGitPayload`/`formatHeader`)、`gitCopy.ts`
  (`mapGitStatusToChangeType`/`DELETED_FILE_MARKER`)、`settings.ts`、`pathResolver.ts`
  (`toClipboardPathFromRoots`)、`filterMatcher.ts`。
- **小重構(focused)**:把 `extension.ts` 內現為私有的 `readRepositoryContent`、`decodeText`、
  `isTextContent`、`repoRelativePath` 抽到共用模組(`src/gitContent.ts`),讓 `copyGitChanges` 與
  歷史視圖共用同一套「讀 ref 內容」邏輯。`extension.ts` 改為 import。不改行為、不做無關重構。
- 路徑:`Change.uri` 為工作區絕對路徑;複製 header 路徑用 `toClipboardPathFromRoots`(維持與既有一致)。

## 9. 模組切分

| 檔案 | 職責 | 依賴 |
|---|---|---|
| `src/gitHistory.ts` | 資料層:`listCommits`/`listCommitFiles`/`readFileAtCommit` | git API(注入)、`gitContent`、`gitCopy` |
| `src/historyTreeProvider.ts` | `TreeDataProvider`:節點、資料夾壓縮、lazy、分頁 | `gitHistory` |
| `src/historyView.ts` | 註冊 view + 指令、repo 切換/持久化、選取→複製 | `gitHistory`、`historyTreeProvider`、`clipboardFormat`、`settings`、`pathResolver`、`filterMatcher` |
| `src/gitContent.ts`(新,重構抽出) | 讀某 ref 的檔內容(show→buffer→decode) | git API、vscode.fs |
| `src/extension.ts` | activate 時取 git API、建 provider/view、註冊指令 | 上述 |

## 10. 測試(TDD,延續既有 31 個 `node:test`)

純邏輯以 fake repo / fake change 物件注入,不需真 VSCode runtime:

- `gitHistory.listCommitFiles`:① 一般 commit 呼叫 `diffBetweenWithStats(parents[0], hash)`、
  ② root commit 呼叫 `diffBetweenWithStats(EMPTY_TREE, hash)`(驗 ref1 帶 `4b825dc…`)。
- `gitHistory.readFileAtCommit`:deleted → marker;二進位 → 跳過;`show` 失敗退 `buffer`。
- 樹聚合:資料夾單鏈壓縮(`src/auth` 併一列)、巢狀正確;`LoadMoreNode` 出現/消失;分頁 `skip` 遞增正確。
- **節點→檔案收集**:`getFilesForNode` 對 `FolderNode`/`CommitNode` 攤平;
  **收合(未展開)的 `CommitNode` 也能收齊全部檔**(驗 `ensureCommitFilesLoaded` 會觸發 `listCommitFiles`)。
- **命令參數解析**:`copyFullSource(clicked, selected)` 的來源解析(selected 含 clicked / 僅 clicked / 退 selection)。
- 複製收集:**跨 commit 同檔去重取較新 commitDate**;套用 size/limit/filter。
- `gitContent`:抽出後既有 `copyGitChanges` 行為不變(回歸)。

## 11. 風險與已知簡化

- merge commit 列檔量大(相對第一 parent)——已知,文件標明,未來可加 combined diff。
- SHA-256 repo 的 empty tree hash 與硬編 `4b825dc…`(SHA-1)不同 → root commit 在 SHA-256 repo 會 fail。
  邊角的邊角,**不處理**;可在 root commit 載入失敗時顯示 error placeholder 而非崩潰。
- 最低 VSCode:engine `^1.108.0`(`skip`/`diffBetweenWithStats` 的真實最低版)→ 比 1.108 舊裝不了,為刻意取捨。
- 大 repo log:已分頁(`maxEntries`+`skip`);`listCommitFiles` 僅展開或複製時載入,降低初始成本。

## 12. 驗收標準

1. 在 SCM 容器看到 `ClipCode History`;列出目前 repo 最新 commit,可「載入更多」。
2. 可切換 repo,且下次打開記住上次選的 repo。
3. 展開 commit 顯示資料夾樹(單鏈壓縮),檔案有變更類型標籤。
4. 點選 + Shift/Ctrl 多選(含跨 commit);右鍵 `Copy Full Source` 複製選取檔/資料夾/整個 commit。
5. 複製內容格式與既有 git 複製一致(同檔去重取較新 commit;deleted 用 marker)。
6. root / merge / rename / deleted / 二進位皆不崩,行為如 §5 表。
7. `npm test` 既有 31 + 新增測試全綠;`copyGitChanges` 重構後行為不變。
