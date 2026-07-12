# Commit Workbench B-2c — Full-Tab Side-by-Side Stage/Unstage Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped side-panel Diff webview (B-2b) with a full-width **editor-tab WebviewPanel** that reuses the graph's `FileDiffView.svelte` (side-by-side + Shiki syntax highlighting) and does per-hunk **Stage / Unstage** into the real git index.

**Architecture:** A new singleton `DiffPanel` (editor-tab `vscode.window.createWebviewPanel`, one panel re-used/retitled per clicked file) replaces the `snipcode.diff` `WebviewViewProvider`. Clicking a file in the Changes tree opens/reveals the panel showing that file's `DiffData`, default `diffMode='side-by-side'`. The panel hosts a rewritten `diff.js` bundle whose root component renders the **reused** `FileDiffView.svelte`; a new SNIPCODE-HOOK-fenced `onStageHunk` callback on `FileDiffView` posts a per-hunk stage/unstage message. The host routes it through the existing, already-tested `ChangesWorkbench.stageHunks / unstageHunks → GitService.stageHunks / unstageHunks`, then refreshes the tree and re-pushes the file's new diff to the panel (SequenceGuard-guarded, `refreshIfCurrent` semantics).

**Tech Stack:** TypeScript (extension host, esbuild/CJS), Svelte 5 runes webview (Vite, self-contained classic-script bundle `diff.js`), Shiki (`createHighlighterCore` + JS regex engine, no wasm), Vitest (backend `node` + webview `happy-dom`).

## Global Constraints

- **`git/` modules stay free of any `vscode` import** — this plan touches no `graph/src/git/*`; the backend (`GitService.stageHunks/unstageHunks`) is already implemented and tested. Do not modify it.
- **Every webview bundle MUST be self-contained** — no top-level `import` from a shared chunk. `diff.js` is loaded as a CLASSIC `<script nonce src>` (CSP `script-src 'nonce-…'`). Its build (`vite.diff.config.ts`, `inlineDynamicImports: true`) must stay single-entry and NOT be merged with the graph (`vite.config.ts`) or workbench (`vite.workbench.config.ts`) builds. Shiki grammars/themes are dynamic imports that get inlined — that is expected and already proven by the graph `main.js` bundle shipping `FileDiffView`.
- **The diff bundle must acquire the VS Code API through the shared memoized `getVsCodeApi()`** (`webview-ui/src/lib/vscode-api.ts`), NOT a second raw `acquireVsCodeApi()`. `FileDiffView → ImageDiff` already calls `getVsCodeApi()`, and `acquireVsCodeApi()` may be called only once per webview — a raw second call throws and blanks the panel. (See Self-Review investigation.)
- **All changes to `FileDiffView.svelte` (and any other `graph/` file) MUST be wrapped in `/* SNIPCODE-HOOK start … */ … /* SNIPCODE-HOOK end */` fences** — `graph/` is a vendored upstream; fences let an upstream re-sync survive.
- **New commands / removed views go through `package.json` `contributes`** (root `package.json`, not `graph/package.json`).
- **Commit messages in Traditional Chinese, no attribution / Co-Authored-By lines.**
- **v1 is per-hunk only.** Line-level staging is v2 (`buildForwardPatch` has no `lineIndices` support). Do not add an `onStageLines` callback.
- Verify commands:
  - backend: `cd graph && npx vitest run <path> --project backend`
  - webview: `cd graph && npx vitest run <path> --project webview`
  - type-check host: `cd graph && npm run lint`
  - type-check webview: `cd graph/webview-ui && npm run check`
  - build (three bundles): `cd graph/webview-ui && npm run build`

---

## File Structure

**Host (extension) — `graph/src/`**
- Create `panels/DiffPanel.ts` — singleton editor-tab WebviewPanel; owns create/reveal/retitle/dispose, the stage/unstage message handler, and `show` / `refreshIfCurrent`. Models `SnipcodeDiffViewProvider` (seq guard, message contract) but as a `createWebviewPanel` (mirrors `MainPanel`'s CSP/nonce/asset/lifecycle).
- Modify `tree/changes-workbench.ts` — swap the `SnipcodeDiffViewProvider` field/wiring for `DiffPanel`; add `fileDiffData()` (full `DiffData`, not just hunks); repoint `showInDiffView` / `stageHunks` / `unstageHunks`.
- Modify `extension.ts` — register `DiffPanel` instead of the `snipcode.diff` webview-view provider.
- Delete `tree/diff-view.ts` — the B-2b side-panel provider.

**Webview — `graph/webview-ui/src/`**
- Modify `components/commit/FileDiffView.svelte` — SNIPCODE-HOOK `onStageHunk` prop + per-hunk Stage/Unstage button (inline header + SBS hover overlay).
- Modify `components/commit/__tests__/FileDiffView.test.ts` — cover the new stage callback.
- Rewrite `diff/diff-store.svelte.ts` — hold a full `DiffData` + side, drop the checkbox/`DiffHunkView` model.
- Rewrite `diff/messaging.ts` — use `getVsCodeApi()`; handle `diffShow` (full `DiffData`) + `setLocale`; `postStageHunk(hunkIndex)`.
- Rewrite `diff/Diff.svelte` — render the reused `FileDiffView` with an SBS-default local mode toggle (PrView pattern).
- Modify `lib/i18n/en.ts`, `ko.ts`, `zh.ts` — add `file.stageHunk` / `file.unstageHunk`.

**Config — root**
- Modify `package.json` — remove the `snipcode.diff` view contribution.

---

## Task 1: Host — DiffPanel editor tab + workbench rewiring, side view removed

Deliverable: the side-panel Diff view is gone; clicking a file opens a full editor-tab WebviewPanel; the stage/unstage path is wired end-to-end at the host level. Runtime rendering lands in Tasks 2–3 (the `diff.js` bundle still speaks the old contract until Task 3) — this task's gate is **compile + no backend regression**.

**Files:**
- Create: `graph/src/panels/DiffPanel.ts`
- Modify: `graph/src/tree/changes-workbench.ts` (fields + `setDiffView`→`setDiffPanel`, `showInDiffView`, `fileDiff`→`fileDiffData`, `stageHunks`/`unstageHunks` re-point)
- Modify: `graph/src/extension.ts:196-208`
- Delete: `graph/src/tree/diff-view.ts`
- Modify: `package.json` (remove `snipcode.diff` view, lines ~289-293)

**Interfaces:**
- Consumes: `ChangesWorkbench.fileDiffData(repoPath, file, side): Promise<DiffData | null>` (added here); `ChangesWorkbench.stageHunks(repoPath, file, hunkIndices: number[])` and `unstageHunks(...)` (existing); `MainPanel.assetRootUri` (existing); `SequenceGuard` (existing); `ChangeGroup = 'staged' | 'unstaged'` (existing, `tree/build-change-tree.ts`); `DiffData` (existing, `git/types.ts`).
- Produces: `DiffPanel` with `static register(extensionUri, workbench): DiffPanel`, `show(repoPath, file, side: ChangeGroup): void`, `refreshIfCurrent(repoPath, file, side: ChangeGroup): void`, `dispose(): void`, `static readonly viewType = 'snipcode.diffPanel'`. Host→webview message `{ type: 'diffShow', payload: { repoPath, file, side, diff: DiffData } }`; webview→host `{ type: 'diffStageHunk', payload: { repoPath, file, side, hunkIndex: number } }`; plus `{ type: 'setLocale', payload: { locale } }` and `{ type: 'error', payload: { source: 'diffStageHunk', message } }`.

- [ ] **Step 1: Create `DiffPanel.ts`**

```ts
// graph/src/panels/DiffPanel.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { MainPanel } from './MainPanel';
import { SequenceGuard } from '../utils/sequence-guard';
import type { ChangeGroup } from '../tree/build-change-tree';
import type { ChangesWorkbench } from './changes-workbench-types'; // see note below

/**
 * Full-width Diff shown in an EDITOR TAB (WebviewPanel), replacing the B-2b side
 * panel. One singleton panel is re-used and retitled per clicked file. It hosts
 * the self-contained diff.js bundle (FileDiffView: side-by-side + Shiki), and
 * per-hunk Stage/Unstage routes through ChangesWorkbench → GitService.
 *
 * The diff.js bundle is a CLASSIC <script> (nonce CSP), mirroring MainPanel's
 * CSP/nonce/asset loading.
 */
export class DiffPanel {
  static readonly viewType = 'snipcode.diffPanel';
  private static instance: DiffPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  /** The file currently shown; drives retitle + refreshIfCurrent. */
  private current: { repoPath: string; file: string; side: ChangeGroup } | undefined;
  /** Drops a late fileDiffData reply for a file the user already navigated away
   *  from (rapid clicks / post-apply refresh racing a navigation). */
  private readonly seq = new SequenceGuard();

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  static register(extensionUri: vscode.Uri, workbench: ChangesWorkbench): DiffPanel {
    DiffPanel.instance = new DiffPanel(extensionUri, workbench);
    return DiffPanel.instance;
  }

  /** Open (or reveal) the panel for a file and push its diff. */
  show(repoPath: string, file: string, side: ChangeGroup): void {
    this.current = { repoPath, file, side };
    const ticket = this.seq.issue();
    if (!this.panel) { this.createPanel(); }
    this.panel!.title = `Diff: ${path.basename(file)}`;
    // Reveal without stealing the editor group focus away from the tree click.
    this.panel!.reveal(vscode.ViewColumn.Active, false);
    void this.push(this.current, ticket);
  }

  /** Re-render ONLY if it is still the file the user is viewing (post-apply). */
  refreshIfCurrent(repoPath: string, file: string, side: ChangeGroup): void {
    if (this.panel && this.current?.repoPath === repoPath && this.current?.file === file) {
      this.show(repoPath, file, side);
    }
  }

  private createPanel(): void {
    const assetRoot = MainPanel.assetRootUri
      ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const panel = vscode.window.createWebviewPanel(
      DiffPanel.viewType,
      'Diff',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [assetRoot],
      },
    );
    panel.webview.html = this.getHtml(panel.webview, assetRoot);
    this.postLocale(panel);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type !== 'diffStageHunk') { return; }
      const { repoPath, file, side, hunkIndex } = msg.payload ?? {};
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        }
        // stageHunks/unstageHunks call refreshIfCurrent → re-push the new diff.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message } });
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
      }
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.current = undefined;
    });
    this.panel = panel;
  }

  private async push(
    target: { repoPath: string; file: string; side: ChangeGroup },
    ticket: number,
  ): Promise<void> {
    if (!this.panel) { return; }
    const { repoPath, file, side } = target;
    const diff = await this.workbench.fileDiffData(repoPath, file, side);
    if (!this.seq.isCurrent(ticket) || !this.panel) { return; } // superseded / disposed
    this.panel.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, side, diff } });
  }

  private postLocale(panel: vscode.WebviewPanel): void {
    const setting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = setting === 'auto' ? (vscode.env.language || 'en') : setting;
    panel.webview.postMessage({ type: 'setLocale', payload: { locale } });
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${codiconUri}" rel="stylesheet" />
</head>
<body>
  <div id="diff-app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.current = undefined;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}
```

> **Note on the `ChangesWorkbench` import:** `changes-workbench.ts` imports `DiffPanel` (Step 3) and `DiffPanel` needs the `ChangesWorkbench` type — a type-only cycle. Import it as `import type { ChangesWorkbench } from '../tree/changes-workbench';` (a `type` import is erased at compile time, so no runtime cycle). The `changes-workbench-types` path above is a placeholder; use `import type { ChangesWorkbench } from '../tree/changes-workbench';`.

- [ ] **Step 2: Fix the import path in `DiffPanel.ts`**

Replace the placeholder import line with the real one:

```ts
import type { ChangesWorkbench } from '../tree/changes-workbench';
```

- [ ] **Step 3: Rewire `ChangesWorkbench` to `DiffPanel`**

In `graph/src/tree/changes-workbench.ts`, replace the `SnipcodeDiffViewProvider` import and field, add `fileDiffData`, and re-point the three call sites.

Change the import (line 9):

```ts
// remove: import type { SnipcodeDiffViewProvider } from './diff-view';
import type { DiffData } from '../git/types';
import type { DiffPanel } from '../panels/DiffPanel';
```

Change the field (line 31) and setter (lines 43-44):

```ts
  private diffPanel: DiffPanel | undefined;

  /** Wire the Diff editor-tab panel so file clicks and post-stage refreshes can drive it. */
  setDiffPanel(panel: DiffPanel): void { this.diffPanel = panel; }
```

Replace `fileDiff` (lines 192-200) with a full-`DiffData` variant:

```ts
  /** Read a file's parsed DiffData (staged or unstaged side) for the Diff panel.
   *  Reuses getUncommittedFileDiff so the hunk order aligns with the raw
   *  stageHunks/unstageHunks re-fetch (same git diff command per side). */
  async fileDiffData(repoPath: string, file: string, side: ChangeGroup): Promise<DiffData | null> {
    return this.svcFor(repoPath)
      .getUncommittedFileDiff(file, side === 'staged')
      .catch(() => null);
  }
```

Replace `showInDiffView` (lines 202-205):

```ts
  /** Drive the Diff editor tab from a clicked file node (tree command). */
  private showInDiffView(node: FileNode): void {
    this.diffPanel?.show(node.repoPath, node.path, node.group);
  }
```

Re-point the refresh call in `stageHunks` (line 214) and `unstageHunks` (line 222):

```ts
    this.diffPanel?.refreshIfCurrent(repoPath, file, 'unstaged'); // in stageHunks
```
```ts
    this.diffPanel?.refreshIfCurrent(repoPath, file, 'staged');   // in unstageHunks
```

(The `snipcode.git.showDiff` command registration on line 274 is unchanged — it still calls `showInDiffView`.)

- [ ] **Step 4: Register `DiffPanel` in `extension.ts`, drop the side view**

In `graph/src/extension.ts`, remove the `SnipcodeDiffViewProvider` import (line 17) and replace the wiring block (lines 196-208):

```ts
  // remove: import { SnipcodeDiffViewProvider } from './tree/diff-view';
  import { DiffPanel } from './panels/DiffPanel';
```

```ts
  const diffPanel = DiffPanel.register(context.extensionUri, workbench);
  workbench.setDiffPanel(diffPanel);
  context.subscriptions.push(
    workbench,
    changesView,
    diffPanel,
    vscode.window.registerWebviewViewProvider(
      CommitBoxViewProvider.viewType,
      new CommitBoxViewProvider(context.extensionUri, workbench),
    ),
  );
```

(The `snipcode.diff` `registerWebviewViewProvider(...)` call is deleted.)

- [ ] **Step 5: Delete the B-2b side-panel provider**

Run: `rm graph/src/tree/diff-view.ts`

- [ ] **Step 6: Remove the `snipcode.diff` view from `package.json`**

In root `package.json`, delete the view object (lines ~289-293) so the `snipcode-git` container keeps only Changes + Commit:

```jsonc
        {
          "id": "snipcode.commitBox",
          "name": "Commit",
          "type": "webview"
        }
        // deleted:
        // { "id": "snipcode.diff", "name": "Diff", "type": "webview" }
```

- [ ] **Step 7: Type-check the host**

Run: `cd graph && npm run lint`
Expected: PASS (tsc `--noEmit`, no errors). If it reports `Cannot find name 'SnipcodeDiffViewProvider'` or a stale reference, you missed a call site — grep `grep -rn "SnipcodeDiffViewProvider\|diffView\|setDiffView\|\.fileDiff(" graph/src` and fix.

- [ ] **Step 8: Confirm no backend regression**

Run: `cd graph && npx vitest run src/git/__tests__/git-service.test.ts --project backend`
Expected: PASS (`Tests … passed`) — the backend stage/unstage logic is untouched; this just proves nothing broke.

- [ ] **Step 9: Commit**

```bash
git add graph/src/panels/DiffPanel.ts graph/src/tree/changes-workbench.ts graph/src/extension.ts package.json
git rm graph/src/tree/diff-view.ts
git commit -m "重構 B-2c：Diff 改用編輯器分頁 WebviewPanel，移除側欄 Diff view"
```

---

## Task 2: FileDiffView SNIPCODE-HOOK per-hunk Stage/Unstage callback

Deliverable: `FileDiffView.svelte` renders a per-hunk Stage/Unstage button (inline header + SBS hover overlay) and fires `onStageHunk({ file, hunkIndex })`, with the label driven by the `staged` prop. TDD via the webview vitest project.

**Files:**
- Modify: `graph/webview-ui/src/lib/i18n/en.ts:664`, `ko.ts:665`, `zh.ts:665` (add `file.stageHunk` / `file.unstageHunk`)
- Modify: `graph/webview-ui/src/components/commit/FileDiffView.svelte`
- Test: `graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts`

**Interfaces:**
- Consumes: existing `FileDiffView` props (`diff: DiffData`, `staged?: boolean`, `diffMode?`, `hideModeToggle?`), `isHunkComplete(hunkIndex)`, `t()`, existing `.hunk-action-btn` / `.sbs-hunk` styling.
- Produces: new prop `onStageHunk?: (target: { file: string; hunkIndex: number }) => void;` on `FileDiffView`; DOM `.hunk-stage-btn` (inline) and `.sbs-stage-btn` (SBS); i18n keys `file.stageHunk` / `file.unstageHunk`.

- [ ] **Step 1: Add the failing tests**

Append to `FileDiffView.test.ts` (it already imports `render`, `fireEvent`, `vi`, `sampleDiff`, `hugeDiff`, `i18n`):

```ts
describe('FileDiffView stage/unstage (B-2c)', () => {
  it('renders a "Stage Hunk" button on an unstaged diff and fires onStageHunk', async () => {
    const onStageHunk = vi.fn();
    const { container } = render(FileDiffView, { diff: sampleDiff(), staged: false, onStageHunk });
    const btn = container.querySelector('.hunk-stage-btn');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Stage Hunk');
    await fireEvent.click(btn!);
    expect(onStageHunk).toHaveBeenCalledTimes(1);
    expect(onStageHunk.mock.calls[0][0]).toEqual({ file: 'src/foo.ts', hunkIndex: 0 });
  });

  it('labels the button "Unstage Hunk" on a staged diff', () => {
    const { container } = render(FileDiffView, { diff: sampleDiff(), staged: true, onStageHunk: vi.fn() });
    expect(container.querySelector('.hunk-stage-btn')!.textContent).toContain('Unstage Hunk');
  });

  it('renders no stage button when onStageHunk is not provided', () => {
    const { container } = render(FileDiffView, { diff: sampleDiff() });
    expect(container.querySelector('.hunk-stage-btn')).toBeNull();
  });

  it('disables staging on a truncated hunk (never stage unseen lines)', () => {
    const { container } = render(FileDiffView, { diff: hugeDiff(), onStageHunk: vi.fn() });
    expect(container.querySelector('.hunk-stage-btn')).toBeNull();
  });

  it('shows an SBS overlay stage button in side-by-side mode', () => {
    const { container } = render(FileDiffView, {
      diff: sampleDiff(), staged: false, onStageHunk: vi.fn(), diffMode: 'side-by-side', hideModeToggle: true,
    });
    const btn = container.querySelector('.sbs-stage-btn');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain('Stage Hunk');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd graph && npx vitest run webview-ui/src/components/commit/__tests__/FileDiffView.test.ts --project webview`
Expected: FAIL — the new `describe` block errors (`.hunk-stage-btn` is `null`; `file.stageHunk` returns the raw key).

- [ ] **Step 3: Add the i18n keys**

In `webview-ui/src/lib/i18n/en.ts`, after `'file.reverseLines': 'Reverse Selected Lines',` (line 664):

```ts
  'file.stageHunk': 'Stage Hunk',
  'file.unstageHunk': 'Unstage Hunk',
```

In `webview-ui/src/lib/i18n/zh.ts`, after `'file.reverseLines': '还原选定行',` (line 665):

```ts
  'file.stageHunk': '暂存此 Hunk',
  'file.unstageHunk': '取消暂存此 Hunk',
```

In `webview-ui/src/lib/i18n/ko.ts`, after `'file.reverseLines': '선택한 줄 되돌리기',` (line 665):

```ts
  'file.stageHunk': 'Hunk 스테이지',
  'file.unstageHunk': 'Hunk 스테이지 해제',
```

- [ ] **Step 4: Add the `onStageHunk` prop + `canStage` to `FileDiffView.svelte`**

In the `Props` interface, inside the existing SNIPCODE-HOOK region (after the `hideModeToggle` line, before `/* SNIPCODE-HOOK end */` at line 58), add:

```ts
    /* SNIPCODE-HOOK (B-2c): full-tab stage/unstage. Fires per-hunk with the file
       + hunk index; the button label follows `staged` (unstaged file → "Stage
       Hunk", staged file → "Unstage Hunk"). Line-level staging is v2
       (buildForwardPatch has no lineIndices yet), so there is no onStageLines. */
    onStageHunk?: (target: { file: string; hunkIndex: number }) => void;
```

Add `onStageHunk` to the destructure (line 61):

```ts
  let { diff, commitHash, staged = false, stacked = false, heading, onReverse, onReverseHunk, onReverseLines, onStageHunk, diffMode: diffModeProp, hideModeToggle = false }: Props = $props();
```

After the `canReverse` derived (line 68), add:

```ts
  /* SNIPCODE-HOOK start (B-2c): staging affordance gate + action. */
  const canStage = $derived(!!onStageHunk);

  function stageHunk(hunkIndex: number) {
    if (!onStageHunk || !isHunkComplete(hunkIndex)) return;
    onStageHunk({ file: diff.file, hunkIndex });
  }
  /* SNIPCODE-HOOK end */
```

- [ ] **Step 5: Render the inline stage button + widen the reversible/hover gates**

In the inline hunk element (line 412), extend the `class:reversible` gate to include `canStage`:

```svelte
          <div class="diff-hunk" class:reversible={(canReverse || canStage) && isHunkComplete(hunkIdx)} class:has-selection={lineSel?.hunkIdx === hunkIdx && selectedChangedIndices.length > 0}>
```

Inside `.hunk-header-inner`, immediately AFTER the existing `{#if canReverse && isHunkComplete(hunkIdx)} … {/if}` block (after line 429), add a fenced stage block:

```svelte
                <!-- SNIPCODE-HOOK start (B-2c): inline per-hunk Stage/Unstage -->
                {#if canStage && isHunkComplete(hunkIdx)}
                  <button class="hunk-action-btn hunk-stage-btn" onclick={() => stageHunk(hunkIdx)}
                          aria-label={staged ? t('file.unstageHunk') : t('file.stageHunk')}
                          title={staged ? t('file.unstageHunk') : t('file.stageHunk')}>
                    <i class="codicon {staged ? 'codicon-remove' : 'codicon-add'}"></i>
                    <span>{staged ? t('file.unstageHunk') : t('file.stageHunk')}</span>
                  </button>
                {/if}
                <!-- SNIPCODE-HOOK end -->
```

- [ ] **Step 6: Render the SBS overlay stage button + widen the SBS hover gate**

In the LEFT SBS pane's `.sbs-hunk` (lines 463-469), extend the `hunk-hover` gate and add the overlay button as the first child of the hunk div:

```svelte
              <div
                class="sbs-hunk"
                class:hunk-hover={(canReverse || canStage) && isHunkComplete(hunkIdx) && hoveredHunkIdx === hunkIdx}
                onmouseenter={() => { hoveredHunkIdx = hunkIdx; }}
                onmouseleave={() => { if (hoveredHunkIdx === hunkIdx) hoveredHunkIdx = null; }}
                oncontextmenu={(e) => handleLineContextMenu(e, hunkIdx)}
              >
                <!-- SNIPCODE-HOOK start (B-2c): SBS overlay Stage/Unstage -->
                {#if canStage && isHunkComplete(hunkIdx)}
                  <button class="sbs-stage-btn" onclick={() => stageHunk(hunkIdx)}
                          aria-label={staged ? t('file.unstageHunk') : t('file.stageHunk')}
                          title={staged ? t('file.unstageHunk') : t('file.stageHunk')}>
                    {staged ? t('file.unstageHunk') : t('file.stageHunk')}
                  </button>
                {/if}
                <!-- SNIPCODE-HOOK end -->
```

Also extend the RIGHT pane's `.sbs-hunk` `hunk-hover` gate (line 494) so hovering either pane highlights the hunk (no button in the right pane):

```svelte
                class:hunk-hover={(canReverse || canStage) && isHunkComplete(hunkIdx) && hoveredHunkIdx === hunkIdx}
```

- [ ] **Step 7: Add the stage-button CSS**

In the `<style>` block, after the `.hunk-lines-btn` rule (line 672), add:

```css
  /* SNIPCODE-HOOK start (B-2c): stage/unstage buttons (green accent). */
  .hunk-stage-btn {
    color: var(--vscode-charts-green, #48bf91);
    opacity: 0;
  }
  .diff-hunk.reversible:hover .hunk-stage-btn,
  .hunk-stage-btn:focus {
    opacity: 1;
  }
  .sbs-stage-btn {
    position: absolute;
    top: 2px;
    right: 8px;
    z-index: 2;
    opacity: 0;
    padding: 1px 8px;
    border: 1px solid var(--vscode-focusBorder, #4a9eff);
    border-radius: 3px;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    cursor: pointer;
    font-size: 0.85em;
    white-space: nowrap;
  }
  .sbs-hunk.hunk-hover .sbs-stage-btn,
  .sbs-stage-btn:focus {
    opacity: 1;
  }
  /* SNIPCODE-HOOK end */
```

And make the SBS hunk a positioning context — extend the existing `.sbs-hunk.hunk-hover` selector's neighbourhood by adding a `position: relative` rule (after `.diff-sbs` block, near line 799):

```css
  /* SNIPCODE-HOOK (B-2c): anchor for the .sbs-stage-btn overlay. */
  .sbs-hunk { position: relative; }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd graph && npx vitest run webview-ui/src/components/commit/__tests__/FileDiffView.test.ts --project webview`
Expected: PASS (all reverse tests still green + the 5 new stage tests). If the SBS test fails to find `.sbs-stage-btn`, confirm `diffMode: 'side-by-side'` renders the `.diff-sbs` branch (it needs `mode === 'side-by-side'`, driven by the `diffModeProp`).

- [ ] **Step 9: Type-check the webview**

Run: `cd graph/webview-ui && npm run check`
Expected: PASS (svelte-check, 0 errors) — proves the new prop + template type-check.

- [ ] **Step 10: Commit**

```bash
git add graph/webview-ui/src/components/commit/FileDiffView.svelte \
        graph/webview-ui/src/components/commit/__tests__/FileDiffView.test.ts \
        graph/webview-ui/src/lib/i18n/en.ts graph/webview-ui/src/lib/i18n/ko.ts graph/webview-ui/src/lib/i18n/zh.ts
git commit -m "feat(B-2c)：FileDiffView 加上 per-hunk Stage/Unstage 回呼與按鈕"
```

---

## Task 3: Diff webview bundle — reuse FileDiffView, SBS-default, new protocol

Deliverable: the `diff.js` bundle renders the reused `FileDiffView` in a full-tab layout with an SBS-default mode toggle, holds a full `DiffData`, and speaks the Task-1 `diffShow` / `diffStageHunk` / `setLocale` protocol via the shared `getVsCodeApi()`. TDD the store + messaging; then build all three bundles to prove `FileDiffView` (Shiki) inlines into `diff.js`.

**Files:**
- Rewrite: `graph/webview-ui/src/diff/diff-store.svelte.ts`
- Rewrite: `graph/webview-ui/src/diff/messaging.ts`
- Rewrite: `graph/webview-ui/src/diff/Diff.svelte`
- Modify: `graph/webview-ui/src/diff.ts` (unchanged in shape; verify it still mounts)
- Test: `graph/webview-ui/src/diff/__tests__/diff-store.test.ts` (new)
- Test: `graph/webview-ui/src/diff/__tests__/messaging.test.ts` (new)

**Interfaces:**
- Consumes: `DiffData` (`lib/types.ts`), `FileDiffView` (Task 2's `onStageHunk`), `getVsCodeApi()` (`lib/vscode-api.ts`), `i18n` (`lib/i18n/index.svelte`), host messages from Task 1.
- Produces: `diffStore` with `{ repoPath, file, side: 'staged'|'unstaged', diff: DiffData | null, error: string | null, setDiff(repoPath, file, side, diff), reset() }`; `postStageHunk(hunkIndex: number)`; `listenForHostMessages()`.

- [ ] **Step 1: Add the failing store test**

Create `graph/webview-ui/src/diff/__tests__/diff-store.test.ts`:

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
  it('setDiff stores the DiffData, file, repo and side', () => {
    diffStore.setDiff('/repo', 'src/a.ts', 'unstaged', sample());
    expect(diffStore.repoPath).toBe('/repo');
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.side).toBe('unstaged');
    expect(diffStore.diff?.hunks.length).toBe(1);
    expect(diffStore.error).toBeNull();
  });

  it('setDiff clears any prior error', () => {
    diffStore.error = 'boom';
    diffStore.setDiff('/repo', 'src/a.ts', 'staged', sample());
    expect(diffStore.error).toBeNull();
    expect(diffStore.side).toBe('staged');
  });

  it('reset clears everything', () => {
    diffStore.setDiff('/repo', 'src/a.ts', 'unstaged', sample());
    diffStore.reset();
    expect(diffStore.diff).toBeNull();
    expect(diffStore.file).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/diff-store.test.ts --project webview`
Expected: FAIL — the current `diffStore` has no `diff` field / `setDiff(repoPath, file, side, diff)` signature (it takes `DiffHunkView[]`).

- [ ] **Step 3: Rewrite `diff-store.svelte.ts`**

```ts
// graph/webview-ui/src/diff/diff-store.svelte.ts
// Webview-side state for the full-tab Diff panel: the current file's DiffData +
// which index side it's on. Its own self-contained bundle (diff.js), separate
// from the graph and commit-box bundles.
import type { DiffData } from '../lib/types';

export type DiffSide = 'staged' | 'unstaged';

class DiffStore {
  repoPath = $state('');
  file = $state('');
  side = $state<DiffSide>('unstaged');
  diff = $state<DiffData | null>(null);
  /** Soft error surfaced when a stage/unstage round-trip fails. */
  error = $state<string | null>(null);

  reset(): void {
    this.repoPath = '';
    this.file = '';
    this.side = 'unstaged';
    this.diff = null;
    this.error = null;
  }

  setDiff(repoPath: string, file: string, side: DiffSide, diff: DiffData | null): void {
    this.repoPath = repoPath;
    this.file = file;
    this.side = side;
    this.diff = diff;
    this.error = null;
  }
}

export const diffStore = new DiffStore();
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/diff-store.test.ts --project webview`
Expected: PASS.

- [ ] **Step 5: Add the failing messaging test**

Create `graph/webview-ui/src/diff/__tests__/messaging.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// getVsCodeApi() calls acquireVsCodeApi() once, memoized. Stub it on the global
// BEFORE importing the module under test so the memoized api uses our spy.
const postMessage = vi.fn();
(globalThis as any).acquireVsCodeApi = () => ({ postMessage, getState: () => undefined, setState: () => undefined });

import { diffStore } from '../diff-store.svelte';
import { listenForHostMessages, postStageHunk } from '../messaging';
import { i18n } from '../../lib/i18n/index.svelte';

beforeEach(() => {
  diffStore.reset();
  postMessage.mockClear();
});

describe('diff messaging', () => {
  it('diffShow populates the store', () => {
    listenForHostMessages();
    const diff = { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] };
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', diff } },
    }));
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.side).toBe('unstaged');
  });

  it('setLocale switches the i18n locale', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setLocale', payload: { locale: 'zh-cn' } },
    }));
    expect(i18n.locale).toBe('zh');
  });

  it('postStageHunk posts diffStageHunk with the current file + side', () => {
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageHunk(2);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'diffStageHunk',
      payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 2 },
    });
  });

  it('an error message for diffStageHunk sets store.error', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.error).toBe('nope');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/messaging.test.ts --project webview`
Expected: FAIL — the current `messaging.ts` exports `postStageHunks` (plural, no arg), uses a raw `acquireVsCodeApi`, and has no `setLocale` handling.

- [ ] **Step 7: Rewrite `messaging.ts`**

```ts
// graph/webview-ui/src/diff/messaging.ts
// Host <-> webview messaging for the full-tab Diff panel. Uses the shared
// memoized getVsCodeApi() (NOT a second raw acquireVsCodeApi) because
// FileDiffView -> ImageDiff also calls getVsCodeApi(), and acquireVsCodeApi()
// may be called only once per webview.
import { diffStore } from './diff-store.svelte';
import { getVsCodeApi } from '../lib/vscode-api';
import { i18n } from '../lib/i18n/index.svelte';

const vscode = getVsCodeApi();

/** Wire the extension -> webview message handler. Call once at boot. */
export function listenForHostMessages(): void {
  window.addEventListener('message', (e) => {
    const msg = (e as MessageEvent).data;
    switch (msg?.type) {
      case 'diffShow':
        diffStore.setDiff(msg.payload.repoPath, msg.payload.file, msg.payload.side, msg.payload.diff);
        break;
      case 'setLocale':
        if (msg.payload?.locale) { i18n.setLocale(String(msg.payload.locale)); }
        break;
      case 'error':
        if (msg.payload?.source === 'diffStageHunk') {
          diffStore.error = String(msg.payload.message ?? '操作失敗');
        }
        break;
    }
  });
}

/** Post a single hunk to the host; side decides stage vs unstage. */
export function postStageHunk(hunkIndex: number): void {
  if (!diffStore.diff) { return; }
  diffStore.error = null;
  vscode.postMessage({
    type: 'diffStageHunk',
    payload: {
      repoPath: diffStore.repoPath,
      file: diffStore.file,
      side: diffStore.side,
      hunkIndex,
    },
  });
}
```

- [ ] **Step 8: Run the messaging test to verify it passes**

Run: `cd graph && npx vitest run webview-ui/src/diff/__tests__/messaging.test.ts --project webview`
Expected: PASS.

- [ ] **Step 9: Rewrite `Diff.svelte` to render `FileDiffView` (SBS default)**

```svelte
<!-- graph/webview-ui/src/diff/Diff.svelte -->
<script lang="ts">
  import { diffStore } from './diff-store.svelte';
  import { postStageHunk } from './messaging';
  import { t } from '../lib/i18n/index.svelte';
  import FileDiffView from '../components/commit/FileDiffView.svelte';

  const store = diffStore;
  // Default side-by-side; own the toggle locally (PrView pattern) so we can pass
  // diffMode + hideModeToggle to FileDiffView while still letting the user flip.
  let mode = $state<'inline' | 'side-by-side'>('side-by-side');
</script>

<div class="diff-app-root">
  {#if !store.diff}
    <p class="empty">{t('file.openChanges')}</p>
  {:else}
    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}
    <div class="mode-bar">
      <span class="side-badge {store.side}">{store.side === 'staged' ? 'Staged' : 'Unstaged'}</span>
      <div class="diff-mode-toggle">
        <button class:active={mode === 'inline'} onclick={() => { mode = 'inline'; }}>{t('details.inline')}</button>
        <button class:active={mode === 'side-by-side'} onclick={() => { mode = 'side-by-side'; }}>{t('details.sideBySide')}</button>
      </div>
    </div>
    <FileDiffView
      diff={store.diff}
      staged={store.side === 'staged'}
      diffMode={mode}
      hideModeToggle
      onStageHunk={({ hunkIndex }) => postStageHunk(hunkIndex)}
    />
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
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family); flex-shrink: 0;
  }
  .side-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .diff-mode-toggle { display: flex; gap: 2px; background: rgba(128,128,128,0.15); border-radius: 3px; padding: 1px; }
  .diff-mode-toggle button {
    padding: 2px 8px; font-size: 0.75em; border-radius: 2px;
    background: transparent; color: var(--vscode-descriptionForeground); border: none; cursor: pointer;
  }
  .diff-mode-toggle button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style>
```

> **Note:** `FileDiffView` fills its flex parent (`flex: 1; min-width: 0`), so `.diff-app-root` gives it a full-height column. The `codicon` classes render via the panel's `codicon.css` (loaded in `DiffPanel.getHtml`).

- [ ] **Step 10: Verify `diff.ts` is unchanged and still mounts**

Confirm `graph/webview-ui/src/diff.ts` still reads:

```ts
import { mount } from 'svelte';
import Diff from './diff/Diff.svelte';
import { listenForHostMessages } from './diff/messaging';

listenForHostMessages();
mount(Diff, { target: document.getElementById('diff-app')! });
```

No change needed (the `#diff-app` target matches `DiffPanel.getHtml`).

- [ ] **Step 11: Type-check the webview**

Run: `cd graph/webview-ui && npm run check`
Expected: PASS (0 errors) — proves `Diff.svelte`'s `FileDiffView` props type-check and the store/messaging types line up.

- [ ] **Step 12: Build all three bundles (proves FileDiffView + Shiki inline into diff.js)**

Run: `cd graph/webview-ui && npm run build`
Expected: SUCCESS — `dist/main.js`, `dist/workbench.js`, `dist/diff.js` all emitted; no rollup error about a shared chunk. `diff.js` grows substantially (Shiki grammars inlined) — expected. Confirm: `ls -la graph/webview-ui/dist/diff.js` shows a non-trivial size (hundreds of KB).

- [ ] **Step 13: Run the full webview suite (no regression)**

Run: `cd graph && npx vitest run --project webview`
Expected: PASS (`Tests … passed`), including the FileDiffView + new diff store/messaging tests.

- [ ] **Step 14: Commit**

```bash
git add graph/webview-ui/src/diff/diff-store.svelte.ts \
        graph/webview-ui/src/diff/messaging.ts \
        graph/webview-ui/src/diff/Diff.svelte \
        graph/webview-ui/src/diff/__tests__/diff-store.test.ts \
        graph/webview-ui/src/diff/__tests__/messaging.test.ts
git commit -m "feat(B-2c)：diff bundle 複用 FileDiffView，side-by-side + Shiki 全分頁 Diff"
```

---

## Task 4: End-to-end wiring verification

Deliverable: the host bundle picks up the graph changes, the full build passes, and the runtime path is verified by hand (F5) and by `verify-webview-ui`. No new code — this task is the honest "compile ≠ works" gate the brief demands.

**Files:** none (verification only).

- [ ] **Step 1: Full host + webview build**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build`
Expected: SUCCESS — `build:host` (esbuild) pulls `graph/src/extension.ts` (incl. `DiffPanel`) into `dist/extension.js`; `copy-graph-assets` copies `diff.js`/`diff.css` into `dist/graph-webview/`.
Confirm the new panel shipped: `grep -c "snipcode.diffPanel" dist/extension.js` returns ≥ 1.
Confirm the side view is gone from `package.json`: `grep -c '"snipcode.diff"' package.json` returns `0`.

- [ ] **Step 2: Host unit tests (root)**

Run: `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm test`
Expected: PASS (`pass N, fail 0`) — root host tests are unaffected; this confirms the build/compile didn't break packaging.

- [ ] **Step 3: Manual F5 checklist (Extension Development Host)**

Launch the extension (F5). In the Snipcode Git container, confirm:
1. The container shows only **Changes** + **Commit** (no **Diff** side view).
2. Clicking an **unstaged** file opens a full editor tab titled `Diff: <basename>`, showing a **side-by-side** Shiki-highlighted diff.
3. Hovering a hunk reveals a **Stage Hunk** button (inline header and/or SBS overlay); clicking it stages that hunk → the tree refreshes (file moves toward Staged) and the tab reloads the file's remaining unstaged diff.
4. Clicking a **staged** file shows **Unstage Hunk**; clicking unstages that hunk.
5. Clicking a second file **reuses/retitles the same tab** (no tab pile-up).
6. Toggling **Inline / Side by Side** in the tab works.
7. A stage failure surfaces a red banner in the tab + an error toast.

- [ ] **Step 4: verify-webview-ui screenshot**

Use the `verify-webview-ui` skill to render the `diff.js` panel (side-by-side, a multi-hunk sample) headless and screenshot it. Confirm: two panes align, syntax colors apply, and the Stage/Unstage button is visible on hover. Fix any layout regression before proceeding.

- [ ] **Step 5: Commit (only if Step 3/4 surfaced fixes)**

```bash
git add -A
git commit -m "fix(B-2c)：修正全分頁 Diff 手動驗證發現的問題"
```

---

## Self-Review

**1. Spec coverage (against the B-2c brief):**
- Diff in an editor-tab WebviewPanel, full width, `diffMode='side-by-side'` default → Task 1 (`DiffPanel`, `ViewColumn.Active`) + Task 3 (`Diff.svelte` `mode='side-by-side'`). ✅
- Reuse `FileDiffView` (side-by-side + Shiki + per-hunk) → Task 3 (`Diff.svelte` imports the real component). ✅
- SNIPCODE-HOOK stage callback (`onStageHunk`), label by side, v1 per-hunk only → Task 2, fenced; label from `staged`; no `onStageLines`. ✅
- Line-level UI disabled in v1 → in the stage panel `onReverse`/`commitHash` are not passed, so `canReverse` is false and the gutter line-selection never activates; only `canStage` per-hunk buttons render. ✅
- Host routes stage/unstage through existing `ChangesWorkbench.stageHunks/unstageHunks` → Task 1 handler calls them with `[hunkIndex]`; they already `refreshIfCurrent` the panel. ✅
- Refresh tree + reload the file's diff, race-guarded → `ChangesWorkbench.stageHunks` does `refresh()` then `diffPanel.refreshIfCurrent`; `DiffPanel` uses `SequenceGuard` in `push`. ✅
- Remove the side Diff view → Task 1 deletes `diff-view.ts`, drops the `snipcode.diff` registration + `package.json` view. ✅
- Build: three self-contained bundles unchanged in shape (`diff.js` still single-entry `inlineDynamicImports`) → Task 3 Step 12 builds all three. ✅
- v2 fences (line-level staging, changelist, copy-diff, dynamic repo re-wiring, images) → left out; called out below. ✅

**2. Placeholder scan:** No `TBD`/`TODO`/"add error handling". The one placeholder import in Task 1 Step 1 is explicitly corrected in Step 2. Every code step carries complete code. Error handling is concrete (try/catch → `error` message with `source: 'diffStageHunk'` → red banner). ✅

**3. Type consistency:** `onStageHunk: (target: { file: string; hunkIndex: number }) => void` is identical in the FileDiffView prop (Task 2), the `Diff.svelte` callsite (`onStageHunk={({ hunkIndex }) => postStageHunk(hunkIndex)}`, Task 3), and the host handler (`diffStageHunk` payload `{ repoPath, file, side, hunkIndex }`, Task 1). `ChangeGroup = 'staged' | 'unstaged'` matches `DiffSide` in the store. `fileDiffData(...): Promise<DiffData | null>` returns exactly what `DiffPanel.push` posts and `diffShow`/`setDiff` consume. `stageHunks(repoPath, file, hunkIndices: number[])` is called with `[Number(hunkIndex)]` — matches the existing signature. ✅

**4. v2 deferred (explicit):**
- **Line-level staging** — `buildForwardPatch` has no `lineIndices`; no `onStageLines`.
- **Image/binary diffs** — `FileDiffView` renders `ImageDiff` for `isImage`, which posts `getImageAtRef` that `DiffPanel` does NOT handle (only `MainPanel` does). v1: an image file's diff shows the `ImageDiff` shell without image bytes. v2: add a `getImageAtRef` handler to `DiffPanel` (reuse `GitService`), or gate image files out of the panel. No crash — `ImageDiff` only instantiates for `isImage`, and it acquires the API via the same memoized `getVsCodeApi()`.
- **changelist, copy-diff, dynamic repo re-wiring** — out of scope, untouched.

**5. FileDiffView-in-an-independent-bundle investigation (the brief's key question):**

**Conclusion: reuse is viable directly, with ONE mandatory adjustment — the diff bundle must acquire the VS Code API via the shared memoized `getVsCodeApi()`, not a second raw `acquireVsCodeApi()`.** Evidence gathered by reading the actual files:

- **Shiki works in a self-contained bundle.** `lib/utils/highlighter.ts` uses `createHighlighterCore` + `createJavaScriptRegexEngine` (pure JS, **no wasm**) and dynamic `import()`s per grammar/theme. `vite.diff.config.ts` already sets `inlineDynamicImports: true` + `assetsInlineLimit: 100000` + `cssCodeSplit: false`, so the grammars inline into one `diff.js`. This is already proven in production: the graph `main.js` bundle ships `FileDiffView` (via `CommitDetails`/`PrView`) with Shiki and boots fine as a classic script. Cost: a larger `diff.js` — acceptable.
- **i18n works.** `lib/i18n/index.svelte.ts` `t()` defaults to English with no init needed; `zh`/`ko` require `i18n.setLocale(...)`. Wired via `DiffPanel.postLocale` → `setLocale` message → `messaging.ts` calls `i18n.setLocale`. Not a blocker.
- **The one real hazard — a hidden dependency — is `ImageDiff`.** `FileDiffView` imports `common/ImageDiff.svelte`, which imports `getVsCodeApi()` from `lib/vscode-api.ts`. `getVsCodeApi()` memoizes and calls `acquireVsCodeApi()` exactly once, and it pulls in `lib/stores/ui.svelte` (`uiStore`). The **current** diff bundle (`diff/messaging.ts`) calls a raw `acquireVsCodeApi()` at module top. If both existed, the second `acquireVsCodeApi()` throws (single-call rule) and blanks the panel the moment an image diff renders. **Fix (adopted in Task 3): route the diff bundle's messaging through `getVsCodeApi()` too**, so there is exactly one memoized acquire shared by messaging and `ImageDiff`. This pulls `uiStore` into the bundle — harmless (self-contained `$state`), and the bundle stays self-contained (no top-level cross-bundle chunk).
- **No graph store beyond `uiStore`** rides along: `FileDiffView` itself imports only types, `svelte`, `lib/i18n`, `lib/utils/highlighter`, and `ImageDiff`; the only store dependency is the `uiStore` reached transitively through `getVsCodeApi()`.

So: **direct reuse, no need to copy the render core** — the only code change on the graph side is the SNIPCODE-HOOK `onStageHunk` addition (Task 2), and the only bundle-level requirement is "use `getVsCodeApi()`" (a Global Constraint).

**Points that still need F5 / verify-webview-ui (compile can't prove them):**
- The SBS overlay Stage button positions correctly and is reachable over the two scrolling panes (`.sbs-stage-btn` absolute over a `position: relative` `.sbs-hunk`).
- `diff.js` actually boots under the real nonce CSP with Shiki inlined (bundle size / classic-script parse) — the boot-handshake failure mode from AGENTS.md only shows at runtime.
- Retitle/reveal reuses one tab (singleton) rather than spawning tabs, and `retainContextWhenHidden` keeps scroll/highlight on refresh.
- Post-stage refresh actually re-pushes the shrunken diff to the same tab (SequenceGuard + `refreshIfCurrent` timing).

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-commit-workbench-B2c-fulltab-diff.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
