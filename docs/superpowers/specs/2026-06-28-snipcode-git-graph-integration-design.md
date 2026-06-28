# Spec: Snipcode × git-graph-plus 線圖整合

Date: 2026-06-28
Status: **Reworked v2.1 — Codex 兩輪複查通過(Ship)**,進 writing-plans
前置:Snipcode(`clipcode-vscode`)已發布,含 SCM 複製 + Snipcode History 樹視圖 + 還原。
參考授權:git-graph-plus 為 **Apache-2.0**(可收編、改、發布,需保留 LICENSE + 標註修改)。

> v2 變更:Codex 唯讀複查(2026-06-28)判定高層方向可行但 4 個 contract 未寫死,會在 spike 爆。本版把它們升為**正規需求**:§6.1 build entry、§6.2 webview asset root、§4.0 `activateGraph` adapter、§5.0 normalized payload。§7 spike 從 3 條擴為 6 條。git-graph-plus 原始碼尚未 subtree add,凡標 **[Verify in spike]** 者為第一步實測項。

## 1. 目標

在**同一個 Snipcode 擴充**內收編 the0807/git-graph-plus 的 commit 線圖(webview),
並在線圖的 **commit 右鍵** 與 **commit 變更檔右鍵** 加上 **「Copy Full Source」**,
用**既有 Snipcode 複製格式**複製選中檔在該 commit 的內容。
**所有既有功能保留不變**(SCM 群組複製、Snipcode History 樹、貼上還原)。

## 2. 已定架構決策(使用者已核可)

1. **同一個擴充**:維持 `publisher=audichuang`、`id=clipcode-vscode`、`displayName=Snipcode`。不另發第二個擴充。
2. **git subtree 收編**:git-graph-plus 放進子目錄 `graph/`,以 `git subtree pull` 同步上游;**永不回 PR**。
3. **vendored 碼「只加不改、改必標記」**:我們的程式全在自有檔;對 `graph/` 內檔案的修改限縮到少數接縫,每處用唯一標記 `/* SNIPCODE-HOOK */` 框住。**接縫數不設硬上限**(見 §4)——紀律是「每處都標記 + 邏輯不寫在 vendored」,不是「剛好 5 處」。
4. **複製格式完全一致**:重用 `src/clipboardFormat.ts`、`src/gitCopy.ts`、`src/gitContent.ts`、`src/settings.ts`。parity 細節見 §5.0。
5. **build 改為 esbuild + Svelte**:採 git-graph-plus 的工具鏈;Snipcode 原 `tsc` 模組改由 esbuild 一起打包。entry contract 見 §6.1。
6. **兩範圍都做**:既有 SCM/History 複製不動 + 線圖右鍵複製。

## 3. Repo 結構

```
clipcode-vscode/ (host repo = Snipcode)
├─ package.json            ← 單一 manifest(合併規則見 §6.3);main = ./dist/extension.js(§6.1)
├─ esbuild.config.mjs      ← 打包 host bundle(我們的 extension.ts,內含 activateGraph 呼叫)
├─ src/                    ← 我們的程式(不動 graph/)
│   ├─ extension.ts        ← 合併 activate:既有註冊 + activateGraph(context, opts) + copy 指令
│   ├─ clipboardFormat.ts / gitCopy.ts / gitContent.ts / gitHistory.ts / historyTree.ts / historyView.ts / settings.ts …(既有,§5 會擴 gitCopy 的 status 對應)
│   └─ graphCopy.ts        ← 新:線圖複製 host 端邏輯(normalized payload → 讀內容 → 組 payload → 剪貼簿)
├─ graph/                  ← git subtree of the0807/git-graph-plus(盡量原封)
│   ├─ src/ (MainPanel.ts, git/git-service.ts, utils/message-bus.ts, extension.ts …)
│   ├─ webview-ui/ (Svelte 前端;含右鍵選單)
│   └─ esbuild.config.mjs / package.json(vendored)
├─ dist/                   ← 唯一輸出:host bundle + graph webview assets(§6.1/§6.2)
├─ test/                   ← 既有 node:test + 新增 graphCopy 純邏輯測試
└─ docs/ …
```

**單一 manifest 原則**:VSCode 只讀 host 的 `package.json`。graph 的 `contributes` 一次性合併進來;合併 checklist 見 §6.3。

## 4. 整合接縫(唯一會改 vendored 的地方,全標 `/* SNIPCODE-HOOK */`)

### 4.0 `activateGraph` adapter contract(Blocker 修正:vendored activate 不是 library)

vendored 的 `activate` 是擴充入口,不是函式庫;直接 import 會踩重複註冊、reload 後 leak、deactivate 不清。**定 host-facing adapter**:

```ts
// graph 端(S5,標記)導出:
export function activateGraph(context: vscode.ExtensionContext, opts: {
  assetRootUri: vscode.Uri;        // host 傳入,見 §6.2
  copyFullSourceAtCommit:          // host 注入的複製 handler(S2 轉呼叫它,邏輯在 src/graphCopy.ts)
    (payload: GraphCopyPayload) => Promise<void>;
}): void   // 內部所有 disposables 一律 push 進 context.subscriptions
```

- host `extension.ts` 在既有註冊之後呼叫 `activateGraph(context, { assetRootUri, copyFullSourceAtCommit })`。
- **handler 注入 contract**:S2 的 `case 'snipcodeCopyFullSource'` 只呼叫 `opts.copyFullSourceAtCommit(payload)`,不靠隱式 import/global。vendored 對 host 邏輯零依賴(僅持有 opts 給的 callback),維持 adapter 邊界。
- vendored 若有 module-level globals / watchers / webview singleton → **[Verify in spike]** 列出,確保都掛在 `context.subscriptions`;若 vendored 有 `deactivate`,host `deactivate` 代理之。
- 驗收:reload / disable+enable 兩輪,無 duplicate command、無未 dispose 資源(§7 spike 3)。

### 4.1 接縫表(行號為現況推斷,實作以實際錨點字串為準)

| # | vendored 檔 | 改動(僅加,標記) |
|---|---|---|
| S1 | `graph/src/utils/message-bus.ts` | 新增訊息型別 `{ type:'snipcodeCopyFullSource'; payload: GraphCopyPayload }`(型別見 §5.0) |
| S2 | `graph/src/panels/MainPanel.ts`(handleMessage switch) | 新增 `case 'snipcodeCopyFullSource'`:呼叫 `opts.copyFullSourceAtCommit(payload)`(§4.0 注入的 callback,邏輯不寫這) |
| S3 | `graph/webview-ui/src/components/commit/CommitDetails.svelte`(檔案右鍵) | 加選單項「Copy Full Source」→ `postMessage({type:'snipcodeCopyFullSource', payload})`(選取檔 `selectedPatchFiles` 或 `[node]`) |
| S4 | `graph/webview-ui/src/components/graph/CommitGraph.svelte`(commit 右鍵) | 加選單項「Copy Full Source」→ **先確保該 commit 變更檔已載**(見下),再 `postMessage(... 全部變更檔)` |
| S5 | `graph/src/extension.ts` | 導出 `activateGraph`(§4.0) |

**S3/S4 lazy-load 風險(Major 修正)**:§5 原假設「commit 右鍵取已載清單即可」可能不成立——若 diff 是 lazy load 在 MainPanel。**[Verify in spike]** webview store/message flow。明確序列:**右鍵 → 若 files 未載 → request diff → await store 更新 → 才 post normalized payload**。這條若需要動到 store/message 不只一處,接受之(都標記),不為「壓在 5 處」而犧牲正確性。

**接縫紀律**:每處只放「型別 / 轉呼叫 / 選單項 / 序列」極小片段,實質邏輯在 `src/graphCopy.ts`。

## 5. 複製邏輯(我們的檔 `src/graphCopy.ts`,不在 vendored)

### 5.0 Normalized payload contract(Major 修正:status/path/formatter parity)

webview 端傳來的東西**不可**直接餵既有複製碼。先正規化:

```ts
interface GraphCopyFile {
  repoRootFsPath: string;     // 該檔所屬 repo root(multi-root 必要)
  relativePath: string;       // repo-relative,POSIX 斜線
  oldRelativePath?: string;   // rename/copy 來源
  status: 'A'|'M'|'D'|'R'|'C';// canonical enum;R/C 帶相似度時截到字首
}
interface GraphCopyPayload { hash: string; files: GraphCopyFile[]; }
```

- **status 對應**:`mapGitStatusToChangeType` 目前只認 VSCode Git API 的 numeric/status,不認 `R100`/`C75` 之類 porcelain 碼 → 會 default 成 MODIFIED。**擴充 mapping 並補測 A/M/D/R/C**(§8)。
- **內容讀取**:用既有 `gitContent.readRefContent(repo, ref=hash, fileFsPath)`。它需要 `ContentRepo`(VSCode Git API repo,有 `rootUri.fsPath` + `show/buffer`)+ **絕對** fileFsPath;故 host 端要把 `repoRootFsPath` 對應到對應的 VSCode Git API repository,再以 `repoRootFsPath + relativePath` 組絕對路徑。**決策:用 VSCode Git API,不依賴 vendored git-service**(避免再動 vendored)。
- **formatter 選擇**:既有 SCM 路徑會在 `buildPayload`(regular spacing)/`buildGitPayload` 之間切(`extension.ts:154`)。線圖複製的「與既有一致」指**與 SCM 的 git 複製分支一致** → 固定走 `buildGitPayload`(headerFormat / 標籤 / `DELETED_FILE_MARKER`),並在 spec 明文:線圖複製對齊 git 分支,不走 regular spacing。

### 5.1 流程

```
copyFullSourceAtCommit({ hash, files }):
  for each file:
    changeType = mapGitStatusToChangeType(file.status)   // 擴充後支援 A/M/D/R/C
    if status=D → DELETED_FILE_MARKER(不讀內容)
    else:
      repo = resolveGitRepo(file.repoRootFsPath)          // VSCode Git API
      content = readRefContent(repo, hash, repoRootFsPath + '/' + relativePath)
      二進位/讀取失敗(content===undefined) → 跳過或 marker;size guard(maxFileSizeKB)
  payload = buildGitPayload({ headerFormat, files, preText, postText, addExtraLineBetweenFiles })
  vscode.env.clipboard.writeText(payload)
  通知:已複製 N 檔(沿用 showCopyNotification + skipped/limit 文案)
```

- 格式逐位元組對齊既有 git 複製與 IntelliJ:沿用 `buildGitPayload` + settings(headerFormat / maxFileSizeKB / fileCountLimit)。filters 第一版沿用既有開關(YAGNI)。

## 6. Build / CI

### 6.1 Build entry — single source of truth(Blocker 修正)

現況 `main=./out/src/extension.js`、scripts 為 `tsc` + `node --test out/...`、`.vscodeignore` 排除 `node_modules/**`。整合後**一次改乾淨**:

- `package.json` `main` = **`./dist/extension.js`**(唯一 host entry)。
- root `esbuild.config.mjs` 只產 **host extension bundle** `dist/extension.js`,bundle 進所有 host runtime deps(因 `.vscodeignore` 排除 node_modules)。
- vendored `graph/` 的 `dist/extension.js` entry **不作為擴充入口**;graph 程式以 source import 進 host bundle(或其 panel/命令註冊由 `activateGraph` 帶起)。**[Verify in spike]** 是否有 vendored runtime dep 需一併 bundle。
- scripts 重訂:`build` = 建 graph webview(Svelte)→ 建 host bundle(esbuild);`compile`(給測試)= 既有純邏輯仍可 `tsc`/`esbuild` 出 `out/` 供 node:test;`package` = `vsce package`;`test` = `node --test`(純邏輯)+ 可選 vitest。
- **spike 必跑**:clean checkout `npm ci && npm run build && vsce package` exit 0,且 VSIX 內 `main` 指到實際存在的 host bundle。

### 6.2 Webview asset root contract(Blocker 修正)

vendored 原本假設自己是 extension root;收進 `graph/` 後 `context.extensionUri` 指 **host** root,`asWebviewUri`/`localResourceRoots`/CSP 會 404 或空白。

- 定 `assetRootUri = vscode.Uri.joinPath(context.extensionUri, <graph webview assets 最終落點>)`,由 host 經 `activateGraph(context,{assetRootUri})` 傳入。
- Svelte build output **固定落點**(例:`dist/graph-webview/`),`.vscodeignore` 不可排除之。
- vendored 建立 webview 時:`localResourceRoots` 只放 `assetRootUri`;所有 HTML 內資源用 `webview.asWebviewUri` 基於 `assetRootUri` 解析。**[Verify in spike]** vendored 現有 `asWebviewUri`/CSP 寫法,接縫處改成吃 `assetRootUri`(標記)。
- **spike 必驗**:**packaged**(非僅 F5)後 webview JS/CSS 實際從 `assetRootUri` 載入,無 CSP/404(§7 spike 2)。

### 6.3 Manifest merge checklist(Major 修正:namespace)

合併 graph `contributes` 進 host `package.json` 時逐項過:

- **command / view / viewContainer id**:graph 用 `git-graph.*`;與使用者同裝 standalone git-graph-plus 會撞。**決策點(spike 6 定案)**:改命名空間為 `clipcode.gitGraph.*` / 自有 viewContainer(乾淨、避撞),或明文「不支援與 standalone 並存」。既有 `clipcode.*` 指令 id **不得改**(破壞使用者設定/快捷鍵)。
- `activationEvents`、`menus`、`views`、`viewsContainers`、`configuration`、context keys 全列入合併,避免漏 activation。
- engine:`^1.108.0`(Snipcode 現況已是,> git-graph-plus 的 `^1.85.0`)——**no concern**。
- 日後上游若改 contributes → 手動再合併(衝突面僅此檔)。

## 7. 風險與必做的去風險 spike(擴充版)

**計畫第一步必須是垂直切片 spike(先不做複製功能)**,且須覆蓋以下 6 項——前 5 項任一失敗即**停下、回報、改 spec / 重評可行性**(不預設退路):

1. **clean build + package**:host root `npm ci && npm run build && vsce package` exit 0;確認 `package.json.main` 指向實際 host bundle(§6.1)。
2. **packaged 開圖 + 資產實載**:packaged/等價 dev host 開出線圖,webview JS/CSS 實際從 `assetRootUri` 載入,無 CSP/404(§6.2)。
3. **lifecycle 乾淨**:host 呼叫 `activateGraph` 後 reload + disable/enable 各一輪,無 duplicate command、無未 dispose 資源(§4.0)。
4. **訊息往返 + handler 注入 + 未載清單**:一條真實 commit 的 webview→host→clipboard dummy 訊息通,**且確認走的是 §4.0 注入的 `opts.copyFullSourceAtCommit`(非隱式 import)**;該 commit files **原本未載**時也能拿到 normalized payload(§4.0 / §4.1 S4 / §5.0)。
5. **payload parity dry-run**:不真正寫剪貼簿,印出 A/M/D/R sample 的 status、repoRoot、path、formatter 分支,確認對齊既有 git 複製;**並驗 `repoRootFsPath` 恰好解析到一個 VSCode Git API repository、`readRefContent(repo, hash, absPath)` 對一個非刪除文字檔成功**(§5.0)。
6. **namespace 決策**:決定並測 `git-graph.*` 命名空間策略(改名或明文不支援並存),記入 §6.3。

> 規劃階段已實測:git-graph-plus 獨立 `npm install`(root + webview-ui)+ `npm run build` exit 0(約 2.8s)。環境可建——但**那是它當 root 時**,收編成子目錄後 §6.1/§6.2 的 entry 與資產路徑仍須 spike 1/2 重驗。

其他風險:
- 上游 `package.json` contributes 變動 → 手動再合併(僅此一檔)。
- Svelte 元件行號漂移 → 接縫用就近錨點字串定位,不靠絕對行號。
- 兩套 node_modules(root + webview-ui + graph)→ install 較慢、體積較大。
- **subtree 衝突面非「極小」保證**:MainPanel switch、message-bus 型別、Svelte 右鍵、build config、package contributes 都可能與上游衝突。對策:建 **vendored patch ledger**(每個 hook 的 anchor / 意圖 / 重貼步驟 / pull 後必跑 smoke),不把「處數少」當維護成本結論。

## 8. 測試

- **純邏輯(node:test)**:`graphCopy` 的「status→標籤(含 A/M/D/R/C)、deleted→marker、normalized payload 組裝、size guard、formatter=git 分支」用 fake repo/gitService 注入測。既有 45 測試不得退。
- **整合(Extension Development Host + packaged)**:開圖、commit 右鍵複製全 commit、檔案右鍵複製選取檔(含多選)、deleted/rename、未載 commit、格式與既有 git 複製一致。
- **subtree 接縫**:`git diff` 對 `graph/` 的改動全帶 `SNIPCODE-HOOK` 標記;patch ledger 與實際 diff 對得上。

## 9. 驗收標準

1. 既有 Snipcode 功能(SCM 複製、History 樹、還原)全部照舊、45 測試綠。
2. 線圖入口命令(`git-graph.view` 或重命名後)能開出 git-graph-plus 線圖,**packaged 後資產正常載入**。
3. 線圖 commit 右鍵「Copy Full Source」→ 複製該 commit 全部變更檔(含未預載情境);檔案右鍵 → 複製選取檔(含多選)。
4. 複製內容與既有 SCM **git 複製分支**、IntelliJ **格式一致**(標頭 + 標籤含 R/C + deleted marker)。
5. 對 `graph/` 的修改全部標記;patch ledger 與 `subtree pull` 流程文件化。
6. 擴充能 clean build + `vsce package` + 經 CI 發布(版本 bump,例如 0.3.0)。
7. lifecycle:reload/disable-enable 不殘留 duplicate command 或洩漏資源。

## 10. 非目標(YAGNI)

- 不回 PR 上游。
- 不重寫線圖、不改 git-graph-plus 既有行為(僅加標記接縫)。
- filters/進階設定第一版沿用既有開關,不為線圖另設。
- 跨 commit 去重(單 commit 複製即可;日後需要再加)。
