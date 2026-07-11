# Inline Blame（Slice A）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在編輯器裡以「per-檔案按鈕」開關逐行 git blame 標註，顯示作者/相對時間/age 顏色，hover 看 commit 並可開 Graph。

**Architecture:** 純邏輯（porcelain 解析、相對時間、age→顏色 bucket）抽成無 vscode 依賴的模組，用 `node:test` 做 TDD；spawn `git blame --porcelain --contents -`（餵未存檔 buffer 內容）由 deps 注入以便測試；vscode 端的 `BlameController` 管 per-editor 裝飾狀態、快取（key = `repo + HEAD + document.version`）、hover command link 與失效，裝飾渲染以手動 / e2e smoke 驗證。

**Tech Stack:** TypeScript（ESM，import 帶 `.js`）、VS Code Extension API（`TextEditorDecorationType`、`editor/title` menu）、`node:child_process` spawn、`node:test` + `node:assert/strict`。

## Global Constraints

- 語言/模組：TypeScript ESM，所有相對 import **帶 `.js` 副檔名**（照 `src/` 既有慣例）。
- 測試框架：`node:test` + `node:assert/strict`；測試檔放 `test/*.test.ts`，以 `npm run compile && node --test out/test/*.test.js` 執行；判斷 pass/fail 看輸出文字（`pass N, fail 0`），**不看管線 `$?`**。
- 程式碼註解一律英文（本專案慣例）。
- git 二進位路徑：一律走注入的 `getGitPath()`，其值來源為 `runtime?.gitPath ?? api.git?.path ?? 'git'`（照 `src/extension.ts:125` 既有解析），**不得寫死 `'git'`**（SSH-remote host 上 bare git 可能不在 PATH）。
- 未提交行的 sha 為 40 個 `0`（`0000000000000000000000000000000000000000`）。
- Commit 只讀、不變更工作區；blame 失敗一律靜默（不跳錯誤打擾使用者）。
- 不做「當前行 inline 常駐」模式；只做 per-檔案按鈕觸發的整檔 annotate（大檔門檻見 Task 6）。

---

### Task 1: blame porcelain 解析器（純函式）

**Files:**
- Create: `src/blame/blameParser.ts`
- Test: `test/blameParser.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces:
  - `interface BlameCommit { sha: string; author: string; authorTime: number; summary: string; isUncommitted: boolean; }`
  - `interface BlameLine { finalLine: number; commit: BlameCommit; }`
  - `function parseBlamePorcelain(stdout: string): BlameLine[]`

- [ ] **Step 1: 寫失敗測試**

`test/blameParser.test.ts`:
```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBlamePorcelain } from '../src/blame/blameParser.js';

const ZERO = '0000000000000000000000000000000000000000';

// Two committed lines from one commit, then one uncommitted line.
const sample = [
  'a3f19c0000000000000000000000000000000000 12 12 2',
  'author Wang',
  'author-mail <wang@example.com>',
  'author-time 1700000000',
  'author-tz +0800',
  'committer Wang',
  'committer-time 1700000000',
  'committer-tz +0800',
  'summary fix fee',
  'filename src/payment.ts',
  '\tconst fee = amount * 0.03;',
  'a3f19c0000000000000000000000000000000000 13 13',
  '\tconst total = amount + fee;',
  ZERO + ' 14 14 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1700009999',
  'author-tz +0800',
  'summary Version of ... not committed',
  'filename src/payment.ts',
  '\tif (total > 100000) throw new Error();',
  ''
].join('\n');

test('parses committed lines and reuses commit metadata by sha', () => {
  const lines = parseBlamePorcelain(sample);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].finalLine, 12);
  assert.equal(lines[0].commit.author, 'Wang');
  assert.equal(lines[0].commit.summary, 'fix fee');
  assert.equal(lines[0].commit.authorTime, 1700000000);
  assert.equal(lines[0].commit.isUncommitted, false);
  // Line 13 repeats only the sha header — metadata must come from the cache.
  assert.equal(lines[1].finalLine, 13);
  assert.equal(lines[1].commit.author, 'Wang');
});

test('flags all-zero sha as uncommitted', () => {
  const lines = parseBlamePorcelain(sample);
  assert.equal(lines[2].finalLine, 14);
  assert.equal(lines[2].commit.isUncommitted, true);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run compile && node --test out/test/blameParser.test.js`
Expected: FAIL（`Cannot find module '../src/blame/blameParser.js'` 或 compile error）。

- [ ] **Step 3: 寫最小實作**

`src/blame/blameParser.ts`:
```typescript
// Parses `git blame --porcelain` output into per-line commit metadata.
// The porcelain format prints the full author/summary block only the FIRST
// time a commit appears; later lines from the same commit print just the
// "<sha> <orig> <final> [<count>]" header, so metadata is cached by sha.

const ZERO_SHA = '0000000000000000000000000000000000000000';

export interface BlameCommit {
  sha: string;
  author: string;
  authorTime: number;
  summary: string;
  isUncommitted: boolean;
}

export interface BlameLine {
  finalLine: number;
  commit: BlameCommit;
}

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

export function parseBlamePorcelain(stdout: string): BlameLine[] {
  const cache = new Map<string, BlameCommit>();
  const result: BlameLine[] = [];
  const lines = stdout.split('\n');

  let currentSha: string | undefined;
  let currentFinalLine = 0;
  // Mutable fields collected between a header line and its `\t` content line.
  let author = '';
  let authorTime = 0;
  let summary = '';

  for (const line of lines) {
    const header = HEADER_RE.exec(line);
    if (header) {
      currentSha = header[1];
      currentFinalLine = Number(header[3]);
      const cached = cache.get(currentSha);
      if (cached) {
        author = cached.author;
        authorTime = cached.authorTime;
        summary = cached.summary;
      }
      continue;
    }
    if (line.startsWith('author ')) {
      author = line.slice('author '.length);
    } else if (line.startsWith('author-time ')) {
      authorTime = Number(line.slice('author-time '.length));
    } else if (line.startsWith('summary ')) {
      summary = line.slice('summary '.length);
    } else if (line.startsWith('\t') && currentSha) {
      let commit = cache.get(currentSha);
      if (!commit) {
        commit = {
          sha: currentSha,
          author,
          authorTime,
          summary,
          isUncommitted: currentSha === ZERO_SHA
        };
        cache.set(currentSha, commit);
      }
      result.push({ finalLine: currentFinalLine, commit });
    }
  }
  return result;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run compile && node --test out/test/blameParser.test.js`
Expected: PASS（`pass 2, fail 0`）。

- [ ] **Step 5: 提交**

```bash
git add src/blame/blameParser.ts test/blameParser.test.ts
git commit -m "feat(blame): add git blame --porcelain parser"
```

---

### Task 2: 相對時間 + age→顏色 bucket（純函式）

**Files:**
- Create: `src/blame/blameFormat.ts`
- Test: `test/blameFormat.test.ts`

**Interfaces:**
- Consumes: 無。
- Produces:
  - `function formatRelativeTime(authorTimeSec: number, nowSec: number): string`
  - `const AGE_BUCKETS: number` （bucket 數量，供 decoration type 池使用）
  - `function ageBucket(authorTimeSec: number, nowSec: number): number` — 回傳 `0..AGE_BUCKETS-1`，0 = 最新。

- [ ] **Step 1: 寫失敗測試**

`test/blameFormat.test.ts`:
```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime, ageBucket, AGE_BUCKETS } from '../src/blame/blameFormat.js';

const NOW = 1_700_000_000;

test('formats relative time in coarse buckets', () => {
  assert.equal(formatRelativeTime(NOW - 30, NOW), '剛剛');
  assert.equal(formatRelativeTime(NOW - 2 * 3600, NOW), '2 小時前');
  assert.equal(formatRelativeTime(NOW - 3 * 86400, NOW), '3 天前');
  assert.equal(formatRelativeTime(NOW - 400 * 86400, NOW), '1 年前');
});

test('ageBucket returns 0 for newest and grows with age, clamped', () => {
  assert.equal(ageBucket(NOW, NOW), 0);
  const old = ageBucket(NOW - 5000 * 86400, NOW);
  assert.equal(old, AGE_BUCKETS - 1);
  assert.ok(ageBucket(NOW - 30 * 86400, NOW) > 0);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run compile && node --test out/test/blameFormat.test.js`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 寫最小實作**

`src/blame/blameFormat.ts`:
```typescript
// Pure formatting helpers for blame annotations: coarse relative time and an
// age bucket index used to pick a shared decoration colour (newest = 0).

export const AGE_BUCKETS = 5;

const DAY = 86_400;
// Upper bound (in days) for each bucket except the last, which is open-ended.
const BUCKET_DAY_LIMITS = [7, 30, 180, 365];

export function formatRelativeTime(authorTimeSec: number, nowSec: number): string {
  const diff = Math.max(0, nowSec - authorTimeSec);
  if (diff < 60) return '剛剛';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分鐘前`;
  if (diff < DAY) return `${Math.floor(diff / 3600)} 小時前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 個月前`;
  return `${Math.floor(diff / (365 * DAY))} 年前`;
}

export function ageBucket(authorTimeSec: number, nowSec: number): number {
  const days = Math.max(0, nowSec - authorTimeSec) / DAY;
  for (let i = 0; i < BUCKET_DAY_LIMITS.length; i++) {
    if (days < BUCKET_DAY_LIMITS[i]) return i;
  }
  return AGE_BUCKETS - 1;
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run compile && node --test out/test/blameFormat.test.js`
Expected: PASS（`pass 2, fail 0`）。

- [ ] **Step 5: 提交**

```bash
git add src/blame/blameFormat.ts test/blameFormat.test.ts
git commit -m "feat(blame): add relative-time and age-bucket formatters"
```

---

### Task 3: blame 執行器（spawn，deps 注入）

**Files:**
- Create: `src/blame/blameRunner.ts`
- Test: `test/blameRunner.test.ts`

**Interfaces:**
- Consumes: `parseBlamePorcelain`（Task 1）。
- Produces:
  - `type SpawnBlame = (gitPath: string, args: string[], cwd: string, stdin: string) => Promise<string>`
  - `interface RunBlameOptions { gitPath: string; repoRoot: string; relPath: string; contents: string; spawnBlame: SpawnBlame; }`
  - `function runBlame(opts: RunBlameOptions): Promise<import('./blameParser.js').BlameLine[]>`
  - `function defaultSpawnBlame(...): Promise<string>`（真 spawn，測試不覆蓋）

- [ ] **Step 1: 寫失敗測試**

`test/blameRunner.test.ts`:
```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { runBlame, type SpawnBlame } from '../src/blame/blameRunner.js';

const porcelain = [
  'a3f19c0000000000000000000000000000000000 1 1 1',
  'author Wang',
  'author-time 1700000000',
  'summary fix',
  'filename f.ts',
  '\tconst x = 1;',
  ''
].join('\n');

test('runBlame passes --contents - with stdin and parses output', async () => {
  let seenArgs: string[] = [];
  let seenStdin = '';
  const spawnBlame: SpawnBlame = async (_git, args, _cwd, stdin) => {
    seenArgs = args;
    seenStdin = stdin;
    return porcelain;
  };
  const lines = await runBlame({
    gitPath: '/usr/bin/git',
    repoRoot: '/repo',
    relPath: 'f.ts',
    contents: 'const x = 1;\n',
    spawnBlame
  });
  assert.ok(seenArgs.includes('--porcelain'));
  assert.ok(seenArgs.includes('--contents'));
  assert.ok(seenArgs.includes('-')); // read buffer from stdin
  assert.ok(seenArgs.includes('f.ts'));
  assert.equal(seenStdin, 'const x = 1;\n');
  assert.equal(lines[0].commit.author, 'Wang');
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run compile && node --test out/test/blameRunner.test.js`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 寫最小實作**

`src/blame/blameRunner.ts`:
```typescript
// Runs `git blame --porcelain --contents - <file>` feeding the (possibly
// unsaved) editor buffer via stdin so line numbers align with what the user
// sees. The spawn is injected so the orchestration is unit-testable.
import { spawn } from 'node:child_process';
import { parseBlamePorcelain, type BlameLine } from './blameParser.js';

export type SpawnBlame = (
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string
) => Promise<string>;

export interface RunBlameOptions {
  gitPath: string;
  repoRoot: string;
  relPath: string;
  contents: string;
  spawnBlame: SpawnBlame;
}

export async function runBlame(opts: RunBlameOptions): Promise<BlameLine[]> {
  const args = ['-C', opts.repoRoot, 'blame', '--porcelain', '--contents', '-', '--', opts.relPath];
  const stdout = await opts.spawnBlame(opts.gitPath, args, opts.repoRoot, opts.contents);
  return parseBlamePorcelain(stdout);
}

export function defaultSpawnBlame(
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('git blame timed out'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`git blame exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}
```

Note: `--` args after `blame` include a mix of flags and the path; git accepts
`--porcelain --contents - -- <path>`. The test asserts individual tokens are
present rather than exact ordering.

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run compile && node --test out/test/blameRunner.test.js`
Expected: PASS（`pass 1, fail 0`）。

- [ ] **Step 5: 提交**

```bash
git add src/blame/blameRunner.ts test/blameRunner.test.ts
git commit -m "feat(blame): add git blame runner with injected spawn"
```

---

### Task 4: blame 快取 key + 失效邏輯（純函式）

**Files:**
- Create: `src/blame/blameCache.ts`
- Test: `test/blameCache.test.ts`

**Interfaces:**
- Consumes: `BlameLine`（Task 1）。
- Produces:
  - `function blameCacheKey(repoRoot: string, head: string, docVersion: number): string`
  - `class BlameCache { get(key): BlameLine[] | undefined; set(key, lines): void; delete(key): void; clear(): void; }`

- [ ] **Step 1: 寫失敗測試**

`test/blameCache.test.ts`:
```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { blameCacheKey, BlameCache } from '../src/blame/blameCache.js';

test('cache key changes with head or document version', () => {
  const a = blameCacheKey('/repo', 'HEAD1', 3);
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD2', 3));
  assert.notEqual(a, blameCacheKey('/repo', 'HEAD1', 4));
  assert.equal(a, blameCacheKey('/repo', 'HEAD1', 3));
});

test('cache stores and invalidates', () => {
  const cache = new BlameCache();
  const key = blameCacheKey('/repo', 'HEAD1', 1);
  assert.equal(cache.get(key), undefined);
  cache.set(key, [{ finalLine: 1, commit: { sha: 'x', author: 'A', authorTime: 1, summary: 's', isUncommitted: false } }]);
  assert.equal(cache.get(key)?.length, 1);
  cache.delete(key);
  assert.equal(cache.get(key), undefined);
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `npm run compile && node --test out/test/blameCache.test.js`
Expected: FAIL（模組不存在）。

- [ ] **Step 3: 寫最小實作**

`src/blame/blameCache.ts`:
```typescript
// Blame results are cached per (repo, HEAD, document.version) so an unsaved
// edit (which bumps document.version) or a HEAD move invalidates naturally.
import type { BlameLine } from './blameParser.js';

export function blameCacheKey(repoRoot: string, head: string, docVersion: number): string {
  return `${repoRoot} ${head} ${docVersion}`;
}

export class BlameCache {
  private readonly map = new Map<string, BlameLine[]>();
  get(key: string): BlameLine[] | undefined { return this.map.get(key); }
  set(key: string, lines: BlameLine[]): void { this.map.set(key, lines); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}
```

- [ ] **Step 4: 執行測試確認通過**

Run: `npm run compile && node --test out/test/blameCache.test.js`
Expected: PASS（`pass 2, fail 0`）。

- [ ] **Step 5: 提交**

```bash
git add src/blame/blameCache.ts test/blameCache.test.ts
git commit -m "feat(blame): add version-keyed blame cache"
```

---

### Task 5: package.json 貢獻點（命令 + 標題列按鈕）

**Files:**
- Modify: `package.json`（`contributes.commands`、`contributes.menus.editor/title`、`activationEvents`）

**Interfaces:**
- Produces（供 Task 6 註冊）：命令 id `clipcode.blame.toggle`、`clipcode.blame.revealCommit`。

- [ ] **Step 1: 加入命令定義**

在 `contributes.commands` 陣列加入（`icon` 用內建 codicon）：
```json
{ "command": "clipcode.blame.toggle", "title": "Snipcode: Toggle Inline Blame", "icon": "$(git-commit)" },
{ "command": "clipcode.blame.revealCommit", "title": "Snipcode: Reveal Blamed Commit in Graph" }
```

- [ ] **Step 2: 加入標題列按鈕**

在 `contributes.menus` 的 `editor/title` 陣列加入（只在有文字編輯器時顯示；`revealCommit` 不進任何 menu，只給 hover link 用）：
```json
{ "command": "clipcode.blame.toggle", "group": "navigation", "when": "editorIsOpen" }
```

- [ ] **Step 3: 加入 activationEvent**

在 `activationEvents` 陣列加入：
```json
"onCommand:clipcode.blame.toggle"
```
（`onStartupFinished` 已存在，controller 亦可在 activate 時就註冊；此條確保命令面板呼叫也能啟動。）

- [ ] **Step 4: 驗證 package.json 合法**

Run: `node -e "require('./package.json'); console.log('ok')"`
Expected: 輸出 `ok`（無 JSON 解析錯誤）。

- [ ] **Step 5: 提交**

```bash
git add package.json
git commit -m "feat(blame): contribute toggle command and editor title button"
```

---

### Task 6: BlameController + activate 接線（vscode 端）

**Files:**
- Create: `src/blame/blameController.ts`
- Create: `src/blame/index.ts`
- Modify: `src/extension.ts`（在 `activate` 內呼叫 `registerBlame`）

**Interfaces:**
- Consumes: `runBlame` + `defaultSpawnBlame`（Task 3）、`BlameCache` + `blameCacheKey`（Task 4）、`formatRelativeTime` + `ageBucket` + `AGE_BUCKETS`（Task 2）、`BlameLine`（Task 1）。
- Produces: `function registerBlame(context: vscode.ExtensionContext, deps: BlameDeps): void`，其中
  `interface BlameDeps { getGitPath: () => string; resolveRepoRoot: (uri: vscode.Uri) => { repoRoot: string; head: string } | undefined; }`

**設計要點（依 spec D5 + Slice A）：**
- Per-editor 狀態：`Set<string>`（key = `editor.document.uri.toString()`）記錄「已開啟 annotate 的檔」；toggle 命令切換當前 `activeTextEditor` 的該檔狀態。切換編輯器不自動開啟其他檔。
- 大檔門檻：`document.lineCount > 20000` → toggle 時顯示 `showInformationMessage('檔案過大，暫不標註')` 並不渲染。
- 顏色：建立 `AGE_BUCKETS` 個 `TextEditorDecorationType`（`before` 欄位放作者+相對時間文字，`color` 用 `ThemeColor` 由新到舊漸淡），依 `ageBucket` 分派每行到對應 type。**共用**這批 type，勿每行一個。
- Hover：每行 `hoverMessage` 為 `MarkdownString`（`isTrusted = true`），內含 `[在 Graph 開啟此 commit](command:clipcode.blame.revealCommit?<args>)`；點擊不靠裝飾本身（裝飾無 click event），靠此 command link。
- `clipcode.blame.revealCommit` v1：呼叫 `vscode.commands.executeCommand('gitGraphPlus.open')` 開啟 Graph（定位到特定 commit 為後續增強，v1 先開圖）。
- 失效：`onDidChangeTextDocument`（改動→用新 `document.version` 重算或清該檔裝飾）、`onDidSaveTextDocument`、`onDidChangeActiveTextEditor`（切檔時套用該檔既有開關狀態）。快取用 `BlameCache` + `blameCacheKey(repoRoot, head, document.version)`。
- 失敗：`runBlame` reject → 清裝飾、靜默（不彈錯）。
- 未提交行：`isUncommitted` → 文字顯示「你 · 未提交」，用最新 bucket（0）顏色。

- [ ] **Step 1: 寫 controller**

`src/blame/blameController.ts`:
```typescript
import * as vscode from 'vscode';
import { runBlame, defaultSpawnBlame } from './blameRunner.js';
import { BlameCache, blameCacheKey } from './blameCache.js';
import { formatRelativeTime, ageBucket, AGE_BUCKETS } from './blameFormat.js';
import type { BlameLine } from './blameParser.js';

const MAX_LINES = 20_000;

export interface BlameDeps {
  getGitPath: () => string;
  resolveRepoRoot: (uri: vscode.Uri) => { repoRoot: string; head: string } | undefined;
}

export class BlameController {
  private readonly enabled = new Set<string>(); // document URI strings
  private readonly cache = new BlameCache();
  private readonly types: vscode.TextEditorDecorationType[] = [];

  constructor(private readonly deps: BlameDeps) {
    for (let i = 0; i < AGE_BUCKETS; i++) {
      // Newest bucket brightest; older buckets fade toward a muted colour.
      this.types.push(vscode.window.createTextEditorDecorationType({
        before: {
          margin: '0 1.5em 0 0',
          color: new vscode.ThemeColor(
            i === 0 ? 'editorLineNumber.activeForeground' : 'editorLineNumber.foreground'
          )
        }
      }));
    }
  }

  dispose(): void { for (const t of this.types) t.dispose(); }

  async toggle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const key = editor.document.uri.toString();
    if (this.enabled.has(key)) {
      this.enabled.delete(key);
      this.clearDecorations(editor);
    } else {
      if (editor.document.lineCount > MAX_LINES) {
        void vscode.window.showInformationMessage('檔案過大，暫不標註');
        return;
      }
      this.enabled.add(key);
      await this.render(editor);
    }
  }

  async onActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (editor && this.enabled.has(editor.document.uri.toString())) {
      await this.render(editor);
    }
  }

  async onDocChange(doc: vscode.TextDocument): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === doc && this.enabled.has(doc.uri.toString())) {
      await this.render(editor);
    }
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    for (const t of this.types) editor.setDecorations(t, []);
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const info = this.deps.resolveRepoRoot(doc.uri);
    if (!info) return;
    const cacheKey = blameCacheKey(info.repoRoot, info.head, doc.version);
    let lines = this.cache.get(cacheKey);
    if (!lines) {
      try {
        lines = await runBlame({
          gitPath: this.deps.getGitPath(),
          repoRoot: info.repoRoot,
          relPath: vscode.workspace.asRelativePath(doc.uri, false),
          contents: doc.getText(),
          spawnBlame: defaultSpawnBlame
        });
        this.cache.set(cacheKey, lines);
      } catch {
        this.clearDecorations(editor); // silent on failure
        return;
      }
    }
    // Editor may have changed while awaiting.
    if (vscode.window.activeTextEditor !== editor || doc.version !== editor.document.version) return;
    this.applyDecorations(editor, lines);
  }

  private applyDecorations(editor: vscode.TextEditor, lines: BlameLine[]): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const buckets: vscode.DecorationOptions[][] = this.types.map(() => []);
    for (const line of lines) {
      const zeroIdx = line.finalLine - 1;
      if (zeroIdx < 0 || zeroIdx >= editor.document.lineCount) continue;
      const c = line.commit;
      const label = c.isUncommitted
        ? '你 · 未提交'
        : `${c.author} · ${formatRelativeTime(c.authorTime, nowSec)}`;
      const bucket = c.isUncommitted ? 0 : ageBucket(c.authorTime, nowSec);
      const hover = new vscode.MarkdownString();
      hover.isTrusted = true;
      if (c.isUncommitted) {
        hover.appendMarkdown('尚未提交');
      } else {
        const args = encodeURIComponent(JSON.stringify([c.sha]));
        hover.appendMarkdown(`**${c.sha.slice(0, 8)}** · ${c.author}\n\n${c.summary}\n\n[在 Graph 開啟此 commit](command:clipcode.blame.revealCommit?${args})`);
      }
      const range = new vscode.Range(zeroIdx, 0, zeroIdx, 0);
      buckets[bucket].push({
        range,
        hoverMessage: hover,
        renderOptions: { before: { contentText: label } }
      });
    }
    this.types.forEach((t, i) => editor.setDecorations(t, buckets[i]));
  }
}
```

- [ ] **Step 2: 寫 registerBlame 接線**

`src/blame/index.ts`:
```typescript
import * as vscode from 'vscode';
import { BlameController, type BlameDeps } from './blameController.js';

export function registerBlame(context: vscode.ExtensionContext, deps: BlameDeps): void {
  const controller = new BlameController(deps);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('clipcode.blame.toggle', () => controller.toggle()),
    vscode.commands.registerCommand('clipcode.blame.revealCommit', (_sha?: string) => {
      // v1: open the graph; commit-specific reveal is a follow-up.
      return vscode.commands.executeCommand('gitGraphPlus.open');
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => void controller.onActiveEditor(e)),
    vscode.workspace.onDidChangeTextDocument((e) => void controller.onDocChange(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => void controller.onDocChange(doc))
  );
}
```

- [ ] **Step 3: 在 activate 接上**

在 `src/extension.ts` 頂部 import：
```typescript
import { registerBlame } from './blame/index.js';
```
在 `activate(context)` 內、`activateGraph(...)` 之後加入（`gitPath` 沿用既有解析；`resolveRepoRoot` 用 vscode.git API 求 repo root + HEAD）：
```typescript
registerBlame(context, {
  getGitPath: () => runtimeGitPath(),
  resolveRepoRoot: (uri) => resolveRepoRootFor(uri)
});
```
於 `src/extension.ts` 檔案內新增兩個 helper（放在 `deactivate` 之前）：
```typescript
function runtimeGitPath(): string {
  const api = getBuiltInGitApi();
  return api?.git?.path ?? 'git';
}

function resolveRepoRootFor(uri: vscode.Uri): { repoRoot: string; head: string } | undefined {
  const api = getBuiltInGitApi();
  const repo = api?.repositories?.find((r: { rootUri: vscode.Uri }) =>
    uri.fsPath.startsWith(r.rootUri.fsPath));
  if (!repo) return undefined;
  const head = repo.state?.HEAD?.commit ?? repo.state?.HEAD?.name ?? 'HEAD';
  return { repoRoot: repo.rootUri.fsPath, head };
}
```
Note: `getBuiltInGitApi()` — 若 `src/extension.ts` 已有取得 vscode.git API 的既有函式（見 `extension.ts:458` 附近 `gitExtension.activate()`），改用該既有函式，不要新增重複的取得邏輯；此處僅示意名稱。實作時先 grep `getExtension('vscode.git')` 找到既有入口重用。

- [ ] **Step 4: 編譯 + 全量單元測試通過**

Run: `npm run compile && node --test out/test/*.test.js`
Expected: 全部 PASS（含既有測試，`fail 0`）。

- [ ] **Step 5: 手動驗證（在 Extension Development Host）**

Run: 按 F5 開 Extension Development Host，開一個 git 追蹤的檔案 → 點編輯器右上角 blame 按鈕。
Expected:
- 每行左側出現「作者 · 相對時間」，顏色新亮舊淡。
- hover 顯示 commit hash/summary 與「在 Graph 開啟此 commit」連結，點擊開啟 Graph。
- 未存檔改幾行後標註隨之更新，改動行顯示「你 · 未提交」。
- 切到另一個檔沒有標註；切回來仍有。再點按鈕關閉。

- [ ] **Step 6: 提交**

```bash
git add src/blame/blameController.ts src/blame/index.ts src/extension.ts
git commit -m "feat(blame): wire per-editor blame controller into activation"
```

---

### Task 7: e2e smoke（啟用不崩、命令存在）

**Files:**
- Create: `test-e2e/suite/blame.test.ts`（依既有 e2e 結構；若結構不同，放進既有 suite 目錄並沿用其樣板）

**Interfaces:**
- Consumes: 已註冊的命令 `clipcode.blame.toggle`。

- [ ] **Step 1: 寫 e2e smoke**

`test-e2e/suite/blame.test.ts`（沿用既有 e2e 檔的 import 樣式；先讀一個既有 `test-e2e/suite/*.test.ts` 對齊寫法）：
```typescript
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('blame smoke', () => {
  test('toggle command is registered and does not throw with no editor', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('clipcode.blame.toggle'));
    // With no active text editor, toggle should no-op silently.
    await vscode.commands.executeCommand('clipcode.blame.toggle');
  });
});
```

- [ ] **Step 2: 執行 e2e**

Run: `npm run test:e2e`
Expected: PASS（判斷看輸出的通過筆數，不看管線 `$?`）。

- [ ] **Step 3: 提交**

```bash
git add test-e2e/suite/blame.test.ts
git commit -m "test(blame): add e2e smoke for toggle command"
```

---

## Self-Review

**Spec coverage（對照設計文件 Slice A + D5）:**
- 觸發＝編輯器標題列按鈕、per-檔案、預設關 → Task 5（按鈕）+ Task 6（per-editor `enabled` set、切檔不自動開）。✓
- age 顏色以少量 bucket 共用 decoration type → Task 2（bucket）+ Task 6（`AGE_BUCKETS` 個 type）。✓
- hover command link（裝飾無點擊）→ Task 6 `MarkdownString isTrusted` + `revealCommit`。✓（D5）
- 未存檔 buffer 用 `--contents -` 餵 `document.getText()` → Task 3 + Task 6。✓（D5）
- 快取 key = repo+HEAD+document.version、編輯/存檔/HEAD 失效 → Task 4 + Task 6 listeners。✓
- 未提交行顯示「你 · 未提交」→ Task 6。✓
- 大檔門檻 → Task 6（`MAX_LINES`）。✓
- 失敗靜默 → Task 6 `catch` 清裝飾。✓
- 測試：porcelain parser、age→顏色、unsaved 對齊、e2e smoke → Task 1/2/3/7。✓

**Placeholder scan:** 無 TBD/TODO；每個 code step 附完整程式。唯一「示意名稱」`getBuiltInGitApi()` 已明確標註「grep 既有 `getExtension('vscode.git')` 入口重用」，非留白。

**Type consistency:** `BlameLine`/`BlameCommit`（Task 1）貫穿 Task 3/4/6；`SpawnBlame`（Task 3）、`blameCacheKey`/`BlameCache`（Task 4）、`ageBucket`/`AGE_BUCKETS`/`formatRelativeTime`（Task 2）在 Task 6 使用的簽章一致。命令 id `clipcode.blame.toggle` / `clipcode.blame.revealCommit` 在 Task 5/6 一致。

已知後續增強（非本計畫範圍）：`revealCommit` 目前只開 Graph，未定位到特定 commit（待 Graph 端提供 reveal 訊息後補）。
