# ClipCode History 視圖 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VSCode port 補上對齊 IntelliJ 的「Git 歷史版本複製」——一個掛在 SCM 容器下的自製 TreeView,列 commit → 展開成資料夾樹 → 原生多選 → 右鍵複製選中檔在該 commit 的內容。

**Architecture:** 分純資料/聚合層(可單測、不依賴 vscode)與薄 UI 層(TreeDataProvider + view 註冊)。資料層用內建 Git API(`log`/`diffBetweenWithStats`/`show`),複製沿用既有 `buildGitPayload` + settings,確保三邊格式一致。

**Tech Stack:** TypeScript(Node16 module、ES2022 strict)、VSCode 內建 `vscode.git` extension API、`node:test` + `node:assert/strict`、`tsc` 編譯到 `out/`。

依據 spec:`docs/superpowers/specs/2026-06-28-vscode-git-history-view-design.md`
研究:`docs/research/2026-06-28-git-history-api-research.md`

## Global Constraints

- **`engines.vscode` = `^1.108.0`**;`devDependencies` 的 `@types/vscode` 一併釘 `^1.108.0`(`skip`/`diffBetweenWithStats` 的真實最低版)。
- **零第三方依賴、零自行 spawn git**;只用內建 Git API。
- **複製格式不重寫**:沿用 `src/clipboardFormat.ts`(`buildGitPayload`/`formatHeader`)、`src/gitCopy.ts`(`mapGitStatusToChangeType`/`DELETED_FILE_MARKER`)、`src/settings.ts`、`src/pathResolver.ts`(`toClipboardPathFromRoots`)、`src/filterMatcher.ts`。
- **EMPTY_TREE** = `'4b825dc642cb6eb9a060e54bf8d69288fbee4904'`(SHA-1 repo 的 empty tree;SHA-256 不處理)。
- **測試風格**:`import test from 'node:test'`、`import assert from 'node:assert/strict'`、import 來源用 `../src/X.js`(編譯後副檔名)。純邏輯以結構化 fake 注入,不載入 `vscode`。
- **資料/聚合層(`gitContent.ts`/`gitHistory.ts`/`historyTree.ts`)不得 `import vscode`**,改用本檔定義的結構化介面,讓真實 `vscode.git` 物件以結構化型別相容傳入、同時可單測。
- **每次 commit 訊息結尾**加一行:`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。執行前若在預設分支,先開 feature 分支。
- 驗證指令統一:`npm run compile`(tsc)、`npm test`(compile + `node --test out/test/*.test.js`,基線 31 passed)。

## File Structure

| 檔案 | 職責 | import vscode? |
|---|---|---|
| `src/gitContent.ts`(新,從 extension.ts 抽出) | 讀某 ref 的檔內容:`readRefContent`/`decodeText`/`isTextContent`/`repoRelativePath`/`normalizeFsPath` | 否 |
| `src/gitHistory.ts`(新) | 資料層:`listCommits`/`listCommitFiles`/`readFileAtCommit` + 結構化介面 | 否 |
| `src/historyTree.ts`(新) | 純聚合:節點型別、資料夾樹建構+單鏈壓縮、攤平、去重、命令參數解析 | 否 |
| `src/historyTreeProvider.ts`(新) | `TreeDataProvider`:lazy children + 快取、分頁、placeholder、`getFilesForNode` | 是 |
| `src/historyView.ts`(新) | 註冊 view/指令、repo 選擇+持久化、Git enabled 守衛、複製串接 | 是 |
| `src/extension.ts`(改) | activate 時建 provider/view、改用 `gitContent` | 是 |
| `package.json`(改) | view/commands/menus/activationEvents、engine + @types bump | — |

純模組(Tasks 1–3)走 TDD;UI 層(Tasks 4–6)以 `tsc` 編譯 + VSCode Extension Development Host(F5)手動煙霧測試驗收(無法在 `node:test` 載入 `vscode`)。

---

### Task 1: 抽出 `gitContent.ts`(重構,不改行為)

把 `extension.ts` 內讀 ref 內容的私有函式抽成共用模組,供既有 `copyGitChanges` 與新歷史視圖共用。

**Files:**
- Create: `src/gitContent.ts`
- Test: `test/gitContent.test.ts`
- Modify: `src/extension.ts`(移除被抽走的函式定義,改 import)

**Interfaces:**
- Produces:
  - `normalizeFsPath(value: string): string`
  - `repoRelativePath(repoRootFsPath: string, fileFsPath: string): string`
  - `decodeText(bytes: Uint8Array): string | undefined`
  - `isTextContent(content: string | undefined): content is string`
  - `interface ContentRepo { rootUri: { fsPath: string }; show?(ref: string, path: string): Promise<string>; buffer?(ref: string, path: string): Promise<Uint8Array>; }`
  - `readRefContent(repo: ContentRepo, ref: string, fileFsPath: string): Promise<string | undefined>`

- [ ] **Step 1: 寫失敗測試** `test/gitContent.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeText, isTextContent, normalizeFsPath, repoRelativePath, readRefContent } from '../src/gitContent.js';

test('decodeText decodes utf8 and rejects binary', () => {
  assert.equal(decodeText(new TextEncoder().encode('hello')), 'hello');
  assert.equal(decodeText(new Uint8Array([0x68, 0x00, 0x69])), undefined); // contains NUL
});

test('isTextContent guards undefined and NUL', () => {
  assert.equal(isTextContent('abc'), true);
  assert.equal(isTextContent(undefined), false);
  assert.equal(isTextContent('a\0b'), false);
});

test('repoRelativePath strips root and uses forward slashes', () => {
  assert.equal(repoRelativePath('/repo', '/repo/src/auth/login.ts'), 'src/auth/login.ts');
});

test('readRefContent tries show then buffer and skips binary', async () => {
  const repo = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => (p === 'src/a.ts' ? 'CONTENT' : Promise.reject(new Error('no'))),
  };
  assert.equal(await readRefContent(repo, 'abc123', '/repo/src/a.ts'), 'CONTENT');

  const bufRepo = {
    rootUri: { fsPath: '/repo' },
    show: async () => { throw new Error('no show'); },
    buffer: async () => new TextEncoder().encode('FROM_BUFFER'),
  };
  assert.equal(await readRefContent(bufRepo, 'abc123', '/repo/src/a.ts'), 'FROM_BUFFER');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run compile`
Expected: FAIL — `Cannot find module '../src/gitContent.js'` / 編譯錯誤。

- [ ] **Step 3: 建 `src/gitContent.ts`**（內容搬自 `extension.ts`,函式簽名改為接 `repoRootFsPath`/`fileFsPath` 字串,不依賴 `vscode`）

```ts
export interface ContentRepo {
  rootUri: { fsPath: string };
  show?: (ref: string, path: string) => Promise<string>;
  buffer?: (ref: string, path: string) => Promise<Uint8Array>;
}

export function normalizeFsPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function repoRelativePath(repoRootFsPath: string, fileFsPath: string): string {
  const relativePath = normalizeFsPath(fileFsPath).slice(normalizeFsPath(repoRootFsPath).length + 1);
  return relativePath.replaceAll('\\', '/');
}

export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function isTextContent(content: string | undefined): content is string {
  return content !== undefined && !content.includes('\0');
}

export async function readRefContent(
  repo: ContentRepo,
  ref: string,
  fileFsPath: string
): Promise<string | undefined> {
  const relative = repoRelativePath(repo.rootUri.fsPath, fileFsPath);
  const candidates = [...new Set([relative, fileFsPath].filter(Boolean))];

  for (const candidate of candidates) {
    if (repo.show) {
      const shown = await repo.show(ref, candidate).catch(() => undefined);
      if (isTextContent(shown)) return shown;
    }
    if (repo.buffer) {
      const bytes = await repo.buffer(ref, candidate).catch(() => undefined);
      const text = bytes ? decodeText(bytes) : undefined;
      if (isTextContent(text)) return text;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: 改 `extension.ts` 改用 `gitContent`**

- 在頂部加:`import { decodeText, isTextContent, normalizeFsPath, readRefContent } from './gitContent.js';`
- 刪除 `extension.ts` 內這些函式的本地定義:`normalizeFsPath`、`decodeText`、`isTextContent`、`repoRelativePath`、`readRepositoryContent`、`distinctStrings`。
- 把 `readRepositoryContent(repository, ref, uri)` 的呼叫點改為
  `readRefContent(repository, ref, uri.fsPath)`(`readGitChangeContent` 內兩處:DELETED 的 `change.originalUri ?? change.uri`、forceIndex 的 `change.uri`)。
  例:`return await readRefContent(repository, 'HEAD', (change.originalUri ?? change.uri).fsPath) ?? DELETED_FILE_MARKER;`
- `normalizeFsPath` 其餘呼叫點改用 import 來源(行為相同)。

- [ ] **Step 5: 跑測試確認通過 + 回歸**

Run: `npm test`
Expected: PASS — 既有 31 + 新增 4 個 gitContent 測試全綠。

- [ ] **Step 6: Commit**

```bash
git add src/gitContent.ts test/gitContent.test.ts src/extension.ts
git commit -m "refactor: extract ref-content reading into gitContent module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `gitHistory.ts` 資料層

**Files:**
- Create: `src/gitHistory.ts`
- Test: `test/gitHistory.test.ts`

**Interfaces:**
- Consumes: `gitContent.readRefContent`、`gitCopy.mapGitStatusToChangeType`、`gitCopy.DELETED_FILE_MARKER`。
- Produces:
  - `const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'`
  - `interface HistoryCommit { hash: string; message: string; parents: string[]; commitDate?: Date; authorName?: string; authorEmail?: string; }`
  - `interface HistoryChange { uri: { fsPath: string }; originalUri?: { fsPath: string }; renameUri?: { fsPath: string }; status: unknown; }`
  - `interface HistoryRepo extends ContentRepo { rootUri: { fsPath: string }; log(options: { maxEntries?: number; skip?: number }): Promise<HistoryCommit[]>; diffBetweenWithStats(ref1: string, ref2: string): Promise<HistoryChange[]>; }`
  - `listCommits(repo: HistoryRepo, opts: { limit: number; skip: number }): Promise<HistoryCommit[]>`
  - `listCommitFiles(repo: HistoryRepo, commit: HistoryCommit): Promise<HistoryChange[]>`
  - `readFileAtCommit(repo: HistoryRepo, hash: string, change: HistoryChange): Promise<string | undefined>`

- [ ] **Step 1: 寫失敗測試** `test/gitHistory.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_TREE, listCommitFiles, listCommits, readFileAtCommit } from '../src/gitHistory.js';

function fakeRepo(overrides: any = {}) {
  return {
    rootUri: { fsPath: '/repo' },
    calls: [] as any[],
    async log(options: any) { this.calls.push(['log', options]); return overrides.commits ?? []; },
    async diffBetweenWithStats(ref1: string, ref2: string) { this.calls.push(['diff', ref1, ref2]); return overrides.changes ?? []; },
    async show(_ref: string, _p: string) { return overrides.show ? overrides.show(_ref, _p) : undefined; },
    ...overrides.methods,
  };
}

test('listCommits forwards maxEntries and skip', async () => {
  const repo = fakeRepo();
  await listCommits(repo as any, { limit: 50, skip: 100 });
  assert.deepEqual(repo.calls[0], ['log', { maxEntries: 50, skip: 100 }]);
});

test('listCommitFiles uses parent[0] for normal commit', async () => {
  const repo = fakeRepo({ changes: [{ uri: { fsPath: '/repo/a.ts' }, status: 5 }] });
  await listCommitFiles(repo as any, { hash: 'H', message: 'm', parents: ['P'] });
  assert.deepEqual(repo.calls[0], ['diff', 'P', 'H']);
});

test('listCommitFiles uses EMPTY_TREE for root commit', async () => {
  const repo = fakeRepo();
  await listCommitFiles(repo as any, { hash: 'ROOT', message: 'init', parents: [] });
  assert.deepEqual(repo.calls[0], ['diff', EMPTY_TREE, 'ROOT']);
});

test('readFileAtCommit returns deleted marker for DELETED status', async () => {
  const repo = fakeRepo();
  const change = { uri: { fsPath: '/repo/gone.ts' }, status: 6 }; // 6 = DELETED
  const content = await readFileAtCommit(repo as any, 'H', change);
  assert.equal(content, '// This file has been deleted in this change');
});

test('readFileAtCommit reads content at the commit hash for non-deleted', async () => {
  const repo = fakeRepo({ show: (_ref: string, _p: string) => 'AT_COMMIT' });
  const change = { uri: { fsPath: '/repo/a.ts' }, status: 5 };
  assert.equal(await readFileAtCommit(repo as any, 'HASH', change), 'AT_COMMIT');
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run compile`
Expected: FAIL — `Cannot find module '../src/gitHistory.js'`。

- [ ] **Step 3: 建 `src/gitHistory.ts`**

```ts
import type { ContentRepo } from './gitContent.js';
import { readRefContent } from './gitContent.js';
import { DELETED_FILE_MARKER, mapGitStatusToChangeType } from './gitCopy.js';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface HistoryCommit {
  hash: string;
  message: string;
  parents: string[];
  commitDate?: Date;
  authorName?: string;
  authorEmail?: string;
}

export interface HistoryChange {
  uri: { fsPath: string };
  originalUri?: { fsPath: string };
  renameUri?: { fsPath: string };
  status: unknown;
}

export interface HistoryRepo extends ContentRepo {
  rootUri: { fsPath: string };
  log(options: { maxEntries?: number; skip?: number }): Promise<HistoryCommit[]>;
  diffBetweenWithStats(ref1: string, ref2: string): Promise<HistoryChange[]>;
}

export function listCommits(repo: HistoryRepo, opts: { limit: number; skip: number }): Promise<HistoryCommit[]> {
  return repo.log({ maxEntries: opts.limit, skip: opts.skip });
}

export function listCommitFiles(repo: HistoryRepo, commit: HistoryCommit): Promise<HistoryChange[]> {
  const ref1 = commit.parents[0] ?? EMPTY_TREE;
  return repo.diffBetweenWithStats(ref1, commit.hash);
}

export async function readFileAtCommit(
  repo: HistoryRepo,
  hash: string,
  change: HistoryChange
): Promise<string | undefined> {
  if (mapGitStatusToChangeType(change.status) === 'DELETED') {
    return DELETED_FILE_MARKER;
  }
  const target = (change.renameUri ?? change.uri).fsPath;
  return readRefContent(repo, hash, target);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS — 新增 5 個 gitHistory 測試全綠。

- [ ] **Step 5: Commit**

```bash
git add src/gitHistory.ts test/gitHistory.test.ts
git commit -m "feat: add git history data layer (listCommits/listCommitFiles/readFileAtCommit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `historyTree.ts` 純聚合層

節點型別 + 資料夾樹建構(單鏈壓縮)+ 攤平 + 跨 commit 同檔去重 + 命令參數解析。全部純函式、可單測。

**Files:**
- Create: `src/historyTree.ts`
- Test: `test/historyTree.test.ts`

**Interfaces:**
- Consumes: `gitHistory.HistoryCommit`、`gitHistory.HistoryChange`、`gitCopy.mapGitStatusToChangeType`、`clipboardFormat.ChangeTypeLabel`。
- Produces:
  - 節點型別:
    ```ts
    interface FileNode { kind: 'file'; repoRoot: string; commit: HistoryCommit; change: HistoryChange; relPath: string; name: string; changeType: ChangeTypeLabel; }
    interface FolderNode { kind: 'folder'; name: string; children: TreeNode[]; }
    type TreeNode = FolderNode | FileNode;
    ```
  - `buildCommitFileTree(repoRoot: string, commit: HistoryCommit, changes: HistoryChange[]): TreeNode[]` — 回傳該 commit 的頂層節點(資料夾單鏈壓縮)。
  - `collectFileNodes(node: TreeNode): FileNode[]` — 攤平子樹所有 FileNode。
  - `dedupeFilesKeepNewest(files: FileNode[]): FileNode[]` — 依 `relPath` 去重,留 `commit.commitDate` 較新者(無日期時留先出現者=清單較前=較新)。
  - `interface SourceNode { kind: 'commit' | 'folder' | 'file'; [k: string]: unknown; }`
  - `resolveSourceNodes<T>(clicked: T | undefined, selected: T[] | undefined, treeSelection: readonly T[]): T[]` — 取來源節點:`selected`(若含 `clicked`)→ `[clicked]` → `treeSelection`。

- [ ] **Step 1: 寫失敗測試** `test/historyTree.test.ts`

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommitFileTree, collectFileNodes, dedupeFilesKeepNewest, resolveSourceNodes } from '../src/historyTree.js';

const commit = (over: any = {}) => ({ hash: 'H', message: 'm', parents: ['P'], ...over });
const change = (p: string, status = 5) => ({ uri: { fsPath: `/repo/${p}` }, status });

test('buildCommitFileTree compresses single-child folder chains', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/auth/login.ts'), change('src/auth/session.ts')]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'folder');
  assert.equal((nodes[0] as any).name, 'src/auth'); // src→auth chain merged
  assert.equal((nodes[0] as any).children.length, 2);
});

test('buildCommitFileTree keeps branching folders separate', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/a.ts'), change('test/b.ts')]);
  const names = nodes.map((n: any) => n.name).sort();
  assert.deepEqual(names, ['src', 'test']);
});

test('collectFileNodes flattens a folder subtree', () => {
  const nodes = buildCommitFileTree('/repo', commit(), [change('src/auth/login.ts'), change('src/auth/session.ts')]);
  assert.equal(collectFileNodes(nodes[0]).length, 2);
});

test('dedupeFilesKeepNewest keeps the newer commitDate per path', () => {
  const older = buildCommitFileTree('/repo', commit({ hash: 'OLD', commitDate: new Date(1000) }), [change('a.ts')]);
  const newer = buildCommitFileTree('/repo', commit({ hash: 'NEW', commitDate: new Date(2000) }), [change('a.ts')]);
  const deduped = dedupeFilesKeepNewest([...collectFileNodes(older[0]), ...collectFileNodes(newer[0])]);
  assert.equal(deduped.length, 1);
  assert.equal((deduped[0] as any).commit.hash, 'NEW');
});

test('resolveSourceNodes precedence: selected-with-clicked, then clicked, then treeSelection', () => {
  assert.deepEqual(resolveSourceNodes('c', ['a', 'c'], ['z']), ['a', 'c']);
  assert.deepEqual(resolveSourceNodes('c', ['a', 'b'], ['z']), ['c']); // selected lacks clicked → clicked
  assert.deepEqual(resolveSourceNodes(undefined, undefined, ['z']), ['z']);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npm run compile`
Expected: FAIL — `Cannot find module '../src/historyTree.js'`。

- [ ] **Step 3: 建 `src/historyTree.ts`**

```ts
import type { ChangeTypeLabel } from './clipboardFormat.js';
import { mapGitStatusToChangeType } from './gitCopy.js';
import type { HistoryChange, HistoryCommit } from './gitHistory.js';

export interface FileNode {
  kind: 'file';
  repoRoot: string;
  commit: HistoryCommit;
  change: HistoryChange;
  relPath: string;
  name: string;
  changeType: ChangeTypeLabel;
}
export interface FolderNode {
  kind: 'folder';
  name: string;
  children: TreeNode[];
}
export type TreeNode = FolderNode | FileNode;

function relativeOf(repoRoot: string, change: HistoryChange): string {
  const abs = (change.renameUri ?? change.uri).fsPath.replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/');
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
}

export function buildCommitFileTree(repoRoot: string, commit: HistoryCommit, changes: HistoryChange[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', children: [] };

  for (const change of changes) {
    const relPath = relativeOf(repoRoot, change);
    const segments = relPath.split('/');
    const fileName = segments.pop() as string;
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.children.find((c): c is FolderNode => c.kind === 'folder' && c.name === seg);
      if (!next) {
        next = { kind: 'folder', name: seg, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      kind: 'file', repoRoot, commit, change, relPath, name: fileName,
      changeType: mapGitStatusToChangeType(change.status),
    });
  }

  return root.children.map(compress);
}

// 單鏈壓縮:資料夾只有單一子資料夾、且自己沒有直接檔案 → 合併名稱
function compress(node: TreeNode): TreeNode {
  if (node.kind === 'file') return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === 'folder') {
    const child = folder.children[0] as FolderNode;
    folder = { kind: 'folder', name: `${folder.name}/${child.name}`, children: child.children };
  }
  return { kind: 'folder', name: folder.name, children: folder.children.map(compress) };
}

export function collectFileNodes(node: TreeNode): FileNode[] {
  if (node.kind === 'file') return [node];
  return node.children.flatMap(collectFileNodes);
}

export function dedupeFilesKeepNewest(files: FileNode[]): FileNode[] {
  const byPath = new Map<string, FileNode>();
  for (const file of files) {
    const existing = byPath.get(file.relPath);
    if (!existing) { byPath.set(file.relPath, file); continue; }
    const a = file.commit.commitDate?.getTime() ?? Infinity;     // 無日期視為較新(清單較前)
    const b = existing.commit.commitDate?.getTime() ?? Infinity;
    if (a > b) byPath.set(file.relPath, file);
  }
  return [...byPath.values()];
}

export function resolveSourceNodes<T>(clicked: T | undefined, selected: T[] | undefined, treeSelection: readonly T[]): T[] {
  if (selected && clicked !== undefined && selected.includes(clicked)) return selected;
  if (clicked !== undefined) return [clicked];
  return [...treeSelection];
}
```

> 注意去重「較新」語義:`dedupeFilesKeepNewest` 用 `commitDate` 比較;測試中 OLD(1000)< NEW(2000) → 留 NEW。無 `commitDate` 時(`?? Infinity`)留先出現者,實務上 provider 以 log 新→舊順序餵入,故先出現=較新,與 spec 一致。

- [ ] **Step 4: 跑測試確認通過**

Run: `npm test`
Expected: PASS — 新增 5 個 historyTree 測試全綠。

- [ ] **Step 5: Commit**

```bash
git add src/historyTree.ts test/historyTree.test.ts
git commit -m "feat: add pure history tree aggregation (folder compression, dedupe, source resolution)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `historyTreeProvider.ts`(TreeDataProvider)

把資料層 + 聚合層包成 vscode `TreeDataProvider`。Lazy commit children + 快取、分頁 LoadMoreNode、loading/error placeholder、`getFilesForNode`。此層依賴 `vscode`,以 `tsc` 編譯 + 手動煙霧測試驗收(純邏輯已在 Task 3 測過)。

**Files:**
- Create: `src/historyTreeProvider.ts`

**Interfaces:**
- Consumes: `gitHistory.{HistoryRepo, HistoryCommit, listCommits, listCommitFiles}`、`historyTree.{TreeNode, FileNode, buildCommitFileTree, collectFileNodes}`、`vscode`。
- Produces:
  - `type HistoryNode = CommitNode | FolderViewNode | FileViewNode | LoadMoreNode | MessageNode`(各帶 `kind` 與 `contextValue`)。
  - `class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode>`:
    - `setRepo(repo: HistoryRepo | undefined): void`
    - `refresh(): void`
    - `loadMore(): Promise<void>`
    - `getTreeItem(node)`, `getChildren(node?)`
    - `getFilesForNode(node: HistoryNode): Promise<FileNode[]>`(對 `CommitNode` 會 `ensureCommitFilesLoaded`)
    - `readonly onDidChangeTreeData`

- [ ] **Step 1: 建 `src/historyTreeProvider.ts`**

```ts
import * as vscode from 'vscode';
import { type HistoryCommit, type HistoryRepo, listCommitFiles, listCommits } from './gitHistory.js';
import { buildCommitFileTree, collectFileNodes, type FileNode, type TreeNode } from './historyTree.js';

const PAGE_SIZE = 50;

export interface CommitNode { kind: 'commit'; commit: HistoryCommit; contextValue: 'commit'; }
export interface FolderViewNode { kind: 'folder'; node: TreeNode; commit: HistoryCommit; contextValue: 'folder'; }
export interface FileViewNode { kind: 'file'; node: FileNode; contextValue: 'file'; }
export interface LoadMoreNode { kind: 'loadMore'; contextValue: 'loadMore'; }
export interface MessageNode { kind: 'message'; text: string; contextValue: 'loading' | 'error' | 'empty'; }
export type HistoryNode = CommitNode | FolderViewNode | FileViewNode | LoadMoreNode | MessageNode;

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repo: HistoryRepo | undefined;
  private commits: HistoryCommit[] = [];
  private hasMore = false;
  private readonly fileCache = new Map<string, TreeNode[]>(); // key = commit.hash

  setRepo(repo: HistoryRepo | undefined): void {
    this.repo = repo;
    this.commits = [];
    this.hasMore = false;
    this.fileCache.clear();
    this.refresh();
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  async loadMore(): Promise<void> {
    if (!this.repo) return;
    const page = await listCommits(this.repo, { limit: PAGE_SIZE, skip: this.commits.length });
    this.commits.push(...page);
    this.hasMore = page.length === PAGE_SIZE;
    this.refresh();
  }

  private async ensureCommitFilesLoaded(commit: HistoryCommit): Promise<TreeNode[]> {
    const cached = this.fileCache.get(commit.hash);
    if (cached) return cached;
    const changes = await listCommitFiles(this.repo!, commit);
    const tree = buildCommitFileTree(this.repo!.rootUri.fsPath, commit, changes);
    this.fileCache.set(commit.hash, tree);
    return tree;
  }

  async getFilesForNode(node: HistoryNode): Promise<FileNode[]> {
    if (node.kind === 'file') return [node.node];
    if (node.kind === 'folder') return collectFileNodes(node.node);
    if (node.kind === 'commit') {
      const tree = await this.ensureCommitFilesLoaded(node.commit);
      return tree.flatMap(collectFileNodes);
    }
    return [];
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'commit': {
        const item = new vscode.TreeItem(firstLine(node.commit.message), vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.commit.hash.slice(0, 7);
        item.tooltip = `${node.commit.hash}\n${node.commit.authorName ?? ''}\n${node.commit.commitDate?.toISOString() ?? ''}`;
        item.contextValue = 'commit';
        item.iconPath = new vscode.ThemeIcon('git-commit');
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem((node.node as any).name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'folder';
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case 'file': {
        const f = node.node;
        const item = new vscode.TreeItem(`[${f.changeType}] ${f.name}`, vscode.TreeItemCollapsibleState.None);
        item.description = f.relPath;
        item.resourceUri = vscode.Uri.file(f.change.uri.fsPath);
        item.contextValue = 'file';
        return item;
      }
      case 'loadMore': {
        const item = new vscode.TreeItem('Load More…', vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'clipcode.history.loadMore', title: 'Load More' };
        item.contextValue = 'loadMore';
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = node.contextValue;
        return item;
      }
    }
  }

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    if (!this.repo) return [{ kind: 'message', text: 'No Git repository.', contextValue: 'empty' }];

    if (!node) {
      if (this.commits.length === 0) await this.loadMore();
      const top: HistoryNode[] = this.commits.map(commit => ({ kind: 'commit', commit, contextValue: 'commit' }));
      if (this.hasMore) top.push({ kind: 'loadMore', contextValue: 'loadMore' });
      if (top.length === 0) return [{ kind: 'message', text: 'No commits.', contextValue: 'empty' }];
      return top;
    }

    if (node.kind === 'commit') {
      try {
        const tree = await this.ensureCommitFilesLoaded(node.commit);
        if (tree.length === 0) return [{ kind: 'message', text: 'No changed files.', contextValue: 'empty' }];
        return tree.map(child => toViewNode(child, node.commit));
      } catch {
        return [{ kind: 'message', text: 'Failed to load changes.', contextValue: 'error' }];
      }
    }

    if (node.kind === 'folder') {
      return (node.node as any).children.map((child: TreeNode) => toViewNode(child, node.commit));
    }

    return [];
  }
}

function toViewNode(node: TreeNode, commit: HistoryCommit): HistoryNode {
  return node.kind === 'folder'
    ? { kind: 'folder', node, commit, contextValue: 'folder' }
    : { kind: 'file', node, contextValue: 'file' };
}

function firstLine(message: string): string { return message.split('\n')[0]; }
```

- [ ] **Step 2: 編譯確認**

Run: `npm run compile`
Expected: PASS — 無型別錯誤(真實 `vscode.git` 之 `Repository` 結構相容 `HistoryRepo`)。

- [ ] **Step 3: Commit**

```bash
git add src/historyTreeProvider.ts
git commit -m "feat: add HistoryTreeProvider (lazy children, cache, pagination, getFilesForNode)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `package.json` 貢獻點 + engine bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 改 `engines` 與 `@types/vscode`**

- `"engines": { "vscode": "^1.108.0" }`
- `devDependencies` 內 `"@types/vscode": "^1.108.0"`(原 `^1.92.0`)。

- [ ] **Step 2: 新增 commands**(`contributes.commands` 陣列追加)

```json
{ "command": "clipcode.history.switchRepository", "title": "ClipCode: Switch Repository", "icon": "$(repo)" },
{ "command": "clipcode.history.copyFullSource", "title": "ClipCode: Copy Full Source" },
{ "command": "clipcode.history.loadMore", "title": "Load More" },
{ "command": "clipcode.history.refresh", "title": "Refresh", "icon": "$(refresh)" }
```

- [ ] **Step 3: 新增 view(掛 scm 容器)**(`contributes` 內加 `views`)

```json
"views": {
  "scm": [
    { "id": "clipcode.history", "name": "ClipCode History", "icon": "$(history)" }
  ]
}
```

- [ ] **Step 4: 新增 menus**(`contributes.menus` 內追加)

```json
"view/title": [
  { "command": "clipcode.history.switchRepository", "when": "view == clipcode.history", "group": "navigation@10" },
  { "command": "clipcode.history.refresh", "when": "view == clipcode.history", "group": "navigation@20" }
],
"view/item/context": [
  { "command": "clipcode.history.copyFullSource", "when": "view == clipcode.history && viewItem =~ /^(commit|folder|file)$/", "group": "navigation@10" }
]
```

- [ ] **Step 5: 新增 activationEvent**(`activationEvents` 陣列追加)

```json
"onView:clipcode.history"
```

- [ ] **Step 6: 安裝新型別 + 編譯驗證**

Run: `npm install && npm test`
Expected: PASS — `@types/vscode@^1.108.0` 安裝、既有測試全綠、`package.json` 為合法 JSON。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: contribute ClipCode History view, commands, menus; bump engine to 1.108

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `historyView.ts` 整合 + 接進 `extension.ts`

把 provider 接上 view、實作 repo 選擇/持久化/Git 守衛、四個指令與複製串接。整合層,以編譯 + Extension Development Host 手動煙霧測試驗收。

**Files:**
- Create: `src/historyView.ts`
- Modify: `src/extension.ts`(activate 內呼叫 `registerHistoryView(context)`)

**Interfaces:**
- Consumes: `historyTreeProvider.{HistoryTreeProvider, HistoryNode}`、`historyTree.{resolveSourceNodes, dedupeFilesKeepNewest, FileNode}`、`gitHistory.{HistoryRepo, readFileAtCommit}`、`clipboardFormat.{buildGitPayload, buildPayload, PayloadFile}`、`gitCopy.DELETED_FILE_MARKER`、`pathResolver.toClipboardPathFromRoots`、`filterMatcher.fileMatchesFilters`、`settings`、既有 `readSettings`/`workspaceRootPaths`(可從 extension.ts 匯出或在 historyView 重建)。
- Produces: `registerHistoryView(context: vscode.ExtensionContext): void`。

- [ ] **Step 1: 建 `src/historyView.ts`**

```ts
import * as vscode from 'vscode';
import { buildGitPayload, buildPayload, type PayloadFile } from './clipboardFormat.js';
import { fileMatchesFilters } from './filterMatcher.js';
import { type HistoryRepo, readFileAtCommit } from './gitHistory.js';
import { dedupeFilesKeepNewest, type FileNode, resolveSourceNodes } from './historyTree.js';
import { type HistoryNode, HistoryTreeProvider } from './historyTreeProvider.js';
import { toClipboardPathFromRoots } from './pathResolver.js';
import { normalizeSettings, type ClipCodeSettings, type FilterRule } from './settings.js';

interface GitExtension { readonly enabled: boolean; readonly onDidChangeEnablement: vscode.Event<boolean>; getAPI(version: 1): GitAPI; }
interface GitAPI { readonly repositories: HistoryRepo[]; readonly onDidOpenRepository: vscode.Event<HistoryRepo>; readonly onDidCloseRepository: vscode.Event<HistoryRepo>; }

const LAST_REPO_KEY = 'clipcode.history.lastRepoRoot';

export function registerHistoryView(context: vscode.ExtensionContext): void {
  const provider = new HistoryTreeProvider();
  const treeView = vscode.window.createTreeView('clipcode.history', { treeDataProvider: provider, canSelectMany: true });
  context.subscriptions.push(treeView, provider as any);

  let api: GitAPI | undefined;

  const pickInitialRepo = (): HistoryRepo | undefined => {
    if (!api || api.repositories.length === 0) return undefined;
    const remembered = context.workspaceState.get<string>(LAST_REPO_KEY);
    const byRemembered = api.repositories.find(r => r.rootUri.toString() === remembered);
    if (byRemembered) return byRemembered;
    const selected = api.repositories.find(r => (r as any).ui?.selected === true);
    return selected ?? api.repositories[0];
  };

  const useRepo = (repo: HistoryRepo | undefined) => {
    provider.setRepo(repo);
    if (repo) void context.workspaceState.update(LAST_REPO_KEY, repo.rootUri.toString());
    treeView.title = repo ? `ClipCode History — ${basename(repo.rootUri.fsPath)}` : 'ClipCode History';
  };

  const wireApi = (gitApi: GitAPI) => {
    api = gitApi;
    useRepo(pickInitialRepo());
    context.subscriptions.push(
      gitApi.onDidOpenRepository(() => { if (!currentRepoStillOpen()) useRepo(pickInitialRepo()); }),
      gitApi.onDidCloseRepository(() => { if (!currentRepoStillOpen()) useRepo(pickInitialRepo()); }),
    );
  };
  const currentRepoStillOpen = () => {
    const root = context.workspaceState.get<string>(LAST_REPO_KEY);
    return !!api?.repositories.some(r => r.rootUri.toString() === root);
  };

  // Git enabled 守衛:getAPI 在停用時會丟例外
  const tryAcquire = (ext: vscode.Extension<GitExtension>) => {
    const exports = ext.isActive ? ext.exports : undefined;
    const init = (gx: GitExtension) => {
      if (!gx.enabled) { context.subscriptions.push(gx.onDidChangeEnablement(en => { if (en) try { wireApi(gx.getAPI(1)); } catch { /* ignore */ } })); return; }
      try { wireApi(gx.getAPI(1)); } catch { /* Git disabled mid-flight */ }
      context.subscriptions.push(gx.onDidChangeEnablement(en => { if (en && !api) try { wireApi(gx.getAPI(1)); } catch { /* ignore */ } }));
    };
    if (exports) init(exports); else void ext.activate().then(init);
  };
  const gitExt = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (gitExt) tryAcquire(gitExt);

  context.subscriptions.push(
    vscode.commands.registerCommand('clipcode.history.loadMore', () => provider.loadMore()),
    vscode.commands.registerCommand('clipcode.history.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('clipcode.history.switchRepository', async () => {
      if (!api || api.repositories.length === 0) { vscode.window.showWarningMessage('No Git repositories found.'); return; }
      const pick = await vscode.window.showQuickPick(
        api.repositories.map(r => ({ label: basename(r.rootUri.fsPath), repo: r })),
        { placeHolder: 'Select a repository' }
      );
      if (pick) useRepo(pick.repo);
    }),
    vscode.commands.registerCommand('clipcode.history.copyFullSource', async (clicked?: HistoryNode, selected?: HistoryNode[]) => {
      await copyFullSource(provider, treeView, resolveSourceNodes(clicked, selected, treeView.selection));
    }),
  );
}

async function copyFullSource(provider: HistoryTreeProvider, treeView: vscode.TreeView<HistoryNode>, sources: HistoryNode[]): Promise<void> {
  if (sources.length === 0) { vscode.window.showWarningMessage('No files selected.'); return; }
  const settings = readSettings();
  const roots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  const collected: FileNode[] = [];
  for (const node of sources) collected.push(...await provider.getFilesForNode(node));
  const files = dedupeFilesKeepNewest(collected);

  const payloadFiles: PayloadFile[] = [];
  let copied = 0, skippedSize = 0, limitReached = false, usesFallback = false;
  for (const f of files) {
    if (settings.setMaxFileCount && copied >= settings.fileCountLimit) { limitReached = true; break; }
    const clipboardPath = toClipboardPathFromRoots(roots.length ? roots : [f.repoRoot], f.change.uri.fsPath);
    if (settings.useFilters && !fileMatchesFilters(clipboardPath, settings.filterRules, settings.useIncludeFilters, settings.useExcludeFilters, f.change.uri.fsPath)) continue;

    const content = await readFileAtCommit(provider.repoForNode(f), f.commit.hash, f.change);
    if (content === undefined) continue;
    if (f.changeType === 'DELETED') usesFallback = true;

    const size = Buffer.byteLength(content, 'utf8');
    if (size > settings.maxFileSizeKB * 1024) {
      skippedSize++; payloadFiles.push({ path: clipboardPath, changeType: f.changeType, skippedReason: `size exceeds limit (${size} bytes)` }); continue;
    }
    payloadFiles.push({ path: clipboardPath, content, changeType: f.changeType }); copied++;
  }

  if (payloadFiles.length === 0) { vscode.window.showWarningMessage('No Git changes found to copy.'); return; }
  const opts = { headerFormat: settings.headerFormat, preText: settings.preText, postText: settings.postText, addExtraLineBetweenFiles: settings.addExtraLineBetweenFiles, files: payloadFiles };
  await vscode.env.clipboard.writeText(usesFallback ? buildGitPayload(opts) : buildPayload(opts));
  if (settings.showCopyNotification) {
    const s = skippedSize > 0 ? ` (${skippedSize} skipped: size exceeded)` : '';
    const l = limitReached ? ` File limit ${settings.fileCountLimit} reached.` : '';
    vscode.window.showInformationMessage(`${copied} Git file(s) copied${s}.${l}`);
  }
}

function basename(p: string): string { return p.replaceAll('\\', '/').split('/').filter(Boolean).pop() ?? p; }

function readSettings(): ClipCodeSettings {
  const c = vscode.workspace.getConfiguration('clipcode');
  return normalizeSettings({
    headerFormat: c.get('headerFormat'), preText: c.get('preText'), postText: c.get('postText'),
    addExtraLineBetweenFiles: c.get('addExtraLineBetweenFiles'), setMaxFileCount: c.get('setMaxFileCount'),
    fileCountLimit: c.get('fileCountLimit'), maxFileSizeKB: c.get('maxFileSizeKB'), showCopyNotification: c.get('showCopyNotification'),
    useFilters: c.get('useFilters'), useIncludeFilters: c.get('useIncludeFilters'), useExcludeFilters: c.get('useExcludeFilters'),
    filterRules: c.get<FilterRule[]>('filterRules'),
  });
}
```

> 實作備註:`provider.repoForNode(f)` 需在 `HistoryTreeProvider` 加一個 getter 回傳目前 `repo`(`getFilesForNode` 已綁目前 repo;`FileNode` 內含 `repoRoot`,但讀內容需 repo 物件)。最簡作法:在 provider 暴露 `get repo(): HistoryRepo | undefined`,`copyFullSource` 直接用 `provider.repo`(單 repo 視圖,所有節點同 repo)。據此把 `readFileAtCommit(provider.repoForNode(f), …)` 改為 `readFileAtCommit(provider.repo!, …)`,並在 Task 4 的 provider 加 `get repo() { return this.repo_; }`(把私有欄位改名 `repo_`)。

- [ ] **Step 2: 在 `extension.ts` 接上**

- 頂部加:`import { registerHistoryView } from './historyView.js';`
- `activate()` 內(現有 `context.subscriptions.push(...registerCommand...)` 之後)加一行:`registerHistoryView(context);`

- [ ] **Step 3: 編譯 + 既有測試**

Run: `npm test`
Expected: PASS — 編譯無誤、既有測試全綠。

- [ ] **Step 4: 手動煙霧測試(Extension Development Host)**

在 VSCode 按 F5 開 Extension Development Host(開一個有 git 歷史的資料夾),逐項確認:
1. SCM 容器出現「ClipCode History」,列出最新 commit;捲到底見「Load More…」可載下一頁。
2. 標題列「Switch Repository」可切 repo;重開視窗後記住上次選的 repo。
3. 展開 commit → 資料夾樹(單鏈壓縮)、檔名前綴 `[NEW]/[MODIFIED]/[DELETED]/[MOVED]`。
4. 點選 + Shift 區間 + Ctrl 加選(跨 commit);右鍵「ClipCode: Copy Full Source」分別在 file/folder/commit 上複製,貼出格式與既有 git 複製一致;同檔取較新 commit;deleted 檔為 marker。
5. 對**未展開**的 commit 右鍵直接複製 → 仍複製到該 commit 全部檔(驗 `ensureCommitFilesLoaded`)。
6. root commit 展開不崩(全部標 NEW);關掉 git 不報錯。

- [ ] **Step 5: Commit**

```bash
git add src/historyView.ts src/extension.ts
git commit -m "feat: wire ClipCode History view (repo switch, Copy Full Source, pagination)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- §3 視圖落點/貢獻點 → Task 5。engine bump → Task 5 / Global Constraints。
- §4 多 repo(順序、QuickPick、持久化、open/close、Git 停用守衛)→ Task 6。
- §5 資料層(log/diffBetweenWithStats/EMPTY_TREE/show、deleted marker、二進位)→ Task 2 + Task 1(readRefContent)。
- §6 樹結構(節點、lazy+快取、單鏈壓縮、loadMore、placeholder、getFilesForNode 契約)→ Task 3(純)+ Task 4(provider)。
- §7 選取/複製(canSelectMany、命令簽名 clicked/selected、getFilesForNode、去重、filters/size/limit、buildGitPayload、通知)→ Task 3(resolveSourceNodes/dedupe)+ Task 6(串接)。
- §8 重用 + 小重構(抽 gitContent)→ Task 1。
- §10 測試 → Tasks 1–3 的 TDD + Task 6 手動煙霧測試清單。
- §11 風險(SHA-256 root、merge、最低版)→ Global Constraints + Task 2 行為。

**2. Placeholder scan**:無 TBD/TODO;每個 code step 皆含完整程式碼;手動測試步驟列出可勾項。

**3. Type consistency**:`HistoryRepo`/`HistoryCommit`/`HistoryChange`(Task 2)→ provider(Task 4)→ view(Task 6)一致;`FileNode`/`TreeNode`(Task 3)貫穿 4/6;`readRefContent`(Task 1)被 Task 2 使用;`getFilesForNode`/`provider.repo`(Task 4 備註)被 Task 6 使用。命令 id(`clipcode.history.*`)在 Task 4(loadMore command on LoadMoreNode)、Task 5(contributes)、Task 6(registerCommand)三處一致。

> 已修正 Task 6 中 `provider.repoForNode` 的不一致:統一改用 Task 4 暴露的 `provider.repo` getter(備註已載明)。
