# PR compare 兩邊可選 + swap Implementation Plan

**Goal:** PrView 的 head 從寫死 `'HEAD'` 改成可選分支下拉 + 中間 swap 按鈕交換 base↔head,對齊 GitHub compare 頭部。純 webview,host 零改動。

**Architecture:** 只改 `graph/webview-ui/src/components/pr/PrView.svelte`(+ 其 test)。host `commitsBetween(base, head)` 已接受 head 參數。

## Global Constraints
- graph vitest + build 都要綠:`cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run`(baseline 1853 pass)、`cd graph && npm run build`、根 `cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode && npm run build` + `npm test`(103 pass)。判斷看 pass/fail 文字,非 pipe exit code。
- 所有 graph/ 改動包 `/* SNIPCODE-HOOK start ... */ ... /* SNIPCODE-HOOK end */`(PrView.svelte 已是 SNIPCODE 新檔,新增區塊沿用檔內 fence 風格)。
- 不改 host、clipboardFormat.ts、graphCopy.ts。保留既有 requestId stale-guard 與 repo-switch awaitingBranches guard。
- Svelte 5 runes。跟隨 PrView 既有風格。
- 分支 dev,commit,不 push。保留使用者 uncommitted `graph/CLAUDE.md`/`package-lock.json`。

---

### Task: head 可選 + swap(PrView.svelte)

**Files:**
- Modify: `graph/webview-ui/src/components/pr/PrView.svelte`
- Modify: `graph/webview-ui/src/components/pr/__tests__/PrView.test.ts`

**現況參考(PrView.svelte):**
- `base = $state<string|null>(null)`;`selectBase(b)` → `loadCommits(b)`;`loadCommits(newBase)` 送 `{base:newBase, head:'HEAD', requestId}`。
- `copyAll` 送 `{hash:'HEAD', files}`;`openFile` 送 `{ref1: mergeBase ?? base, ref2:'HEAD', oldPath}`。
- 頂部:base pill + 下拉(`branchStore.branches`)、`codicon-arrow-right` icon、head 唯讀 `currentBranch?.name`。
- repo-switch `$effect` 重置 `base=null`;`defaultBase()` 選預設 base;`awaitingBranches` guard。

**行為變更:**
- 新增 `let head = $state<string|null>(null)` + `showHeadDropdown = $state(false)`。
- 新 `defaultHead()`:回 `branchStore.currentBranch?.name ?? null`。
- `loadCommits` 改吃 `(newBase, newHead)`(或讀當前 base/head state);送 `{base, head, requestId}`(head 用選定值,非 'HEAD')。base 或 head 為 null → 不送(清空)。
- `selectBase(b)`/新 `selectHead(h)`:設值後若 base 與 head 皆非 null 則 `loadCommits`。
- `swap()`:`const t=base; base=head; head=t;` 後 `loadCommits`(兩者皆非 null 才做;否則 no-op)。
- `copyAll`:`hash: head ?? 'HEAD'`。
- `openFile`:`ref2: head ?? 'HEAD'`。
- `commitsBetween` handler 的 stale-guard:除 requestId 外,`msg.payload.base !== base` 的防禦性檢查保留;head 主要靠 requestId(不需加 head 到 payload echo,requestId 已足夠;若要更嚴可一併比對,但避免過度)。
- repo-switch `$effect`:重置時 `head = null`(連同 base);default 選擇 `$effect` 加選 default head:`if (!awaitingBranches && head === null && branchStore.branches.length>0) { const dh=defaultHead(); if (dh) head=dh; }`——注意順序:base 與 head 都就緒後才 `loadCommits`(避免只設一邊就送)。建議:base/head 的預設選擇都設好值後,由一個統一判斷「base && head 皆非 null 且尚未載入此組合」才 `loadCommits`,避免重複/半套請求。
- 頂部 UI:base pill(不變)+ 中間改 **swap 按鈕**(`<button class="pr-swap-btn" onclick={swap} title="Swap">`,icon 用 `codicon-arrow-swap`,無此 icon 則 `codicon-arrow-both` 或保留 arrow-right 但可點)+ **head pill + 下拉**(複製 base pill/dropdown markup,綁 head/selectHead/showHeadDropdown)。head pill 顯示 `head ?? currentBranch?.name ?? 'HEAD'`。

- [ ] **Step 1(TDD):** 更新 `PrView.test.ts` 加/改測試(先讓新測試 FAIL):
  - 選 head → 送 `getCommitsBetween` 帶選定 head。
  - `swap` → base/head 對調且送 `getCommitsBetween`(base/head 互換)。
  - `copyAll`/`openFile` 帶選定 head(非寫死 'HEAD')。
  - repo 切換重置 head(不從舊 repo 選)。
  - 保留既有 repo-switch/stale-guard 測試通過。
- [ ] **Step 2:** `cd graph && npx vitest run` → 新測試 FAIL(功能未實作)。
- [ ] **Step 3:** 實作 PrView.svelte 上述變更(SNIPCODE-HOOK)。
- [ ] **Step 4:** `cd graph && npx vitest run` → 綠(>=1853+新測試, 0 fail);`cd graph && npx svelte-check` 無錯。
- [ ] **Step 5:** `cd graph && npm run build` + 根 `npm run build` + `npm test`(103/0)全綠。
- [ ] **Step 6:** commit `feat(graph): PR tab base+head both selectable with swap`(不 push)。

---

## Self-Review
- Spec coverage:head 可選(head state + 下拉)/ swap(swap 按鈕交換 + reload)/ 移除寫死 HEAD(loadCommits/copy/openDiff)/ 橫幅方向(ahead/behind 自然)/ repo-switch 重置 head。✓
- 不動 host/格式/three-dot。✓
- stale-guard/awaitingBranches 保留。✓
