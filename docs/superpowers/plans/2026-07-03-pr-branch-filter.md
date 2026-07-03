# PR tab 分支下拉打字過濾 Implementation Plan

**Goal:** PR tab 的 base 與 head 分支下拉,打開後可**打字即時過濾**分支清單(分支多時好找)。併入 0.3.25。

**Architecture:** 純 webview,只改 `graph/webview-ui/src/components/pr/PrView.svelte`(+ 其 test)。case-insensitive 子字串過濾。

## Global Constraints
- graph vitest + builds 綠:`cd /home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph && npx vitest run`(baseline 1875 pass)、`cd graph && npm run build`、根 `npm run build` + `npm test`(103)。判斷看 pass/fail 文字。
- 所有 graph/ 改動包 SNIPCODE-HOOK。只改 PrView.svelte(+ test)。不碰 host/FileDiffView/其他。
- **不要動 working tree 已 pending 的 `package.json`(version bump)與 `CHANGELOG.md`(release 用,我另外 commit);只 stage PrView.svelte + PrView.test.ts。** 保留 graph/CLAUDE.md、package-lock.json 不動。
- 保留既有 base/head 選擇邏輯、requestId stale-guard、awaitingBranches guard、disabled-while-awaitingBranches。Svelte 5 runes。dev,commit,不 push。

## Task: base/head 下拉打字過濾(PrView.svelte)

**現況:** base 下拉(`showBaseDropdown`)與 head 下拉(`showHeadDropdown`)各自 `{#each branchStore.branches as b}` 列全部分支,點 `selectBase`/`selectHead`。無過濾。

**行為變更:**
- 每個下拉(base、head)開啟時,頂部放一個 **filter `<input type="text">`**(placeholder 例如 "Filter branches…"),`bind:value` 到各自的 filter state(`baseFilter`/`headFilter`,`$state('')`)。
- 清單改為 `$derived` 過濾結果:`branchStore.branches.filter(b => b.name.toLowerCase().includes(filter.trim().toLowerCase()))`。空 filter → 全部。
- **開啟下拉時 auto-focus** filter input(讓使用者直接打字);**關閉時清空** filter(下次開重新開始)。用 Svelte action 或 `$effect` + `bind:this` focus。
- 過濾後**無結果**顯示一列 "No matching branches"(用既有 i18n 風格或簡短文字)。
- 鍵盤(可選、加分不強制):Enter 選第一個過濾結果、Esc 關閉。若簡單就加,否則至少滑鼠點選可用。
- 兩個下拉都要(base + head),邏輯對稱。可抽一個小 helper 或各自一份(檔案不大,重複可接受)。
- 維持 `disabled={awaitingBranches}` 與既有 selectBase/selectHead guard。

**注意:** 下拉的 backdrop/點擊外部關閉邏輯要與 filter input 共存(點 input 不關閉;點 backdrop 關閉並清空)。

- [ ] **Step 1(TDD):** PrView.test.ts 加測試(先 FAIL):打開 base 下拉、filter input 打字 → 清單只剩符合的分支;清空/關閉重置 filter;無結果顯示提示;head 下拉同樣。
- [ ] **Step 2:** `cd graph && npx vitest run` → FAIL。
- [ ] **Step 3:** 實作(SNIPCODE-HOOK)。
- [ ] **Step 4:** `cd graph && npx vitest run` 綠 + `npx svelte-check` + `cd graph && npm run build` OK。
- [ ] **Step 5:** 根 `npm run build` + `npm test`(103/0)。
- [ ] **Step 6:** commit(只 PrView.svelte + PrView.test.ts)`feat(graph): type-to-filter branch dropdowns in PR tab`(不 push)。

## Self-Review
- Spec coverage:base+head 下拉打字過濾 / auto-focus / 關閉清空 / 無結果提示。✓
- 只改 PrView,不動 host/其他/pending release 檔。✓
- 保留 guards。✓
