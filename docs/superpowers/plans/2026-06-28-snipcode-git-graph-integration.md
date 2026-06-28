# Snipcode × git-graph-plus 線圖整合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一個 Snipcode 擴充內收編 git-graph-plus 的 commit 線圖,並在 commit / 變更檔右鍵加「Copy Full Source」,用既有複製格式複製該 commit 的檔案內容。

**Architecture:** git-graph-plus 以 git subtree 放進 `graph/`(近乎原封,改動全標 `/* SNIPCODE-HOOK */`)。host 端 `src/extension.ts` 在既有註冊後呼叫 vendored 導出的 `activateGraph(context, { assetRootUri, copyFullSourceAtCommit })`;複製實邏輯全在自有檔 `src/graphCopy.ts`,vendored 只透過注入的 callback 轉呼叫。build 改 esbuild + Svelte,`main = ./dist/extension.js` 為唯一入口。

**Tech Stack:** TypeScript、VSCode Extension API、esbuild、Svelte(vendored webview)、node:test、git subtree、vsce。

**權威 spec:** `docs/superpowers/specs/2026-06-28-snipcode-git-graph-integration-design.md`(v2.1,Codex 兩輪複查通過)。本 plan 的每個 contract 以 spec 為準,衝突時回報。

## Global Constraints

- **同一擴充**:`publisher=audichuang`、`id=clipcode-vscode`、`displayName=Snipcode`。不另發第二個。
- **既有指令 id `clipcode.*` 不得改**(破壞使用者設定/快捷鍵)。
- **既有 45 個測試全程不得退**;既有功能(SCM 複製、History 樹、貼上還原)行為不變。
- **vendored `graph/` 只加不改**,每處改動用唯一標記 `/* SNIPCODE-HOOK */` 框住,並登錄到 patch ledger。
- **複製格式**:線圖複製固定走 `buildGitPayload`(對齊 SCM 的 git 分支,不走 regular spacing),逐位元組與既有 git 複製、IntelliJ 一致。
- **engine**:`^1.108.0`(現況已是)。
- **唯一 build 入口**:`package.json` `main = ./dist/extension.js`。
- **git 規矩**:先開分支/worktree,不直接 commit `main`;只在使用者要求時 push;commit 訊息結尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **HARD GATE**:Task 1 spike 前 5 項任一失敗 → 停下、回報、改 spec / 重評,不預設退路。

---

### Task 1: 垂直切片 spike(HARD GATE — 過了才做複製功能)

對應 spec §7 的 6 條。目的:在寫複製功能前,證明「subtree 收編 → 合併 build → 從 Snipcode 開圖 → 訊息往返 → 注入 handler」這條垂直切片可行,並把所有 `[Verify in spike]` 未知拍板。**本 task 用 dummy handler(回 "ok"),不做真複製。**

**Files:**
- Create: `graph/`(git subtree of github.com/the0807/git-graph-plus)
- Create: `esbuild.config.mjs`(host bundle)
- Create: `docs/superpowers/spike-report-git-graph.md`(spike 結果 + patch ledger seed)
- Create: `docs/superpowers/patch-ledger.md`(vendored 接縫登錄表)
- Modify: `package.json`(`main`、scripts、合併 graph 的 view/command contributes)
- Modify: `src/extension.ts`(呼叫 `activateGraph`)
- Modify: `.vscodeignore`(確保 webview assets 不被排除)
- Modify(vendored,標記): `graph/src/extension.ts`(導出 `activateGraph`)、`graph/src/utils/message-bus.ts`(S1 dummy 型別)、`graph/src/panels/MainPanel.ts`(S2 dummy case)、`graph/webview-ui/src/components/.../*.svelte`(一個 dummy 選單項)

**Interfaces:**
- Produces(後續 task 依賴):
  - vendored 導出 `export function activateGraph(context: vscode.ExtensionContext, opts: { assetRootUri: vscode.Uri; copyFullSourceAtCommit: (payload: GraphCopyPayload) => Promise<void> }): void`
  - patch ledger:S1–S5 各接縫的「檔案 + 錨點字串 + 意圖」(Task 3/4/5 據此定位)
  - spike report:webview assets 最終落點、graph webview build 指令、`git-graph.*` namespace 決策、vendored activate 註冊清單

- [ ] **Step 1: 確認在隔離 worktree / 分支上**

Run: `git rev-parse --abbrev-ref HEAD && git rev-parse --show-toplevel`
Expected: 分支非 `main`(例 `feat/git-graph-integration`),toplevel = 本 repo。若在 `main`,先 `git switch -c feat/git-graph-integration`。

- [ ] **Step 2: git subtree add 收編 git-graph-plus**

```bash
git subtree add --prefix graph https://github.com/the0807/git-graph-plus.git main --squash
```
Expected: `graph/` 出現,內含 `src/`、`webview-ui/`、`package.json` 等。記錄收編的 commit/ref 到 spike report。
若 LICENSE/NOTICE:在 repo 根新增 NOTICE 標註「graph/ vendored from the0807/git-graph-plus (Apache-2.0), modified」。

- [ ] **Step 3: 實測 vendored 獨立 build,並記錄資產落點**

```bash
( cd graph && npm install && ( cd webview-ui && npm install ) && npm run build ) > /tmp/spike-graph-build.txt 2>&1; echo "exit=$?"
```
Read `/tmp/spike-graph-build.txt`。Expected: exit 0。
**記錄到 spike report**:webview Svelte 產物實際路徑(例 `graph/webview-ui/dist` 或 `graph/dist`)、build 指令、它建立 webview 時 `localResourceRoots` / `asWebviewUri` 的寫法(讀 `graph/src/panels/*.ts`)。這是 §6.2 asset root 接法的依據。

- [ ] **Step 4: 讀 vendored activate,設計 `activateGraph` 接縫(S5)**

讀 `graph/src/extension.ts` 的 `activate`,列出它註冊的 commands / 建立的 webview/watcher / 任何 module-level 狀態到 spike report。
在 `graph/src/extension.ts` 加(標記):
```ts
/* SNIPCODE-HOOK start: host-facing activate adapter */
export function activateGraph(context: vscode.ExtensionContext, opts: {
  assetRootUri: vscode.Uri;
  copyFullSourceAtCommit: (payload: import('...').GraphCopyPayload) => Promise<void>;
}): void {
  // 1. 把 opts.copyFullSourceAtCommit 存到 MainPanel 可取得處(module 變數或傳入建構子)
  // 2. 呼叫原 activate 的註冊邏輯,但 webview asset base 改用 opts.assetRootUri
  // 3. 確保所有 disposable 都 push 進 context.subscriptions
}
/* SNIPCODE-HOOK end */
```
（實作細節依 Step 4 讀到的 vendored 結構;`GraphCopyPayload` 型別在 Task 2 定義,spike 階段可先用 `any` 並標 TODO。）

- [ ] **Step 5: 加 dummy 訊息往返(S1 + S2 + 一個 Svelte 選單項)**

- S1 `graph/src/utils/message-bus.ts`:加型別(標記)`{ type: 'snipcodeCopyFullSource'; payload: any }`。
- S2 `graph/src/panels/MainPanel.ts` handleMessage switch:加(標記)`case 'snipcodeCopyFullSource': await opts.copyFullSourceAtCommit(message.payload); return;`(spike 階段 `copyFullSourceAtCommit` 注入一個回 "ok" + `vscode.window.showInformationMessage('snipcode dummy ok')` 的 stub)。
- 任一 Svelte 右鍵元件(`CommitGraph.svelte` 或 `CommitDetails.svelte`):加一個 dummy 選單項 post `{type:'snipcodeCopyFullSource', payload:{hash:'x',files:[]}}`(標記)。
- 每處登錄到 `docs/superpowers/patch-ledger.md`(檔案 + 錨點字串 + 意圖)。

- [ ] **Step 6: 合併 build(esbuild host bundle + package.json)**

Create `esbuild.config.mjs`:打包 `src/extension.ts` → `dist/extension.js`(`platform:node`、`format:cjs`、`external:['vscode']`、`bundle:true`)。
Modify `package.json`:
- `main` → `./dist/extension.js`
- scripts:`"build": "<建 graph webview 指令(Step 3 記錄的)> && node esbuild.config.mjs"`;保留 `"compile": "tsc -p ./"`(供 node:test 出 `out/`);`"package": "vsce package"`;`test` 維持既有。
- contributes:把 graph 的 view container / view / `git-graph.view` 命令 + activationEvents **一次性合併**進來(menus 之後 Task 4/5 不需要,因右鍵在 webview 內)。
Modify `.vscodeignore`:確保 `dist/**`(含 webview assets 落點)不被排除;`node_modules/**` 維持排除(故 host deps 須 bundle)。
Modify `src/extension.ts` `activate()` 末端:
```ts
const assetRootUri = vscode.Uri.joinPath(context.extensionUri, /* Step 3 記錄的 webview 落點 */);
activateGraph(context, { assetRootUri, copyFullSourceAtCommit: async () => { vscode.window.showInformationMessage('snipcode dummy ok'); } });
```

- [ ] **Step 7: 驗收 6 條 spike(逐項記錄到 spike report)**

1. clean build + package:
```bash
rm -rf node_modules graph/node_modules graph/webview-ui/node_modules dist
npm ci && npm run build > /tmp/spike-build.txt 2>&1; echo "build exit=$?"
npx vsce package > /tmp/spike-package.txt 2>&1; echo "package exit=$?"
```
Read 兩檔。Expected: 都 exit 0;`.vsix` 內 `package.json.main` 指向 `dist/extension.js`(`unzip -p *.vsix extension/package.json | grep '"main"'`)。
2. **packaged 開圖 + 資產實載**:F5(或安裝 `.vsix`)開 Extension Dev Host,執行 `git-graph.view`,線圖開出、webview JS/CSS 從 `assetRootUri` 載入、**無 CSP/404**(看 webview DevTools console)。
3. **lifecycle**:reload window + disable/enable 擴充各一輪,無 duplicate command 報錯、無殘留資源。
4. **訊息往返 + handler 注入 + 未載清單**:點 dummy 選單項,看到 `snipcode dummy ok`,且確認走的是注入的 `opts.copyFullSourceAtCommit`(非隱式 import);確認 commit files 未預載時也能取得(Step 8 細查 store 流程)。
5. **payload parity dry-run**:留待 Task 2/3,spike 此項僅確認能從 webview 取到 `{hash, files:[{path,status,...}]}` 形狀(讀 vendored `showCommitFiles`/diff 回傳,記錄真實 field 名與 path 是 relative/absolute、status enum 到 spike report — 這決定 Task 2 normalized payload 對映)。
6. **namespace 決策**:決定 `git-graph.*` 是否改 `clipcode.gitGraph.*`(建議改,避免與 standalone 並存撞 id)或明文不支援並存。記錄決策。

- [ ] **Step 8: 補查 lazy-load 與 commit file shape(給 Task 4/5）**

讀 `graph/webview-ui/src/components/commit/CommitDetails.svelte`、`graph/webview-ui/src/components/graph/CommitGraph.svelte`、相關 store / message-bus,記錄到 spike report:
- commit 變更檔在 webview 端是否已載 / 如何 lazy load(用哪個 message 觸發、結果存哪個 store)。
- 檔案物件真實 shape(`path` 是 repo-relative 還是絕對?有無 `oldPath`?`status` 是 'A/M/D/R100' 還是其他?)。
- 多選機制(`selectedPatchFiles`?)。

- [ ] **Step 9: 寫 spike report + 提交**

把 Step 3–8 所有記錄寫進 `docs/superpowers/spike-report-git-graph.md`(含 6 條結果、namespace 決策、asset 落點、lazy-load 流程、file shape、vendored activate 清單)。patch ledger 補齊 dummy 接縫。
**GATE**:前 5 條任一失敗 → 在 report 標 BLOCKED 並停止,回報使用者。全綠才繼續。

```bash
git add -A
git commit -m "spike: vendor git-graph-plus via subtree, merge build, prove activate+message roundtrip

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `graphCopy.ts` 複製純邏輯 + status 對應擴充(TDD)

我們自有的檔,完全可單測(注入 fake repo)。與 vendored 無關,可獨立完成。

**Files:**
- Create: `src/graphCopy.ts`
- Test: `test/graphCopy.test.js`
- Modify: `src/gitCopy.ts:5-32`(擴 status 對應認 porcelain 單字母)
- Test: `test/gitCopy.test.js`(既有檔追加;若無則 create)

**Interfaces:**
- Consumes:`buildGitPayload`、`PayloadFile`(`src/clipboardFormat.ts`);`mapGitStatusToChangeType`、`DELETED_FILE_MARKER`(`src/gitCopy.ts`);`readRefContent`、`ContentRepo`、`normalizeFsPath`(`src/gitContent.ts`)
- Produces(Task 3 依賴):
  - `interface GraphCopyFile { repoRootFsPath: string; relativePath: string; oldRelativePath?: string; status: string }`
  - `interface GraphCopyPayload { hash: string; files: GraphCopyFile[] }`
  - `interface GraphCopySettings { headerFormat; preText; postText: string; addExtraLineBetweenFiles: boolean; maxFileSizeKB: number; fileCountLimit: number; setMaxFileCount: boolean }`
  - `interface GraphCopyDeps { resolveRepo(repoRootFsPath: string): ContentRepo | undefined; settings: GraphCopySettings }`
  - `interface GraphCopyResult { text: string; copiedFileCount: number; skippedFileSizeCount: number; fileLimitReached: boolean; missingRepoCount: number }`
  - `async function buildGraphCopyPayload(deps: GraphCopyDeps, payload: GraphCopyPayload): Promise<GraphCopyResult>`

- [ ] **Step 1: 寫 gitCopy 單字母對應的失敗測試**

`test/gitCopy.test.js` 追加(用 node:test):
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGitStatusToChangeType } from '../out/src/gitCopy.js';

test('mapGitStatusToChangeType maps porcelain single letters', () => {
  assert.equal(mapGitStatusToChangeType('A'), 'NEW');
  assert.equal(mapGitStatusToChangeType('M'), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType('D'), 'DELETED');
  assert.equal(mapGitStatusToChangeType('R'), 'MOVED');
  assert.equal(mapGitStatusToChangeType('C'), 'NEW');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run compile && node --test out/test/gitCopy.test.js > /tmp/t.txt 2>&1; echo exit=$?` 然後 Read `/tmp/t.txt`
Expected: FAIL(`'R'` → 'MODIFIED' 不符 'MOVED')。

- [ ] **Step 3: 擴 gitCopy 的 name sets**

`src/gitCopy.ts`:在對應的 `Set` 各加單字母(porcelain `--name-status` 碼)。
```ts
const NEW_STATUS_NAMES = new Set([
  'INDEX_ADDED','INDEX_COPIED','UNTRACKED','INTENT_TO_ADD','ADDED','COPIED','NEW',
  'A','C'
]);
const DELETED_STATUS_NAMES = new Set([
  'INDEX_DELETED','DELETED','DELETED_BY_US','DELETED_BY_THEM','BOTH_DELETED',
  'D'
]);
const MOVED_STATUS_NAMES = new Set([
  'INDEX_RENAMED','INTENT_TO_RENAME','RENAMED','MOVED',
  'R'
]);
```
（`'M'` 不必加,default 即 MODIFIED。)

- [ ] **Step 4: 跑測試確認通過**

Run: `npm run compile && node --test out/test/gitCopy.test.js > /tmp/t.txt 2>&1; echo exit=$?` 然後 Read `/tmp/t.txt`
Expected: PASS。

- [ ] **Step 5: 寫 graphCopy 的失敗測試**

`test/graphCopy.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphCopyPayload } from '../out/src/graphCopy.js';

const settings = {
  headerFormat: '// file: $FILE_PATH', preText: '', postText: '',
  addExtraLineBetweenFiles: true, maxFileSizeKB: 500, fileCountLimit: 30, setMaxFileCount: false
};
function fakeRepo(root, contentByPath) {
  return { rootUri: { fsPath: root }, show: async (_ref, p) => contentByPath[p.replaceAll('\\','/')] };
}
const deps = (repo) => ({ resolveRepo: (root) => (root === '/repo' ? repo : undefined), settings });

test('modified file reads content at commit', async () => {
  const repo = fakeRepo('/repo', { 'a.ts': 'hello' });
  const r = await buildGraphCopyPayload(deps(repo), { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'a.ts', status: 'M' }] });
  assert.equal(r.copiedFileCount, 1);
  assert.match(r.text, /\/\/ file: \[MODIFIED\] a\.ts/);
  assert.match(r.text, /hello/);
});

test('deleted file uses marker without reading', async () => {
  const repo = fakeRepo('/repo', {});
  const r = await buildGraphCopyPayload(deps(repo), { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'gone.ts', status: 'D' }] });
  assert.match(r.text, /\[DELETED\] gone\.ts/);
  assert.match(r.text, /This file has been deleted/);
});

test('rename status R100 maps to MOVED label', async () => {
  const repo = fakeRepo('/repo', { 'new.ts': 'x' });
  const r = await buildGraphCopyPayload(deps(repo), { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'new.ts', oldRelativePath: 'old.ts', status: 'R100' }] });
  assert.match(r.text, /\[MOVED\] new\.ts/);
});

test('missing repo is counted, not crashed', async () => {
  const repo = fakeRepo('/repo', {});
  const r = await buildGraphCopyPayload(deps(repo), { hash: 'abc', files: [{ repoRootFsPath: '/other', relativePath: 'a.ts', status: 'M' }] });
  assert.equal(r.missingRepoCount, 1);
  assert.equal(r.copiedFileCount, 0);
});

test('oversize file is skipped with reason', async () => {
  const big = 'x'.repeat(2 * 1024);
  const repo = fakeRepo('/repo', { 'b.ts': big });
  const small = { ...settings, maxFileSizeKB: 1 };
  const d = { resolveRepo: () => repo, settings: small };
  const r = await buildGraphCopyPayload(d, { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'b.ts', status: 'M' }] });
  assert.equal(r.skippedFileSizeCount, 1);
  assert.match(r.text, /File skipped: size exceeds limit/);
});

test('binary/unreadable (undefined content) is skipped silently', async () => {
  const repo = { rootUri: { fsPath: '/repo' }, show: async () => undefined };
  const r = await buildGraphCopyPayload({ resolveRepo: () => repo, settings }, { hash: 'abc', files: [{ repoRootFsPath: '/repo', relativePath: 'img.png', status: 'M' }] });
  assert.equal(r.copiedFileCount, 0);
  assert.equal(r.skippedFileSizeCount, 0);
});
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `npm run compile > /tmp/t.txt 2>&1; echo exit=$?` 然後 Read `/tmp/t.txt`
Expected: 編譯失敗(`graphCopy.ts` 不存在)。

- [ ] **Step 7: 實作 `src/graphCopy.ts`**

```ts
import type { PayloadFile } from './clipboardFormat.js';
import { buildGitPayload } from './clipboardFormat.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';
import { readRefContent, type ContentRepo } from './gitContent.js';

export interface GraphCopyFile {
  repoRootFsPath: string;
  relativePath: string;
  oldRelativePath?: string;
  status: string; // canonical 'A'|'M'|'D'|'R'|'C' per spec §5.0;容忍 'R100'/'C75'
}

export interface GraphCopyPayload {
  hash: string;
  files: GraphCopyFile[];
}

export interface GraphCopySettings {
  headerFormat: string;
  preText: string;
  postText: string;
  addExtraLineBetweenFiles: boolean;
  maxFileSizeKB: number;
  fileCountLimit: number;
  setMaxFileCount: boolean;
}

export interface GraphCopyDeps {
  resolveRepo(repoRootFsPath: string): ContentRepo | undefined;
  settings: GraphCopySettings;
}

export interface GraphCopyResult {
  text: string;
  copiedFileCount: number;
  skippedFileSizeCount: number;
  fileLimitReached: boolean;
  missingRepoCount: number;
}

function joinFsPath(root: string, relativePath: string): string {
  return `${root.replace(/[/\\]+$/, '')}/${relativePath}`;
}

export async function buildGraphCopyPayload(
  deps: GraphCopyDeps,
  payload: GraphCopyPayload
): Promise<GraphCopyResult> {
  const { settings } = deps;
  const files: PayloadFile[] = [];
  let copiedFileCount = 0;
  let skippedFileSizeCount = 0;
  let missingRepoCount = 0;
  let fileLimitReached = false;

  for (const file of payload.files) {
    if (settings.setMaxFileCount && copiedFileCount >= settings.fileCountLimit) {
      fileLimitReached = true;
      break;
    }

    // §5.0:R/C 帶相似度時截到字首後再對應
    const changeType = mapGitStatusToChangeType(file.status.trim().charAt(0).toUpperCase());
    const clipboardPath = file.relativePath;

    if (changeType === 'DELETED') {
      files.push({ path: clipboardPath, content: DELETED_FILE_MARKER, changeType });
      copiedFileCount++;
      continue;
    }

    const repo = deps.resolveRepo(file.repoRootFsPath);
    if (!repo) {
      missingRepoCount++;
      continue;
    }

    const absolutePath = joinFsPath(file.repoRootFsPath, file.relativePath);
    const content = await readRefContent(repo, payload.hash, absolutePath);
    if (content === undefined) continue; // 二進位/讀取失敗 → 跳過

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedFileSizeCount++;
      files.push({ path: clipboardPath, changeType, skippedReason: `size exceeds limit (${size} bytes)` });
      continue;
    }

    files.push({ path: clipboardPath, content, changeType });
    copiedFileCount++;
  }

  const text = buildGitPayload({
    headerFormat: settings.headerFormat,
    preText: settings.preText,
    postText: settings.postText,
    addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles,
    files
  });

  return { text, copiedFileCount, skippedFileSizeCount, fileLimitReached, missingRepoCount };
}
```

- [ ] **Step 8: 跑全部測試確認通過(含既有 45)**

Run: `npm run compile && node --test out/test/*.test.js > /tmp/t.txt 2>&1; echo exit=$?` 然後 Read `/tmp/t.txt`
Expected: 全 PASS,既有 45 + 新增不退。

- [ ] **Step 9: Commit**

```bash
git add src/graphCopy.ts src/gitCopy.ts test/graphCopy.test.js test/gitCopy.test.js
git commit -m "feat: add graphCopy pure logic and porcelain status mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: host 端串接真 handler(取代 dummy)+ S1/S2 型別定案

把 Task 1 的 dummy handler 換成真的 `copyFullSourceAtCommit`,並把 S1 訊息型別、S2 case 定案為傳真 payload。

**Files:**
- Modify: `src/extension.ts`(新增 `copyFullSourceAtCommit` + `makeGraphCopyDeps`,改 `activateGraph` 呼叫)
- Modify(vendored,標記): `graph/src/utils/message-bus.ts`(S1 型別由 `any` 改 `GraphCopyPayload` 對映)、`graph/src/panels/MainPanel.ts`(S2 case 確認轉呼叫)
- Modify: `docs/superpowers/patch-ledger.md`

**Interfaces:**
- Consumes:`buildGraphCopyPayload`、`GraphCopyPayload`、`GraphCopyDeps`(Task 2);`getGitApi`、`readSettings`、`GitAPI`(`src/extension.ts` 既有);`normalizeFsPath`(`src/gitContent.ts`)
- Produces:`copyFullSourceAtCommit(payload: GraphCopyPayload): Promise<void>`(注入給 `activateGraph`);**`activate()` 回傳 `{ copyFullSourceAtCommit }`**(VSCode 擴充 API exports)供 Task 7 E2E 直接呼叫測試

- [ ] **Step 1: 在 `src/extension.ts` 實作 deps 工廠 + handler**

```ts
import { buildGraphCopyPayload, type GraphCopyDeps, type GraphCopyPayload } from './graphCopy.js';
import { normalizeFsPath, type ContentRepo } from './gitContent.js';

function makeGraphCopyDeps(api: GitAPI, settings: ClipCodeSettings): GraphCopyDeps {
  return {
    resolveRepo(repoRootFsPath: string): ContentRepo | undefined {
      const target = normalizeFsPath(repoRootFsPath);
      return api.repositories.find(r => normalizeFsPath(r.rootUri.fsPath) === target) as unknown as ContentRepo | undefined;
    },
    settings
  };
}

async function copyFullSourceAtCommit(payload: GraphCopyPayload): Promise<void> {
  const api = await getGitApi();
  if (!api || api.repositories.length === 0) {
    vscode.window.showWarningMessage('No Git repositories found.');
    return;
  }
  const settings = readSettings();
  const result = await buildGraphCopyPayload(makeGraphCopyDeps(api, settings), payload);
  if (result.copiedFileCount === 0 && result.skippedFileSizeCount === 0) {
    vscode.window.showWarningMessage('No source copied for this commit.');
    return;
  }
  await vscode.env.clipboard.writeText(result.text);
  if (settings.showCopyNotification) {
    const skipped = result.skippedFileSizeCount > 0 ? ` (${result.skippedFileSizeCount} skipped: size exceeded)` : '';
    const limit = result.fileLimitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
    vscode.window.showInformationMessage(`${result.copiedFileCount} file(s) copied${skipped}.${limit}`);
  }
}
```

- [ ] **Step 2: 改 `activateGraph` 呼叫傳入真 handler + 回傳 API**

`src/extension.ts` `activate()` 內(取代 Task 1 的 dummy),並讓 `activate` 回傳 API 供 E2E:
```ts
const assetRootUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'graph-webview');
activateGraph(context, { assetRootUri, copyFullSourceAtCommit });
return { copyFullSourceAtCommit }; // VSCode exports — Task 7 E2E 取此 API 直接測端到端複製
```

- [ ] **Step 3: 定案 S1 型別**

`graph/src/utils/message-bus.ts`(標記內):把 dummy `payload: any` 改成對映 `GraphCopyPayload`(欄位 `hash: string; files: { repoRootFsPath; relativePath; oldRelativePath?; status }[]`)。若 vendored 不便 import host 型別,就在標記區重宣告等價 inline 型別(註明同 `src/graphCopy.ts` 的 `GraphCopyPayload`)。更新 patch ledger。

- [ ] **Step 4: 確認 S2 轉呼叫**

`graph/src/panels/MainPanel.ts`(標記內)case 不變:`await opts.copyFullSourceAtCommit(message.payload); return;`。確認 `opts.copyFullSourceAtCommit` 在 Task 1 的 `activateGraph` 裡有正確存取到。

- [ ] **Step 5: build + 既有測試回歸**

Run: `npm run build > /tmp/b.txt 2>&1; echo build=$?; npm run compile && node --test out/test/*.test.js > /tmp/t.txt 2>&1; echo test=$?` 然後 Read 兩檔
Expected: build exit 0;測試全 PASS(45 + Task 2 新增)。

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts graph/src/utils/message-bus.ts graph/src/panels/MainPanel.ts docs/superpowers/patch-ledger.md
git commit -m "feat: wire real copyFullSourceAtCommit handler into graph webview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: S3 — 變更檔右鍵「Copy Full Source」(含多選)

在 `CommitDetails.svelte` 加右鍵選單項,post 選取檔的 normalized payload。依 spike report Step 8 記錄的 file shape / 多選機制實作。

**Files:**
- Modify(vendored,標記): `graph/webview-ui/src/components/commit/CommitDetails.svelte`
- Modify: `docs/superpowers/patch-ledger.md`

**Interfaces:**
- Consumes:webview 端既有的「該 commit 已載入的變更檔清單」與選取狀態(`selectedPatchFiles` 或等價,spike report 記錄);post 訊息 `{ type:'snipcodeCopyFullSource', payload: GraphCopyPayload }`(Task 3 定案)
- Produces:無(末端 UI)

- [ ] **Step 1: 讀現況 + 定位錨點**

讀 `graph/webview-ui/src/components/commit/CommitDetails.svelte`,找既有檔案右鍵選單(context menu items 的陣列/區塊)與「目前選取檔」來源(spike report Step 8)。錨點用就近字串,不靠行號。

- [ ] **Step 2: 加「Copy Full Source」選單項(標記)**

在既有右鍵選單項陣列加一項(`/* SNIPCODE-HOOK */`):
- label: `Copy Full Source`
- onClick:組 payload —— `hash` = 目前 commit hash;`files` = 選取檔(多選用 `selectedPatchFiles`,單檔右鍵用 `[node]`)map 成 `{ repoRootFsPath, relativePath, oldRelativePath, status }`。
  - `repoRootFsPath`/`relativePath`/`status` 的取法依 spike report 記錄的 file 物件 shape;若 vendored 給的是 repo-relative path + 無 repoRoot,則 payload 帶 webview 已知的 repo root(spike 記錄其來源)。
- 然後 `postMessage({ type: 'snipcodeCopyFullSource', payload })`(用 vendored 既有的 message-bus post helper)。
- 登錄 patch ledger。

- [ ] **Step 3: build + 手動煙霧(Extension Dev Host)**

Run: `npm run build > /tmp/b.txt 2>&1; echo build=$?` 然後 Read。Expected: exit 0。
F5 開圖 → 選一個 commit → 變更檔清單右鍵單檔 → 「Copy Full Source」→ 貼到編輯器,確認:標頭 `// file: [MODIFIED] <path>` + 內容、格式與既有 SCM git 複製一致。再測多選、deleted、rename。記錄結果。

- [ ] **Step 4: Commit**

```bash
git add graph/webview-ui/src/components/commit/CommitDetails.svelte docs/superpowers/patch-ledger.md
git commit -m "feat: add Copy Full Source to commit file right-click (multi-select)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: S4 — commit 右鍵「Copy Full Source」(全變更檔 + lazy-load)

在 `CommitGraph.svelte` 的 commit 右鍵加選單項,複製該 commit 全部變更檔。**處理變更檔未預載**:依 spike report 的 lazy-load 流程,先 request diff、await store 更新,再 post。

**Files:**
- Modify(vendored,標記): `graph/webview-ui/src/components/graph/CommitGraph.svelte`(及必要時相關 store / message,允許 >1 處,全標記)
- Modify: `docs/superpowers/patch-ledger.md`

**Interfaces:**
- Consumes:commit 節點(hash);spike report 記錄的「載入該 commit 變更檔」message/store 流程;post `{ type:'snipcodeCopyFullSource', payload: GraphCopyPayload }`
- Produces:無

- [ ] **Step 1: 讀現況 + 定位錨點 + 確認 lazy-load 流程**

讀 `graph/webview-ui/src/components/graph/CommitGraph.svelte` 的 commit 右鍵選單,與 spike report Step 8 的 lazy-load 流程(哪個 message 載 diff、結果存哪個 store)。

- [ ] **Step 2: 加「Copy Full Source」選單項(標記)+ 未載序列**

選單項(`/* SNIPCODE-HOOK */`)onClick:
```
若該 commit 變更檔未載:
  post 既有的「載入 commit diff」message
  await store 更新到該 commit 的變更檔(用既有 store 訂閱/Promise 模式)
組 payload:hash = 該 commit;files = 全部變更檔 map 成 normalized GraphCopyFile(同 Task 4 的取法)
post({ type:'snipcodeCopyFullSource', payload })
```
若需要動到 store / message-bus 多處才能拿到「載完的通知」,接受之,全部標記並登錄 patch ledger。

- [ ] **Step 3: build + 手動煙霧**

Run: `npm run build > /tmp/b.txt 2>&1; echo build=$?` 然後 Read。Expected: exit 0。
F5 → 對一個**尚未點開**的 commit 直接右鍵 → 「Copy Full Source」→ 貼上,確認全變更檔都在、格式一致。再對已點開的 commit 測一次。

- [ ] **Step 4: Commit**

```bash
git add graph/webview-ui/src/components/graph/CommitGraph.svelte docs/superpowers/patch-ledger.md
git commit -m "feat: add Copy Full Source to commit right-click with lazy-load

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 收尾 — namespace 定案、patch ledger、回歸、版本 bump、打包

**Files:**
- Modify: `package.json`(namespace 決策落地 + version → `0.3.0`)
- Modify: `.vscodeignore`(確認最終資產與排除正確)
- Modify: `docs/superpowers/patch-ledger.md`(補 `subtree pull` 後必跑 smoke 清單)
- Modify: `README.md` / `CHANGELOG.md`(若存在,記新功能)
- Create/Modify: `NOTICE`(Apache-2.0 標註,若 Task 1 未補)

**Interfaces:** 無(收尾)

- [ ] **Step 1: namespace 決策落地**

依 spike report Step 7.6 決策:若改名,把 `package.json` 的 graph view/command id 從 `git-graph.*` 改 `clipcode.gitGraph.*`,並同步 vendored 呼叫處(標記)。既有 `clipcode.*` 不動。若決定不支援並存,在 README 註明即可。

- [ ] **Step 2: 全測試回歸**

Run: `npm run compile && node --test out/test/*.test.js > /tmp/t.txt 2>&1; echo exit=$?` 然後 Read `/tmp/t.txt`
Expected: 全 PASS,既有 45 不退。

- [ ] **Step 3: clean build + package 驗收**

```bash
rm -rf node_modules graph/node_modules graph/webview-ui/node_modules dist
npm ci && npm run build > /tmp/b.txt 2>&1; echo build=$?
npx vsce package > /tmp/p.txt 2>&1; echo package=$?
```
Read 兩檔。Expected: 都 exit 0;產出 `.vsix`。`unzip -p *.vsix extension/package.json | grep '"main"'` → `dist/extension.js`。

- [ ] **Step 4: patch ledger 收尾**

`docs/superpowers/patch-ledger.md` 確認列齊每個 `SNIPCODE-HOOK`(檔案 + 錨點 + 意圖 + 重貼步驟),並加「`git subtree pull` 後必跑 smoke」清單(build / package / 開圖 / 兩個右鍵複製)。
Run: `git -c grep.lineNumber=false grep -n "SNIPCODE-HOOK" -- graph > /tmp/hooks.txt 2>&1; cat /tmp/hooks.txt` 確認 ledger 與實際 diff 對得上。

- [ ] **Step 5: 版本 bump + Commit**

`package.json` `version` → `0.3.0`。
```bash
git add -A
git commit -m "chore: finalize git-graph integration, bump to 0.3.0

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: 發布(使用者確認後才推 tag)**

**等使用者明示**再:
```bash
git tag v0.3.0 && git push origin <branch> --tags
```
推 `v0.3.0` tag 觸發 `.github/workflows/publish.yml` 自動 `vsce publish`。用 `gh run list/view` 看狀態(輸出被 snip 截 → 抓 log 用 `gh api .../jobs/<jobId>/logs > file` 再 Read)。

---

### Task 7: 端到端整合測試(`@vscode/test-electron`,headless)

使用者新增需求:測試 + E2E 都要完成。VSCode 擴充的 E2E 用 `@vscode/test-electron` 在 headless(xvfb)跑真 Extension Host。**這同時自動化原本要手動 F5 的 HARD GATE runtime 驗證**(啟動、指令註冊、開圖、端到端複製)。執行順序:在 T3 之後即可跑「gate 子集」;完整套件在 T3–T5 後跑;**E2E 綠是 T6 bump 的前置**。環境已確認可行(xvfb-run/Xvfb 在、`DISPLAY=:0`、libnss3/libgtk-3 在、可連 update.code.visualstudio.com)。

**Files:**
- Create: `test-e2e/runTest.ts`(建臨時 git repo → `runTests({extensionDevelopmentPath, extensionTestsPath, launchArgs:[repoDir,'--no-sandbox','--disable-gpu']})`)
- Create: `test-e2e/suite/index.ts`(mocha 載入器,glob `*.test.js`)
- Create: `test-e2e/suite/integration.test.ts`(下列測試)
- Modify: `package.json`(devDeps:`@vscode/test-electron`、`mocha`、`glob`、`@types/mocha`;scripts:`compile:e2e`= 編 test-e2e→`out-e2e/`、`test:e2e`= `compile:e2e` 後 `node out-e2e/runTest.js`、`test:all`= `test` + `test:e2e`)
- Create: `tsconfig.e2e.json`(rootDir `test-e2e`、outDir `out-e2e`、module commonjs、含 `vscode` 型別)
- Modify: `.github/workflows/publish.yml`(發布前 `xvfb-run -a npm run test:e2e`)
- Modify: `.vscodeignore`(排除 `test-e2e/**`、`out-e2e/**`、`tsconfig.e2e.json`,別進 VSIX)

**Interfaces:**
- Consumes:`activate()` 回傳的 `{ copyFullSourceAtCommit }`(Task 3);`gitGraphPlus.open` 指令;VSCode Git API
- Produces:`test:e2e` / `test:all` script;CI E2E gate

**測試(`integration.test.ts`,mocha + node `assert`):**

- [ ] **Step 1: 裝 devDeps + 建 harness(runTest.ts / suite/index.ts / tsconfig.e2e.json)**;`runTest.ts` 在 launch 前用 `git init` 建臨時 repo(設 user.email/name),做 2 個 commit:commit A 新增 `a.ts`、`del.ts`、`old.ts`;commit B 改 `a.ts`、刪 `del.ts`、`old.ts`→`new.ts`(rename)、新增 `added.ts`。把 repo 路徑當 workspace 傳給 `launchArgs`。

- [ ] **Step 2: 測 activation + 指令註冊**

```ts
const ext = vscode.extensions.getExtension('audichuang.clipcode-vscode');
assert.ok(ext, 'extension present');
const api = await ext.activate();
assert.ok(ext.isActive);
const cmds = await vscode.commands.getCommands(true);
assert.ok(cmds.includes('gitGraphPlus.open'), 'graph view command registered');
assert.ok(cmds.includes('clipcode.copyGitChanges') || cmds.some(c => c.startsWith('clipcode.')), 'existing clipcode commands intact');
```

- [ ] **Step 3: 測開圖不拋錯**

```ts
await vscode.commands.executeCommand('gitGraphPlus.open'); // 不拋即可;webview CSP/404 headless 難斷,至少確認指令解析
```

- [ ] **Step 4: 端到端複製(最關鍵 — 走真 VSCode Git API + 真 `git show` + buildGitPayload)**

```ts
// 等 vscode.git 探到臨時 repo
const gitExt = vscode.extensions.getExtension('vscode.git'); const gitApi = (await gitExt.activate()).getAPI(1);
// poll 直到 repositories 出現該 repo;取 headCommit B 的 hash
const repo = await waitForRepo(gitApi, repoDir);
const hashB = (await repo.log({maxEntries:1}))[0].hash;
const payload = { hash: hashB, files: [
  { repoRootFsPath: repoDir, relativePath: 'a.ts', status: 'M' },
  { repoRootFsPath: repoDir, relativePath: 'del.ts', status: 'D' },
  { repoRootFsPath: repoDir, relativePath: 'new.ts', oldRelativePath: 'old.ts', status: 'R' },
  { repoRootFsPath: repoDir, relativePath: 'added.ts', status: 'A' },
]};
await api.copyFullSourceAtCommit(payload);
const clip = await vscode.env.clipboard.readText();
assert.match(clip, /\/\/ file: \[MODIFIED\] a\.ts/);
assert.match(clip, /\[DELETED\] del\.ts/); assert.match(clip, /This file has been deleted/);
assert.match(clip, /\[MOVED\] new\.ts/);
assert.match(clip, /\[NEW\] added\.ts/);
```

- [ ] **Step 5: 跑 headless 綠**

Run: `xvfb-run -a npm run test:e2e > /tmp/e2e.txt 2>&1; echo exit=$?` 然後 Read。Expected: mocha 全 pass。若 electron sandbox 報錯 → 確認 `--no-sandbox` 已在 launchArgs。**這是自動化的 HARD GATE:綠 = spike runtime gate 過。**

- [ ] **Step 6: Commit**(`test-e2e/`、`tsconfig.e2e.json`、`package.json`、`.vscodeignore`、CI;Co-Authored-By trailer)

**殘留手動煙霧(E2E 無法涵蓋,交付時告知使用者)**:webview 內右鍵選單的實際點擊(T4/T5 的 UI 互動,在 iframe webview 內,headless 難驅動)、syntax-highlight 的 shiki lazy chunk 在 CSP 下實載。其餘(啟動/指令/開圖/端到端複製/生命週期)已由 E2E 自動覆蓋。

---

## Self-Review

**Spec coverage:**
- §2 已定架構 → 全 task 遵循(Global Constraints + Task 1 subtree/build)。✅
- §4.0 activateGraph adapter(含 copyFullSourceAtCommit 注入) → Task 1 Step 4 + Task 3。✅
- §4.1 S1–S5 接縫 → S5/S1/S2 Task 1+3、S3 Task 4、S4 Task 5。✅
- §5.0 normalized payload + status 擴充 + formatter=buildGitPayload + VSCode Git API 讀取 → Task 2 + Task 3。✅
- §6.1 build entry single source → Task 1 Step 6 + Task 6 Step 3。✅
- §6.2 webview asset root → Task 1 Step 3/4/6 + spike 驗證。✅
- §6.3 manifest merge + namespace → Task 1 Step 6/7.6 + Task 6 Step 1。✅
- §7 6 條 spike → Task 1 Step 7。✅
- §8 測試(純邏輯 + 整合 + 接縫 diff) → Task 2 + Task 4/5 煙霧 + Task 6 Step 4。✅
- §9 驗收 1–7 → 散落各 task,Task 6 Step 2/3 收尾。✅
- §10 YAGNI(filters 沿用、不跨 commit 去重) → graphCopy 未加 filter/dedup,符合。✅

**Placeholder scan:** Task 2/3 為自有碼,程式碼完整。Task 1/4/5 的 vendored 部分刻意留「依 spike report 記錄定位」——因 vendored 真實 shape 須 subtree add 後才知(spec 已標 [Verify in spike]);spike report 即把未知轉成已知,非 placeholder。

**Type consistency:** `GraphCopyPayload`/`GraphCopyFile`/`GraphCopyDeps`/`GraphCopyResult`/`buildGraphCopyPayload` 在 Task 2 定義,Task 3 import 一致;`copyFullSourceAtCommit` 簽名 Task 1 stub → Task 3 實作 → 與 §4.0 `activateGraph` opts 型別一致。✅
