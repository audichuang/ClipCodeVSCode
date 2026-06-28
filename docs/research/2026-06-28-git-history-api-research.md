# Research: VSCode 內建 Git API 對「Git 歷史版本複製」的能力

Date: 2026-06-28
Status: 研究完成,供 brainstorming ②③ 與 spec 使用。
驗證環境:已安裝的 `vscode.git` 擴充 v10.0.0(`~/.vscode-server/.../extensions/git`)、
權威型別 `microsoft/vscode:extensions/git/src/api/git.d.ts`(main 分支)、
本機 `@types/vscode` 1.125.0、實機 `git` 語義測試(本 repo + openclaw 422 個 merge)。

## 結論一句話

內建 Git API **足以**做完整功能,**零第三方依賴、零自行 spawn git**。
三個資料層動作都有對應的穩定 API,且邊角(root commit / merge / rename / deleted / 編碼)都有可行解。

## 1. 取 commit 清單 — `repository.log(options)`

```ts
log(options?: LogOptions): Promise<Commit[]>;

interface LogOptions {
  maxEntries?: number;   // 預設 32
  skip?: number;         // ← 分頁靠這個
  range?: string; reverse?: boolean; sortByAuthorDate?: boolean;
  shortStats?: boolean; author?: string; grep?: string;
  refNames?: string[]; maxParents?: number;
}

interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];          // ← root commit = []，merge = 2+
  readonly authorDate?: Date; readonly authorName?: string; readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly shortStat?: CommitShortStat;
}
```

- 分頁:`{ maxEntries: N, skip: N*page }` → 直接支援「載入更多」。
- 預設只回 HEAD 可達的 commit;要跨分支可帶 `refNames`(本功能先不需要,YAGNI)。

## 2. 取「某 commit 的變更檔」— 用 `diffBetweenWithStats`,**不要**用 `diffBetween`

### 關鍵發現:`diffBetween` 內部是三點 `a...b`,且**不處理 empty tree**

反編譯 v10.0.0:
```js
diffBetween(e,t,r){ let n=`${e}...${t}`; ... }   // 三點,對稱差
```
- 一般(單 parent)commit:三點 `parent...hash` == 兩點 `parent..hash`(因 parent 即 merge-base)
  → **正確**。實測本 repo / openclaw:三點、兩點、`git show` 三者檔案數一致。
- **root commit(無 parent):用 empty tree 走三點會直接報錯**
  實測 `git diff 4b825dc...<root>` → `fatal: Invalid symmetric difference expression`
  (empty tree 是 tree 不是 commit,沒有 merge-base)。所以 `diffBetween` **無法**處理首個 commit。

### 解:`diffBetweenWithStats` 有 empty-tree 特例,可統一處理所有 commit

```ts
diffBetweenWithStats(ref1: string, ref2: string, path?: string): Promise<DiffChange[]>;
interface DiffChange extends Change { readonly insertions: number; readonly deletions: number; }
// DiffChange 是 Change 的超集 → 有 uri / originalUri / renameUri / status,額外多 stats
```
反編譯 v10.0.0:
```js
diffBetweenWithStats(e,t,r){
  if(e===this._EMPTY_TREE) return this.diffTrees(e,t);              // ← root commit 走這條
  return ...repository.diffBetweenWithStats(`${e}...${t}`, {...});  // 其他走三點
}
diffTrees(e,t,...){ ["diff-tree","-r","--raw","--numstat","-z", e, t, "--"] }  // 兩參數,可行
```
實測 `git diff <empty> <root>` 兩參數 → 正常列出所有檔(全部 Added)。

**資料層統一寫法**:
```ts
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // SHA-1 repo 的 empty tree
const ref1 = commit.parents[0] ?? EMPTY_TREE;
const changes = await repo.diffBetweenWithStats(ref1, commit.hash); // DiffChange[] ⊇ Change[]
```

### 邊角結論

| 情境 | 行為 |
|---|---|
| 一般 commit | `diffBetweenWithStats(parents[0], hash)` → 正確的「此 commit 引入的變更」 |
| root commit(無 parent) | `parents[0] ?? EMPTY_TREE` → 走 `diff-tree` 特例,全部檔標 Added/NEW |
| merge commit | 用 `parents[0]`(相對第一 parent)→ 會列出「從另一分支併入的全部檔」(openclaw 實測 304 檔,非 IntelliJ 的 combined-diff 13 檔)。內容上沒錯,量可能大。**列為已知簡化**,先不做 combined diff(YAGNI)。 |
| rename / move | `Change.status=INDEX_RENAMED/...`,`originalUri`=舊路徑、`renameUri`/`uri`=新路徑;對新路徑 `show(hash, newRel)` 取內容。沿用既有 `gitCopy.ts` 的 MOVED 對應。 |
| deleted | status=DELETED,該檔在此 commit 已不存在 → 沿用既有 `DELETED_FILE_MARKER` + `[DELETED]` 標籤。 |

### 兩個 API 可用性 / 環境注意

- **版本可用性(Codex 複查實證,比對各 VSCode tag 的 `git.d.ts`)**:
  `LogOptions.skip` 自 **1.93** 起、`diffBetweenWithStats` 自 **1.108** 起才存在。
  本機已安裝的 git 擴充 v10.0.0(隨新版 VSCode)兩者都有,但**公開 engine 版本才是相容性依據**。
  **決策(spec §3):bump `engines.vscode` → `^1.108.0`、`@types/vscode` 一併釘 `^1.108.0`**,
  直接用 `skip` + `diffBetweenWithStats`,不做 feature-detect/本地切片。
- `_EMPTY_TREE` 擴充內是用 `hash-object -t tree /dev/null` 動態算,比較是 `===`。
  我們硬編 SHA-1 值;**SHA-256 repo 的 empty tree hash 不同 → 比較不中 → root commit 會 fail**。
  這是「邊角的邊角」,先記錄不處理。

## 3. 取「該 commit 版本的檔案內容」— `repository.show(ref, path)`

```ts
show(ref: string, path: string): Promise<string>;     // path 需 repo 相對(內部 sanitizeRelativePath)
buffer(ref: string, path: string): Promise<Buffer>;    // 二進位 / 編碼 fallback
getObjectDetails(treeish, path): Promise<{mode,object,size}>;
```
- **直接重用既有 `extension.ts` 的 `readRepositoryContent(repo, ref, uri)`**:它已經
  ① 轉 repo 相對路徑、② `show` 失敗退 `buffer`+`decodeText`、③ 用 `\0` 偵測二進位跳過。
  歷史版本只是把 `ref` 從 `HEAD`/index 換成 **commit hash**,其餘照舊。
- `Change.uri` 是工作區絕對路徑;rename 取 `uri`(新路徑)轉相對給 `show(hash, rel)`。

## 4. 參考專案 git-graph-plus(Apache-2.0,只借鏡、未搬碼)

- 架構:commit 圖本身是 **Webview**;側欄 branches/tags/stashes/worktrees 是 **TreeDataProvider**。
- 資料來源:**混用**內建 git API(`vscode-git-bridge.ts`)+ **直接 spawn git binary**(`git-binary.ts`)做重活。
  → 對我們的啟示:它 spawn 是因為要畫複雜 graph;**我們的三個動作內建 API 已足,不必 spawn**。
- 它的側欄 view 全部掛在內建 **`scm`** view container 底下(`contributes.views.scm`),
  **沒有** `viewsContainers`,即 **不自建 Activity Bar 圖示**。→ 佐證「掛 SCM 容器」是慣用、低摩擦做法。
- 它 **沒有** 用 `TreeItemCheckboxState`(無 checkbox)。→ 我們的 checkbox 要靠 VSCode 原生 API。

## 5. TreeView / checkbox / 多選 — 原生 API 已就緒(@types/vscode 1.125.0 實測有)

- `TreeDataProvider<T>` + `window.createTreeView(id, { treeDataProvider, canSelectMany: true })`。
- checkbox:`TreeItem.checkboxState`(`TreeItemCheckboxState.Checked/Unchecked`)
  + `treeView.onDidChangeCheckboxState`(批次事件)。皆自 VSCode 1.72 起,遠在 1.92 之內。
- 右鍵:`contributes.menus["view/item/context"]` + `when: view == <id> && viewItem == <contextValue>`。
- view title 按鈕:`contributes.menus["view/title"]` + `when: view == <id>`。

## 對 brainstorming ②③ 的輸入

- ②(資料載入):`log({maxEntries, skip})` 分頁;每 commit 展開時才 `diffBetweenWithStats` lazy 載變更檔;
  多 repo 時頂層先分 repo(`api.repositories`)。資料夾單鏈壓縮先不做(YAGNI)。
- ③(選取/複製):checkbox 集合為複製來源(view/title「複製全部勾選」);右鍵 `Copy Full Source` 複製當下節點/勾選;
  去重取「最新被選 commit」版本(交接已定);deleted → marker;沿用 `buildGitPayload` + settings(size/limit/filter)。

## 待使用者拍板(唯一卡點)

- **視圖落點**:掛內建「原始檔控制(SCM)」容器下新增一個 view,還是像 GitLens 自建 Activity Bar 圖示?
