# PR tab 檔案列表/diff 可拖動分隔 Implementation Plan

**Goal:** PR tab Files 子頁的左側檔案列表與右側 diff 之間,加一條可拖動的 resize handle 調整寬度(目前寫死)。併發 0.3.26。

**Architecture:** 純 webview,只改 `graph/webview-ui/src/components/pr/PrView.svelte`(+ test)。複用 CommitDetails 的 resize 模式。

## Global Constraints
- graph vitest + builds 綠:`cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run`(baseline 1885 pass)、`cd graph && npm run build`、根 `npm run build` + `npm test`(103)。判斷看 pass/fail 文字。
- 只改 PrView.svelte(+ PrView.test.ts)。不碰 host/FileDiffView/CommitDetails/其他。所有 graph/ 改動包 SNIPCODE-HOOK。
- 保留既有 base/head 選擇、requestId guard、awaitingBranches guard、diff toggle、prev/next nav、branch filter。Svelte 5 runes。dev,commit,不 push。保留使用者 uncommitted graph/CLAUDE.md、package-lock.json。

## Task: 可拖動分隔(PrView.svelte)

**現況:** Files 子頁 `.pr-files-layout`(~:617,flex row)= `.pr-file-list`(~:618,左,CSS width 寫死於 ~:961)+ `.pr-diff-stack`(~:626,右)。無 resize。

**參考複用:** CommitDetails.svelte 的 resize 模式:`let filesPanelWidth = $state(240)`(:190)、`startResize(e)`(:224-237,記 resizeStartWidth/StartX → document mousemove 算 delta → `Math.min(480, Math.max(120, resizeStartWidth + delta))` → mouseup 移除 listener)、`.files-panel style="width:{...}px"`(:913)、`.resize-handle onmousedown={startResize}`(:1361)。

**行為變更(仿上):**
- 加 `let fileListWidth = $state(240)`(與現有 CSS 寫死寬度一致的預設)+ resize 起始暫存變數。
- 加 `startResize(e: MouseEvent)`:`e.preventDefault()`;記 `resizeStartWidth = fileListWidth`、`resizeStartX = e.clientX`;掛 `document` 的 `mousemove`(`fileListWidth = Math.min(600, Math.max(120, resizeStartWidth + (e.clientX - resizeStartX)))`)與 `mouseup`(移除兩個 listener)。cleanup:元件卸載時也移除(onDestroy 或既有 return)。
- markup:`.pr-file-list` 改 `style="width:{fileListWidth}px; flex-shrink:0;"`;在 `.pr-file-list` 與 `.pr-diff-stack` 之間插 `<div class="pr-resize-handle" onmousedown={startResize} role="separator" aria-orientation="vertical"></div>`;`.pr-diff-stack` 保持 `flex:1; min-width:0;`。
- CSS:`.pr-resize-handle`(width ~5px、cursor col-resize、hover/active 高亮,仿 `.resize-handle` :1826-1836);`.pr-files-layout` 維持 flex row。
- clamp 120-600px。比照 CommitDetails **不持久化**。

- [ ] **Step 1(TDD 可測部分):** PrView.test.ts:startResize 純邏輯可測則測(給定起始寬度 + mousemove delta → fileListWidth 更新且 clamp 在 120-600);或至少斷言 resize handle 存在、拖動改變 `.pr-file-list` 寬度。先 FAIL。(拖動涉 DOM/document listener;若難純測,至少測 clamp 計算函式或 handle 渲染。)
- [ ] **Step 2:** `cd graph && npx vitest run` → FAIL。
- [ ] **Step 3:** 實作(SNIPCODE-HOOK)。
- [ ] **Step 4:** `cd graph && npx vitest run` 綠 + `npx svelte-check` + `cd graph && npm run build` OK。
- [ ] **Step 5:** 根 `npm run build` + `npm test`(103/0)。
- [ ] **Step 6:** commit(只 PrView.svelte + PrView.test.ts)`feat(graph): resizable splitter between PR file list and diff`(不 push)。

## Self-Review
- Spec coverage:file-list/diff 可拖動 resize / clamp / cursor 提示。✓
- 只改 PrView,複用 CommitDetails 模式,不動其他。✓
- listener cleanup(mouseup + 元件卸載)避免洩漏。✓
