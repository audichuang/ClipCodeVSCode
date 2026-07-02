# PR tab inline diff Implementation Plan

**Goal:** PR tab Files 子頁內嵌顯示 diff(複用 FileDiffView)+ inline/side-by-side 切換 + ↑/↓ 跳變更。

**Architecture:** host `commitsBetween` 多回 `diffs: DiffData[]`;FileDiffView 加向後相容的 `diffMode`/`hideModeToggle` prop;PrView Files 子頁 stacked 渲染 FileDiffView + toolbar toggle + prev/next scroll。

## Global Constraints
- graph vitest + builds 綠:`cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run`(baseline 1859 pass)、`cd graph && npm run build`、根 `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build` + `npm test`(103 pass)。判斷看 pass/fail 文字,非 pipe exit code。
- 所有 graph/ 改動包 `/* SNIPCODE-HOOK start ... */ ... /* SNIPCODE-HOOK end */`。
- **FileDiffView 改動必須向後相容**:CommitDetails 現有用法(不傳 diffMode/hideModeToggle)行為完全不變(維持 local $state + 內建 toggle)。
- 不改 clipboardFormat.ts / graphCopy.ts / copy 格式;不撞 CommitDetails 的 `commitDiffData` channel(PrView 只用 `commitsBetween`)。
- 保留既有 requestId stale-guard + awaitingBranches repo-switch guard。Svelte 5 runes。
- 分支 dev,commit,不 push;保留使用者 uncommitted graph/CLAUDE.md + package-lock.json。

## 檔案結構
- Modify(host,SNIPCODE-HOOK): `graph/src/git/git-service.ts`(commitsBetween 加 diffs)、`graph/src/utils/message-bus.ts`(commitsBetween payload 加 diffs)、`graph/src/panels/MainPanel.ts`(傳遞)。
- Modify(webview,SNIPCODE-HOOK): `graph/webview-ui/src/components/commit/FileDiffView.svelte`(diffMode/hideModeToggle prop)、`graph/webview-ui/src/components/pr/PrView.svelte`(內嵌 diff + toolbar)。
- 測試:git-service test、PrView.test.ts、(FileDiffView 若有 test 則補向後相容案例)。

---

### Task D1: host `commitsBetween.diffs` + FileDiffView `diffMode` prop

**Files:**
- Modify: `graph/src/git/git-service.ts`, `graph/src/utils/message-bus.ts`, `graph/src/panels/MainPanel.ts`, `graph/webview-ui/src/components/commit/FileDiffView.svelte`
- Test: graph vitest(git-service commitsBetween 回 diffs;FileDiffView prop 向後相容若有元件測試)

**Host — commitsBetween.diffs:**
- `git-service.ts` `commitsBetween(base, head)`(現於 ~:1718-1779,已跑 `git diff -M -z --name-status <mergeBase ?? base> head` 得 files):再跑 `git diff -M --no-color <mergeBase ?? base> head` → 既有 `parseDiff`(git-parser,與 `diffCommits` 用的同一個)→ `diffs: DiffData[]`。回傳型別加 `diffs`。全 try/catch,失敗回 `diffs: []`。用與 files 相同的 `mergeBase ?? base` 起點(three-dot 一致)。
- `message-bus.ts`:`commitsBetween` ExtensionMessage payload(~:205-213)加 `diffs: DiffData[]`(import DiffData 型別)。
- `MainPanel.ts` `getCommitsBetween` case(~:547-553):把 gitService 回的 `diffs` 一併放進 post payload。

**Webview — FileDiffView 向後相容 prop:**
- `FileDiffView.svelte`:Props(~:33-53)加 `diffMode?: 'inline' | 'side-by-side'` 與 `hideModeToggle?: boolean`。
- local `let diffMode = $state(...)`(~:232)改為:若外部有傳 `diffMode` prop 則用受控值(以 prop 為準),否則維持 local `$state('inline')`。實作建議:`let internalMode = $state<'inline'|'side-by-side'>('inline'); const mode = $derived(diffModeProp ?? internalMode);` 模板改用 `mode`;內建 toggle 的 onclick 在受控(prop 有值)時改為 no-op 或不渲染;`hideModeToggle` 為 true 時不渲染 `.diff-mode-toggle`(:356-365)。
- **關鍵**:不傳 prop 的既有 CommitDetails 呼叫必須行為不變(local toggle 照舊)。

- [ ] **Step 1(TDD):** git-service 測試:`commitsBetween` 回的物件含 `diffs`(非空、對應變更檔;可用臨時 repo 或既有 fixture 風格)。先 FAIL。
- [ ] **Step 2:** `cd graph && npx vitest run` → 新測試 FAIL。
- [ ] **Step 3:** 實作 host diffs + FileDiffView prop(SNIPCODE-HOOK)。
- [ ] **Step 4:** `cd graph && npx vitest run` 綠(>=1859+新, 0 fail)+ `npx svelte-check` 無錯 + `cd graph && npm run build` OK。確認既有 FileDiffView/CommitDetails 測試仍過(向後相容)。
- [ ] **Step 5:** commit `feat(graph): commitsBetween returns parsed diffs + FileDiffView controllable diffMode`(不 push)。

---

### Task D2: PrView 內嵌 diff + inline/sbs toggle + prev/next nav

**Files:**
- Modify: `graph/webview-ui/src/components/pr/PrView.svelte`
- Test: `graph/webview-ui/src/components/pr/__tests__/PrView.test.ts`

**Consumes(Task D1):** `commitsBetween.diffs: DiffData[]`;`FileDiffView` 的 `diffMode`/`hideModeToggle` prop。

**行為:**
- PrView `$state` 加 `diffs: DiffData[]`(存 `commitsBetween` payload 的 diffs)+ `diffMode = $state<'inline'|'side-by-side'>('inline')`。`commitsBetween` handler(~:207-227)一併存 `diffs = msg.payload.diffs ?? []`(在既有 requestId guard 內)。
- Files 子頁(現 ~:302-321 清單):改為左側檔案清單(保留,點擊 → `scrollIntoView` 到右側對應檔)+ 右側 stacked 渲染:對每個 file,找 `diffs.find(d => d.file === file.path)`,有則 `<FileDiffView diff={d} stacked diffMode={diffMode} hideModeToggle heading={file.path} />`;無(binary/找不到)顯示佔位列 + 「Open native diff」。import FileDiffView from '../commit/FileDiffView.svelte'。
- toolbar(`.pr-subtabs` ~:287-300,Files 子頁時):加 **inline/side-by-side segmented 控制**(綁 `diffMode`,markup 仿 FileDiffView `.diff-mode-toggle` :356-365)+ **↑/↓ 按鈕**(prev/next)。Copy Full Source 按鈕保留。
- prev/next:`function jumpChange(dir: 1 | -1)`:`const container = <.pr-content el ref>; const hunks = [...container.querySelectorAll('.diff-hunk, .sbs-hunk')]`;依 `container.scrollTop` 找下一個(dir=1:第一個 offsetTop > scrollTop+ε)/上一個,`el.scrollIntoView({block:'center'})`。用 `bind:this` 取 `.pr-content` 元素。
- 大量檔:一次 stacked 全部(這版不 lazy)。

- [ ] **Step 1(TDD):** PrView.test.ts:選 base 後 `commitsBetween`(帶 diffs)→ 渲染 FileDiffView(可 mock/stub FileDiffView 或斷言 diffs 傳入)、toggle 切 diffMode 傳給 FileDiffView、prev/next 呼叫捲動(可斷言 querySelector/scrollIntoView 被呼叫)。先 FAIL。
- [ ] **Step 2:** `cd graph && npx vitest run` → FAIL。
- [ ] **Step 3:** 實作 PrView 內嵌 diff + toolbar toggle + prev/next(SNIPCODE-HOOK)。
- [ ] **Step 4:** `cd graph && npx vitest run` 綠 + `npx svelte-check` + `cd graph && npm run build` OK。
- [ ] **Step 5:** 根 `npm run build` + `npm test`(103/0)綠。
- [ ] **Step 6:** commit `feat(graph): inline diff preview in PR tab with inline/side-by-side toggle and prev/next-change nav`(不 push)。

---

## Self-Review
- Spec coverage:內嵌 diff(D1 diffs + D2 FileDiffView stacked)/ inline-sbs toggle(D1 prop + D2 toolbar)/ prev-next(D2 scroll)/ 齒輪 out-of-scope(spec 已載明,不做)。✓
- 向後相容:FileDiffView prop optional,CommitDetails 不受影響(D1 constraint + Step 4 驗證)。✓
- 不撞 commitDiffData channel(PrView 只用 commitsBetween);格式/copy 不動。✓
- 型別一致:`DiffData`(types.ts)、`commitsBetween.diffs`(D1↔D2)、FileDiffView `diffMode`/`hideModeToggle`(D1↔D2)。
