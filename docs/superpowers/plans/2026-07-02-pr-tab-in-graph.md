# Git Graph+ PR tab Implementation Plan

**Goal:** 把 PR 功能搬進 Git Graph+ webview 的第 4 個 tab(取代 SCM TreeView),Files+Commits+落後提示,three-dot,複製走既有 ClipCode 格式。

**Architecture:** 移除 host TreeView;webview 加 PR tab 複用既有 `compareCommits`(Files+diff)、`snipcodeCopyFullSource`(複製)、`getBranches`(base 清單);新增一個 host message `getCommitsBetween`(commit 列表 + merge-base + ahead/behind)。all graph edits fenced with SNIPCODE-HOOK.

**Tech Stack:** Svelte 5 (runes)、Vite、TS、VS Code webview postMessage、git CLI(graph GitService)。

## Global Constraints
- 兩個測試套件都要綠:根 `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm test`(host,baseline 115 pass)**且** `cd graph && npx vitest run`(webview,baseline 1827 pass)。判斷成敗看輸出的 `pass/fail`/`error TS` 文字,NOT pipe exit code。
- **剪貼簿格式跨工具契約**:複製一律走既有 `snipcodeCopyFullSource` → 父層 `src/graphCopy.ts`,不改 `clipboardFormat.ts`/`graphCopy.ts` 格式邏輯。
- **所有 `graph/` 改動用 `/* SNIPCODE-HOOK start … */ … /* SNIPCODE-HOOK end */` 標記**(現有慣例,方便未來 re-sync upstream)。新 UI 盡量放獨立 `PrView.svelte`,少改 `CommitGraph`/`CommitDetails`。
- **three-dot 語意**:PR 的 Files/Commits 用 `base...HEAD`(merge-base..HEAD),與 IntelliJ 端一致。做法:host 算 merge-base 回給 webview,webview 用 `compareCommits(mergeBase, 'HEAD')`(= three-dot),不改 compareCommits 全域語意(graph 選兩 commit 仍 two-dot)。
- Svelte 5 runes(`$state`/`$derived`/`$effect`)。跟隨現有元件風格。
- 分支 `dev`,每 task commit,不 push。

## 檔案結構
- 移除:`src/prPanelView.ts`、`src/prTreeProvider.ts`、`src/branchDiff.ts`、`src/prCopyService.ts`、`test/branchDiff.test.ts`、`test/prCopyService.test.ts`;`package.json`(view/commands/menus)、`src/extension.ts`(registerPrPanel)。
- 新增 host:`graph/src/git/git-service.ts`(commitsBetween)、`graph/src/utils/message-bus.ts`(message)、`graph/src/panels/MainPanel.ts`(case)。
- 新增 webview:`graph/webview-ui/src/components/pr/PrView.svelte`;改 `ui.svelte.ts`、`Toolbar.svelte`、`App.svelte`、`lib/i18n/{en,ko,zh}.ts`。

---

### Task G1: 移除 SCM TreeView PR 面板

**Files:**
- Delete: `src/prPanelView.ts`, `src/prTreeProvider.ts`, `src/branchDiff.ts`, `src/prCopyService.ts`, `test/branchDiff.test.ts`, `test/prCopyService.test.ts`
- Modify: `package.json`(移除 `contributes.views` 的 `clipcode.prPanel`、`contributes.commands` 的 `clipcode.pr.*`、對應 `menus.view/title`+`view/item/context`、任何 `onView:clipcode.prPanel` activation), `src/extension.ts`(移除 `registerPrPanel` import + 呼叫)

**Steps:**
- [ ] **Step 1:** 刪除上列 6 個 src/test 檔。
- [ ] **Step 2:** `package.json`:移除 `clipcode.prPanel` view、所有 `clipcode.pr.*` command 定義、其 menus 條目。grep `clipcode.pr` 確認 package.json 無殘留。**保留**使用者的 `icon` 行與其他既有 contributes。
- [ ] **Step 3:** `src/extension.ts`:移除 `import { registerPrPanel }` 與 `registerPrPanel(context)` 呼叫。**保留** `makeGraphCopyDeps`(graph 的 copyFullSourceAtCommit 仍用它)與其他 wiring。grep `registerPrPanel`/`branchDiff`/`prCopyService`/`prTreeProvider` 確認 src 無 dangling import。
- [ ] **Step 4:** `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm test` → 綠(tsc 無 unresolved,測試數減少但 0 fail)。
- [ ] **Step 5:** commit `refactor: remove SCM TreeView PR panel (moving into Git Graph+ tab)`(不 push)。

---

### Task G2: host `getCommitsBetween`(commit 列表 + merge-base + ahead/behind)

**Files:**
- Modify(SNIPCODE-HOOK): `graph/src/git/git-service.ts`, `graph/src/utils/message-bus.ts`, `graph/src/panels/MainPanel.ts`
- Test: `graph/` vitest(為純解析加測試,比對既有 git-service 測試風格)

**Interfaces:**
```typescript
// git-service.ts (SNIPCODE-HOOK)
// git log base..head → commits;git merge-base base head → mergeBase;
// git rev-list --left-right --count base...head → "<behind>\t<ahead>"
async commitsBetween(base: string, head: string): Promise<{
  commits: Array<{ hash: string; subject: string; author: string; date: string }>;
  mergeBase: string | null;   // null 若無共同祖先(fallback: webview 用 base 當作 two-dot)
  ahead: number;              // head 領先 base
  behind: number;             // head 落後 base
}>
```
指令:`git log --pretty=%H%x00%s%x00%an%x00%aI <base>..<head>`(NUL 分隔,`log()` 的 assertSafeRef 擋 range,故自建 GitLineHandler/exec);`git merge-base <base> <head>`;`git rev-list --left-right --count <base>...<head>`。全 try/catch 回安全預設(空 commits, mergeBase=null, 0/0)。message-bus:`WebviewMessage` 加 `{ type: 'getCommitsBetween'; payload: { base: string; head: string } }`;`ExtensionMessage` 加 `{ type: 'commitsBetween'; payload: { base: string; commits; mergeBase; ahead; behind } }`。MainPanel case 仿 `getMultiCommitSections`(:530-541)呼叫 `gitService.commitsBetween` 後 `this.post(...)`。

**Steps:**
- [ ] **Step 1(TDD 純解析):** 若 commit/rev-list 輸出有可抽出的純解析函式,先寫 vitest 失敗測試(比對既有 graph git-service 測試風格)。
- [ ] **Step 2:** 實作 `commitsBetween`(SNIPCODE-HOOK 包住)、message-bus 兩個 variant(SNIPCODE-HOOK)、MainPanel case(SNIPCODE-HOOK)。
- [ ] **Step 3:** `cd graph && npx vitest run` → 綠(1827+ pass, 0 fail);`cd graph && npx svelte-check`(或 tsc)無型別錯。
- [ ] **Step 4:** commit `feat(graph): add getCommitsBetween host message for PR tab`(不 push)。

---

### Task G3: webview PR tab(PrView + toolbar + router + i18n)

**Files:**
- Create: `graph/webview-ui/src/components/pr/PrView.svelte`
- Modify(SNIPCODE-HOOK): `graph/webview-ui/src/lib/stores/ui.svelte.ts`, `graph/webview-ui/src/components/layout/Toolbar.svelte`, `graph/webview-ui/src/App.svelte`, `graph/webview-ui/src/lib/i18n/en.ts`(+`ko.ts`,`zh.ts`)

**行為與資料流:**
- `ui.svelte.ts`:`viewMode` union(:14)加 `'pr'`;`setViewMode`(:155)同步。
- `Toolbar.svelte`(:157-181):加第 4 個 `<button class="view-tab" class:active={uiStore.viewMode==='pr'} onclick={()=>uiStore.setViewMode('pr')}>{t('toolbar.pr')}</button>`。i18n 三語加 `toolbar.pr`(en: "PR")。
- `App.svelte`(:458-509):加 `{:else if uiStore.viewMode === 'pr'}<PrView />`;import PrView。
- **`PrView.svelte`:**
  - base-ref 下拉:items = `branchStore.branches`(`lib/stores/branches.svelte.ts`),markup 仿 `.repo-dropdown`(Toolbar.svelte:104-153)。標題顯示 `{base} into {branchStore.currentBranch}`。預設 base = current branch 的 upstream 或 `origin/main`(取 branches 中 remote 的)。
  - 選 base(或載入)→ post `{type:'getCommitsBetween', payload:{base, head:'HEAD'}}`;收 `commitsBetween`(persistent message handler,仿 `CommitDetails.svelte:343-361`)存 `$state`(commits, mergeBase, ahead, behind)。
  - **落後橫幅**:`behind>0` → 「⚠ 落後 base {behind} 個 commit」;`ahead` 顯示領先數。
  - 拿到 `mergeBase` 後 → post `{type:'compareCommits', payload:{ref1: mergeBase ?? base, ref2:'HEAD'}}`(three-dot via merge-base);收 `commitDiffData`(`files[]`+`diffs`)存 `$state`。
  - **子 tab Files / Commits**(預設 Files):
    - Files:渲染 `files[]`(檔案樹或清單,可複用 `buildFileTree` 或簡單 render `{status} {path}`);點檔 post `{type:'openDiff', payload:{file, ref1: mergeBase ?? base, ref2:'HEAD'}}`。
    - Commits:渲染 `commits[]`(hash 短碼 + subject + author + date)。
  - **Copy 按鈕**:把 `files[]` map 成 `{repoRootFsPath, relativePath, oldRelativePath, status}` → post `{type:'snipcodeCopyFullSource', payload:{hash:'HEAD', files}}`(複用 `CommitDetails.svelte:512-524` 的 `snipcodeCopyFiles` 模式;`repoRootFsPath` 從現有 repo 狀態取,見 CommitDetails 怎麼拿)。空 files → 停用/提示。
  - 全部包 SNIPCODE-HOOK(PrView 為新檔,檔頭一個 hook 註記即可)。

**Steps:**
- [ ] **Step 1:** `ui.svelte.ts` + `Toolbar.svelte` + i18n 加 tab(SNIPCODE-HOOK);`App.svelte` router 分支。
- [ ] **Step 2:** 建 `PrView.svelte`,先接 base 下拉 + getCommitsBetween + 落後橫幅 + Commits 子 tab。
- [ ] **Step 3:** 接 Files 子 tab(compareCommits via mergeBase + 檔案清單 + openDiff)+ Copy(snipcodeCopyFullSource)。
- [ ] **Step 4:** `cd graph && npx vitest run` 綠 + `npx svelte-check` 無錯 + `cd graph && npm run build`(vite build webview,必須成功)。
- [ ] **Step 5:** 根 `npm run build`(host+graph bundle)+ `npm test` 綠。
- [ ] **Step 6:** commit `feat(graph): add PR tab to Git Graph+ webview (replaces SCM tree view)`(不 push)。

---

## Self-Review
- Spec coverage:取代 TreeView(G1)/ base 下拉+Files+diff+複製(G3 複用 compareCommits+snipcodeCopyFullSource)/ Commits 列表(G2+G3)/ 落後提示(G2 ahead/behind + G3 橫幅)/ three-dot(G2 mergeBase + G3 用 mergeBase 餵 compareCommits)。✓
- SNIPCODE-HOOK 要求寫入 Global Constraints + G2/G3 每個 graph 改動。✓
- 格式契約:複製走 snipcodeCopyFullSource,不改格式檔。✓
- 型別一致:`commitsBetween` 回傳型別(G2)、message `getCommitsBetween`/`commitsBetween`(G2↔G3)、`compareCommits`/`commitDiffData`/`snipcodeCopyFullSource`(既有)於各 task 一致。
