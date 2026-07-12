# Unified Staged/Unstaged Diff View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Diff 編輯器分頁一次顯示同檔案的 Staged 與 Unstaged 兩區、箭頭雙向 stage/unstage（取代目前一分頁只顯示一個 side 的單向模型）。

**Architecture:** 一個 diff 分頁內上下堆疊兩個既有的 diff（staged=`git diff --cached`、unstaged=`git diff`），各自渲染複用的 `FileDiffView`。host `DiffPanel` 改以「檔案」為單位、一次抓兩份 diff 用同一張 SequenceGuard ticket 合併成單一 `diffShow`；stage/unstage 訊息維持帶 `side`，host 的 stage/unstage handler 不變。

**Tech Stack:** Svelte 5 runes（webview）、TypeScript、esbuild（host bundle）、Vite（webview bundle）、Vitest（happy-dom webview / node host）。

設計來源：`docs/superpowers/specs/2026-07-12-unified-staged-diff-design.md`（已採納 codex 審查）。

## Global Constraints

- **不改 `graph/src/utils/message-bus.ts`**：DiffPanel 的 diff bundle 訊息（`diffShow`/`diffReady`/`diffStageHunk`/`diffStageLines`）是 host↔diff-bundle 之間的 raw/untyped 訊息，不走 typed `WebviewMessage`/`ExtensionMessage`。
- **不改 `graph/webview-ui/src/components/commit/FileDiffView.svelte`**：直接複用現有 block 箭頭（staged 區顯示 `‹`、unstaged 區 `›`）。若最終仍需微調，改動包 `/* SNIPCODE-HOOK start/end */` fence。
- section 出現與否用 `diff !== null`，**不可**用 `hunks.length === 0`（binary/rename/mode-change 是非 null 但空 hunks）。
- diff bundle 必須 self-contained（classic script，見 `graph/AGENTS.md`）。
- git 術語（stage/unstage/commit…）不翻譯；commit 訊息繁中、不加 attribution。
- 判 pass/fail 看輸出文字（`Tests N passed` / `0 errors`），不看管線 exit code。
- 測試指令都在 `graph/` 目錄下跑。

## `diffShow` payload 契約（貫穿全 plan）

host（producer）與 diff bundle（consumer）都用這個 raw 形狀：

```
{ type: 'diffShow',
  payload: { repoPath: string, file: string,
             stagedDiff: DiffData | null, unstagedDiff: DiffData | null } }
```

stage/unstage 訊息形狀不變（保留 `side`）：
`diffStageHunk` payload `{ repoPath, file, side, hunkIndex }`；
`diffStageLines` payload `{ repoPath, file, side, hunkIndex, lineIndices }`。

---

### Task 1: diff-store 改雙 diff

**Files:**
- Modify: `graph/webview-ui/src/diff/diff-store.svelte.ts`
- Test: `graph/webview-ui/src/diff/__tests__/diff-store.test.ts`（UPDATE，既有測試依賴舊 `setDiff`/`side`/`diff`）

**Interfaces:**
- Produces:
  - `diffStore.repoPath: string`、`diffStore.file: string`
  - `diffStore.stagedDiff: DiffData | null`、`diffStore.unstagedDiff: DiffData | null`
  - `diffStore.error: string | null`、`diffStore.busy: boolean`、`diffStore.loaded: boolean`
  - `setDiffs(repoPath: string, file: string, stagedDiff: DiffData | null, unstagedDiff: DiffData | null): void`
  - `reset(): void`
  - `export type DiffSide = 'staged' | 'unstaged'`（保留）

- [ ] **Step 1: 改寫既有測試（先讓它們表達新介面）**

覆蓋 `graph/webview-ui/src/diff/__tests__/diff-store.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore } from '../diff-store.svelte';
import type { DiffData } from '../../lib/types';

function sample(): DiffData {
  return { file: 'src/a.ts', isBinary: false, isImage: false,
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ type: 'add', content: 'x', newLineNumber: 1 }] }] };
}

beforeEach(() => diffStore.reset());

describe('diffStore', () => {
  it('setDiffs stores both sides, file, repo and marks loaded', () => {
    diffStore.setDiffs('/repo', 'src/a.ts', sample(), null);
    expect(diffStore.repoPath).toBe('/repo');
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.stagedDiff?.hunks.length).toBe(1);
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.loaded).toBe(true);
    expect(diffStore.error).toBeNull();
  });

  it('setDiffs clears any prior error', () => {
    diffStore.error = 'boom';
    diffStore.setDiffs('/repo', 'src/a.ts', null, sample());
    expect(diffStore.error).toBeNull();
    expect(diffStore.unstagedDiff?.hunks.length).toBe(1);
  });

  it('reset clears everything including loaded', () => {
    diffStore.setDiffs('/repo', 'src/a.ts', sample(), sample());
    diffStore.reset();
    expect(diffStore.stagedDiff).toBeNull();
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.file).toBe('');
    expect(diffStore.loaded).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/diff-store.test.ts`
Expected: FAIL（`setDiffs` / `stagedDiff` / `loaded` 不存在）

- [ ] **Step 3: 改寫 diff-store**

覆蓋 `graph/webview-ui/src/diff/diff-store.svelte.ts`：

```ts
// Webview-side state for the full-tab Diff panel: the current file's staged +
// unstaged DiffData shown as two stacked sections. Its own self-contained bundle
// (diff.js), separate from the graph and commit-box bundles.
import type { DiffData } from '../lib/types';

export type DiffSide = 'staged' | 'unstaged';

class DiffStore {
  repoPath = $state('');
  file = $state('');
  /** HEAD ↔ index (git diff --cached). null when nothing is staged for this file. */
  stagedDiff = $state<DiffData | null>(null);
  /** index ↔ working tree (git diff). null when nothing is unstaged for this file. */
  unstagedDiff = $state<DiffData | null>(null);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);
  /** True while a stage/unstage request is in flight. Gates further clicks on
   *  BOTH sections so a second click can't race the first: applying re-parses the
   *  diff and shifts every later hunk/line index, so a click before the fresh
   *  `diffShow` lands would target the wrong hunk. */
  busy = $state(false);
  /** True once a file has been shown (either side may still be null). Distinguishes
   *  "no file open yet" from "file open but one/both sides empty". */
  loaded = $state(false);

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.stagedDiff = null;
    this.unstagedDiff = null;
    this.error = null;
    this.busy = false;
    this.loaded = false;
  }

  setDiffs(repoPath: string, file: string, stagedDiff: DiffData | null, unstagedDiff: DiffData | null): void {
    this.repoPath = repoPath;
    this.file = file;
    this.stagedDiff = stagedDiff;
    this.unstagedDiff = unstagedDiff;
    this.error = null;
    this.busy = false;
    this.loaded = true;
  }
}

export const diffStore = new DiffStore();
```

- [ ] **Step 4: 跑測試確認 pass**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/diff-store.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add graph/webview-ui/src/diff/diff-store.svelte.ts graph/webview-ui/src/diff/__tests__/diff-store.test.ts
git commit -m "refactor(graph/diff): diff-store 改存 staged + unstaged 兩份 diff"
```

---

### Task 2: messaging 改雙 diffShow + side 參數

**Files:**
- Modify: `graph/webview-ui/src/diff/messaging.ts`
- Test: `graph/webview-ui/src/diff/__tests__/messaging.test.ts`（UPDATE，既有測試依賴舊 payload/簽章）

**Interfaces:**
- Consumes（Task 1）：`diffStore.setDiffs(...)`、`diffStore.stagedDiff`、`diffStore.unstagedDiff`、`DiffSide`。
- Produces:
  - `listenForHostMessages(): void`（`diffShow` → `setDiffs(both)`）
  - `postStageHunk(side: DiffSide, hunkIndex: number): void`
  - `postStageLines(side: DiffSide, hunkIndex: number, lineIndices: number[]): void`

- [ ] **Step 1: 改寫既有測試表達新介面**

覆蓋 `graph/webview-ui/src/diff/__tests__/messaging.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore } from '../diff-store.svelte';
import { listenForHostMessages, postStageHunk, postStageLines } from '../messaging';
import { i18n } from '../../lib/i18n/index.svelte';

const emptyDiff = { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] };

beforeEach(() => {
  diffStore.reset();
  globalThis.__postedMessages = [];
});

describe('diff messaging', () => {
  it('diffShow populates both sides of the store', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: emptyDiff, unstagedDiff: null } },
    }));
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.stagedDiff).not.toBeNull();
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.loaded).toBe(true);
  });

  it('setLocale switches the i18n locale', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setLocale', payload: { locale: 'zh-cn' } },
    }));
    expect(i18n.locale).toBe('zh');
  });

  it('postStageHunk posts diffStageHunk with the given side', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 2);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageHunk', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 2 } },
    });
  });

  it('postStageHunk on the staged side posts side:staged', () => {
    diffStore.setDiffs('/r', 'src/a.ts', emptyDiff, null);
    postStageHunk('staged', 0);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageHunk', payload: { repoPath: '/r', file: 'src/a.ts', side: 'staged', hunkIndex: 0 } },
    });
  });

  it('postStageHunk is dropped when the requested side has no diff', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff); // staged is null
    postStageHunk('staged', 0);
    expect(globalThis.__postedMessages).toHaveLength(0);
  });

  it('an error message for diffStageHunk sets store.error', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.error).toBe('nope');
  });

  it('postStageHunk sets busy and ignores a second call until unlocked', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    postStageHunk('unstaged', 1); // dropped: an op is already in flight
    expect(globalThis.__postedMessages).toHaveLength(1);
  });

  it('diffShow clears busy so the next stage click is allowed again', () => {
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', stagedDiff: null, unstagedDiff: emptyDiff } },
    }));
    expect(diffStore.busy).toBe(false);
  });

  it('an error reply also clears busy', () => {
    listenForHostMessages();
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageHunk('unstaged', 0);
    expect(diffStore.busy).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.busy).toBe(false);
  });

  it('postStageLines posts diffStageLines with side + indices', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, emptyDiff);
    postStageLines('unstaged', 0, [1, 2]);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'diffStageLines', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 0, lineIndices: [1, 2] } },
    });
  });
});
```

- [ ] **Step 2: 跑測試確認 fail**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/messaging.test.ts`
Expected: FAIL（`postStageHunk` 簽章 / `diffShow` payload 不符）

- [ ] **Step 3: 改寫 messaging**

覆蓋 `graph/webview-ui/src/diff/messaging.ts`：

```ts
// Host <-> webview messaging for the full-tab Diff panel. Uses the shared
// memoized getVsCodeApi() (NOT a second raw acquireVsCodeApi) because
// FileDiffView -> ImageDiff also calls getVsCodeApi(), and acquireVsCodeApi()
// may be called only once per webview.
import { diffStore, type DiffSide } from './diff-store.svelte';
import { getVsCodeApi } from '../lib/vscode-api';
import { i18n } from '../lib/i18n/index.svelte';

const vscode = getVsCodeApi();

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        diffStore.setDiffs(msg.payload.repoPath, msg.payload.file, msg.payload.stagedDiff, msg.payload.unstagedDiff);
        diffStore.busy = false;
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunk' || msg.payload?.source === 'diffStageLines') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        diffStore.busy = false;
        break;
    }
  });
}

function diffFor(side: DiffSide) {
  return side === 'staged' ? diffStore.stagedDiff : diffStore.unstagedDiff;
}

/** Post a single hunk to the host; `side` decides stage vs unstage. Ignored while
 *  a prior op is still in flight (busy) — applying re-parses the diff and shifts
 *  every later hunk index, so a second click before the fresh `diffShow` lands
 *  would target the wrong hunk. Also ignored if that side currently has no diff. */
export function postStageHunk(side: DiffSide, hunkIndex: number): void {
  if (diffStore.busy) { return; }
  if (!diffFor(side)) { return; }
  diffStore.error = null;
  diffStore.busy = true;
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex },
  });
}

/** Post the gutter-selected changed lines of one hunk to the host; `side` decides
 *  stage vs unstage. Gated on `busy` for the same index-shift reason. */
export function postStageLines(side: DiffSide, hunkIndex: number, lineIndices: number[]): void {
  if (diffStore.busy) { return; }
  if (!diffFor(side)) { return; }
  diffStore.error = null;
  diffStore.busy = true;
  vscode.postMessage({
    type: 'diffStageLines',
    payload: { repoPath: diffStore.repoPath, file: diffStore.file, side, hunkIndex, lineIndices },
  });
}
```

- [ ] **Step 4: 跑測試確認 pass**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/messaging.test.ts`
Expected: PASS（10 tests）

- [ ] **Step 5: Commit**

```bash
git add graph/webview-ui/src/diff/messaging.ts graph/webview-ui/src/diff/__tests__/messaging.test.ts
git commit -m "refactor(graph/diff): messaging diffShow 收雙 diff、postStage* 帶明確 side"
```

---

### Task 3: Diff.svelte 兩區 section + i18n

**Files:**
- Modify: `graph/webview-ui/src/diff/Diff.svelte`
- Modify: `graph/webview-ui/src/lib/i18n/en.ts`、`zh.ts`、`ko.ts`（新增 `file.noChanges`）
- Test: `graph/webview-ui/src/diff/__tests__/Diff.test.ts`（新增）

**Interfaces:**
- Consumes（Task 1/2）：`diffStore.stagedDiff/unstagedDiff/loaded/busy/error`、`postStageHunk(side, hunkIndex)`、`postStageLines(side, hunkIndex, lineIndices)`、`DiffSide`。
- Produces: 純視圖，無對外符號。

- [ ] **Step 1: 新增 i18n key**

在三個檔的 `file.openChanges` 那行後各加一行：

`graph/webview-ui/src/lib/i18n/en.ts`：
```ts
  'file.openChanges': 'Open Changes',
  'file.noChanges': 'No changes',
```
`graph/webview-ui/src/lib/i18n/zh.ts`（在其 `file.openChanges` 後）：
```ts
  'file.noChanges': '无变更',
```
`graph/webview-ui/src/lib/i18n/ko.ts`（在其 `file.openChanges` 後）：
```ts
  'file.noChanges': '변경 없음',
```

- [ ] **Step 2: 寫 Diff.svelte 的失敗測試**

新增 `graph/webview-ui/src/diff/__tests__/Diff.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Diff from '../Diff.svelte';
import { diffStore } from '../diff-store.svelte';
import { i18n } from '../../lib/i18n/index.svelte';
import type { DiffData } from '../../lib/types';

// A small complete hunk so FileDiffView renders a stageable block arrow.
function textDiff(file = 'src/a.ts'): DiffData {
  return { file, isBinary: false, isImage: false,
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ type: 'add', content: 'x', newLineNumber: 1 }] }] };
}
function binaryDiff(file = 'img.png'): DiffData {
  return { file, isBinary: true, isImage: false, hunks: [] };
}

beforeEach(() => {
  diffStore.reset();
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
});

describe('Diff.svelte unified view', () => {
  it('shows the open-changes hint when no file is loaded', () => {
    const { getByText } = render(Diff);
    expect(getByText('Open Changes')).toBeTruthy();
  });

  it('renders two sections when both sides have a diff', () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    const { container, getByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(2);
    expect(getByText('Staged')).toBeTruthy();
    expect(getByText('Unstaged')).toBeTruthy();
  });

  it('renders only the Unstaged section when nothing is staged', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, textDiff());
    const { container, getByText, queryByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(1);
    expect(getByText('Unstaged')).toBeTruthy();
    expect(queryByText('Staged')).toBeNull();
  });

  it('still renders a section for a binary-only side (diff !== null, empty hunks)', () => {
    diffStore.setDiffs('/r', 'img.png', binaryDiff(), null);
    const { container, getByText, queryByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(1);
    expect(getByText('Staged')).toBeTruthy();
    expect(queryByText('No changes')).toBeNull();
  });

  it('shows "No changes" when a file is loaded but both sides are null', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, null);
    const { getByText } = render(Diff);
    expect(getByText('No changes')).toBeTruthy();
  });

  it('collapsing a section hides its FileDiffView content', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, textDiff());
    const { container } = render(Diff);
    expect(container.querySelector('.diff-section .diff-wrapper')).toBeTruthy();
    await fireEvent.click(container.querySelector('.section-header')!);
    expect(container.querySelector('.diff-section .diff-wrapper')).toBeNull();
  });

  it('staging a block in the staged section posts side:staged', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    const { container } = render(Diff);
    // Sections render in order [Staged, Unstaged]; the first section is Staged.
    const stagedSection = container.querySelectorAll('.diff-section')[0];
    const arrow = stagedSection.querySelector('.sbs-block-stage-btn');
    expect(arrow).toBeTruthy();
    await fireEvent.click(arrow!);
    const posted = globalThis.__postedMessages.map((m: any) => m.data);
    const stageMsg = posted.find((d: any) => d.type === 'diffStageLines');
    expect(stageMsg.payload.side).toBe('staged');
  });
});
```

- [ ] **Step 3: 跑測試確認 fail**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/Diff.test.ts`
Expected: FAIL（`.diff-section` 不存在、still uses `store.diff`）

- [ ] **Step 4: 改寫 Diff.svelte**

覆蓋 `graph/webview-ui/src/diff/Diff.svelte`：

```svelte
<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { diffStore, type DiffSide } from './diff-store.svelte';
  import { postStageHunk, postStageLines } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import FileDiffView from '../components/commit/FileDiffView.svelte';

  const store = diffStore;
  // Default side-by-side; own the toggle locally (PrView pattern) so we can pass
  // diffMode + hideModeToggle to FileDiffView while still letting the user flip.
  // Shared across both sections.
  let mode = $state<'inline' | 'side-by-side'>('side-by-side');

  // Per-side collapse; reset when the file changes.
  let collapsed = $state<{ staged: boolean; unstaged: boolean }>({ staged: false, unstaged: false });
  let lastFile = '';
  $effect(() => {
    if (store.file !== lastFile) {
      lastFile = store.file;
      collapsed = { staged: false, unstaged: false };
    }
  });

  // Section presence keys off diff !== null (NOT empty hunks — a binary/rename
  // side is non-null with empty hunks and must still show its section).
  const sections = $derived(
    ([
      { side: 'staged' as DiffSide, diff: store.stagedDiff, label: 'Staged' },
      { side: 'unstaged' as DiffSide, diff: store.unstagedDiff, label: 'Unstaged' },
    ]).filter((s) => s.diff !== null)
  );
</script>

<div class="diff-app-root">
  {#if !store.loaded}
    <p class="empty">{t('file.openChanges')}</p>
  {:else if sections.length === 0}
    <p class="empty">{t('file.noChanges')}</p>
  {:else}
    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}
    <div class="mode-bar">
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => { mode = 'inline'; }}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => { mode = 'side-by-side'; }}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <div class="sections">
      {#each sections as section (section.side)}
        <section class="diff-section">
          <button
            class="section-header"
            aria-expanded={!collapsed[section.side]}
            onclick={() => { collapsed[section.side] = !collapsed[section.side]; }}
          >
            <span class="codicon {collapsed[section.side] ? 'codicon-chevron-right' : 'codicon-chevron-down'}"></span>
            <span class="side-badge {section.side}">{section.label}</span>
          </button>
          {#if !collapsed[section.side]}
            <FileDiffView
              diff={section.diff}
              staged={section.side === 'staged'}
              stacked
              diffMode={mode}
              hideModeToggle
              stageBusy={store.busy}
              onStageHunk={({ hunkIndex }) => postStageHunk(section.side, hunkIndex)}
              onStageLines={({ hunkIndex, lineIndices }) => postStageLines(section.side, hunkIndex, lineIndices)}
            />
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-app-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    color: var(--vscode-foreground);
  }
  .empty { padding: 16px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  .banner {
    display: flex; align-items: center; gap: 6px; margin: 6px 12px; padding: 4px 8px;
    border-radius: 4px; font-size: 12px; font-family: var(--vscode-font-family);
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }
  .mode-bar {
    display: flex; align-items: center; justify-content: flex-end; gap: 8px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family); flex-shrink: 0;
  }
  .diff-mode-toggle { display: flex; gap: 2px; background: rgba(128,128,128,0.15); border-radius: 3px; padding: 1px; }
  .diff-mode-toggle button {
    padding: 2px 8px; font-size: 0.75em; border-radius: 2px;
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer;
  }
  .diff-mode-toggle button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

  /* The panel owns the scroll; each FileDiffView is `stacked` (flex:none, its own
     content height) so both sections form one long page instead of two half-height
     independently-scrolling boxes. */
  .sections { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .diff-section { display: flex; flex-direction: column; }
  .section-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 12px; border: none; cursor: pointer; text-align: left;
    background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08));
    color: var(--vscode-foreground); font-family: var(--vscode-font-family);
    position: sticky; top: 0; z-index: 3;
  }
  .side-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
</style>
```

- [ ] **Step 5: 跑測試確認 pass**

Run: `cd graph && npx vitest run --project webview webview-ui/src/diff/__tests__/Diff.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 6: svelte-check + 全 webview 測試**

Run: `cd graph/webview-ui && npx svelte-check --threshold error`
Expected: `0 ERRORS`
Run: `cd graph && npx vitest run --project webview`
Expected: 全 PASS（含既有 FileDiffView 35 測不受影響）

- [ ] **Step 7: Commit**

```bash
git add graph/webview-ui/src/diff/Diff.svelte graph/webview-ui/src/diff/__tests__/Diff.test.ts graph/webview-ui/src/lib/i18n/en.ts graph/webview-ui/src/lib/i18n/zh.ts graph/webview-ui/src/lib/i18n/ko.ts
git commit -m "feat(graph/diff): Diff 分頁改上下兩區 Staged/Unstaged 統一視圖"
```

---

### Task 4: host DiffPanel 以檔案為單位、合併抓兩份；tree 去掉 side

**Files:**
- Modify: `graph/src/panels/DiffPanel.ts`
- Modify: `graph/src/tree/changes-workbench.ts`（`showInDiffView` 去掉 `node.group`；四個 `refreshIfCurrent(...)` 呼叫去掉 side）
- 註：`DiffPanel` 是 vscode-bound、無單元測試 harness（coverage 排除）。此 task 靠
  typecheck + build 驗證；payload 契約已由 Task 2 的 messaging 測鎖住；行為由 F5 手測。

**Interfaces:**
- Consumes: `ChangesWorkbench.fileDiffData(repoPath, file, 'staged'|'unstaged')`（既有）、
  `stageHunks/unstageHunks/stageLines/unstageLines`（既有，操作後呼叫 `refreshIfCurrent(repoPath, file)`）。
- Produces: `DiffPanel.show(repoPath: string, file: string): void`、
  `DiffPanel.refreshIfCurrent(repoPath: string, file: string): void`、
  `diffShow` payload `{ repoPath, file, stagedDiff, unstagedDiff }`。

- [ ] **Step 1: 改 DiffPanel — current 去掉 side、show/refreshIfCurrent 去 side、push 抓兩份**

在 `graph/src/panels/DiffPanel.ts`：

改 `current` 型別（約 L23）：
```ts
  /** The file currently shown; drives retitle + refreshIfCurrent. */
  private current: { repoPath: string; file: string } | undefined;
```

改 `show`（約 L44-55）：
```ts
  /** Open (or reveal) the panel for a file and push both sides' diffs. */
  show(repoPath: string, file: string): void {
    this.current = { repoPath, file };
    const ticket = this.seq.issue();
    if (!this.panel) { this.createPanel(); }
    this.panel!.title = `Diff: ${path.basename(file)}`;
    this.panel!.reveal(vscode.ViewColumn.Active, false);
    if (this.ready) { void this.push(this.current, ticket); }
  }
```

改 `refreshIfCurrent`（約 L58-62）：
```ts
  /** Re-render ONLY if it is still the file the user is viewing (post-apply). */
  refreshIfCurrent(repoPath: string, file: string): void {
    if (this.panel && this.current?.repoPath === repoPath && this.current?.file === file) {
      this.show(repoPath, file);
    }
  }
```

改 `push`（約 L134-143）— 一張 ticket、`Promise.all` 抓兩份、完成後檢查一次只 post 一次：
```ts
  private async push(
    target: { repoPath: string; file: string },
    ticket: number,
  ): Promise<void> {
    if (!this.panel) { return; }
    const { repoPath, file } = target;
    const [stagedDiff, unstagedDiff] = await Promise.all([
      this.workbench.fileDiffData(repoPath, file, 'staged'),
      this.workbench.fileDiffData(repoPath, file, 'unstaged'),
    ]);
    if (!this.seq.isCurrent(ticket) || !this.panel) { return; } // superseded / disposed
    this.panel.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, stagedDiff, unstagedDiff } });
  }
```

移除頂部不再使用的 import（`ChangeGroup` 若已無其他用途）：確認 `import type { ChangeGroup }` 是否仍被引用；若否則刪除該行。stage/unstage handler（`diffStageLines`/`diffStageHunk`）**不動**（仍讀 `side`）。

- [ ] **Step 2: 改 changes-workbench — showInDiffView 與四個 refreshIfCurrent 去掉 side**

在 `graph/src/tree/changes-workbench.ts`：

`showInDiffView`（約 L202-204）：
```ts
  private showInDiffView(node: FileNode): void {
    this.diffPanel?.show(node.repoPath, node.path);
  }
```

四個呼叫點（`stageHunks` L213、`unstageHunks` L221、`stageLines` L229、`unstageLines` L236）都把
`this.diffPanel?.refreshIfCurrent(repoPath, file, 'unstaged'|'staged')` 改成
`this.diffPanel?.refreshIfCurrent(repoPath, file)`。例如 `stageHunks`：
```ts
    await this.refresh();
    this.diffPanel?.refreshIfCurrent(repoPath, file);
```
其餘三個同理（移除第三個引數）。

- [ ] **Step 3: host typecheck**

Run: `cd graph && npm run lint`
Expected: `tsc --noEmit` 無錯（若 `ChangeGroup` import 變成未使用會報錯 → 移除該 import）

- [ ] **Step 4: 全量 build（三 bundle + host）**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`
Expected: 三個 webview bundle + host bundle 皆 `built`，無 error

- [ ] **Step 5: 確認 host bundle 有帶到改動**

Run: `grep -c "unstagedDiff" dist/extension.js`
Expected: `>= 1`（host 端 diffShow 已打包）

- [ ] **Step 6: Commit**

```bash
git add graph/src/panels/DiffPanel.ts graph/src/tree/changes-workbench.ts
git commit -m "feat(graph/diff): DiffPanel 以檔案為單位、合併抓 staged+unstaged 一次推送"
```

---

## Self-Review

**Spec coverage：**
- 統一視圖上下兩區 → Task 3。
- host 以檔案為單位、合併抓兩份、單 ticket 單 post → Task 4 Step 1。
- diffShow payload `{repoPath, file, stagedDiff, unstagedDiff}` → Task 1（store）+ Task 2（消費）+ Task 4（生產）。
- stage/unstage 維持帶 side、host handler 不動 → Task 4（明確不改 handler）。
- 不改 message-bus → Global Constraints + Task 4 未觸及。
- 不改 FileDiffView → Global Constraints；Task 3 只複用。
- section presence 用 `diff !== null` → Task 3 `sections` derived + 測試（binary-only）。
- binary/image 顯示殼、image 預覽為既有 gap（非目標）→ Task 3（binary section 測試）；image 不觸及。
- race：單 ticket 合併 fetch → Task 4 Step 1；既有 rapid-stage 殘留為接受項（spec 記錄，plan 不新增保護）。
- 收合、切檔重置 → Task 3。
- stacked 版面 → Task 3（`stacked` prop + `.sections` overflow）。
- 既有 messaging/diff-store 測試列為 UPDATE → Task 1/2。

**Placeholder scan：** 無 TBD/TODO；每個 code step 都有完整程式碼。

**Type consistency：** `setDiffs`/`stagedDiff`/`unstagedDiff`/`loaded`（Task 1）在 Task 2、3 一致使用；`postStageHunk(side, hunkIndex)`/`postStageLines(side, hunkIndex, lineIndices)`（Task 2）在 Task 3 一致呼叫；`show(repoPath, file)`/`refreshIfCurrent(repoPath, file)`（Task 4）與 tree 呼叫點一致；`diffShow` payload 三處一致。
