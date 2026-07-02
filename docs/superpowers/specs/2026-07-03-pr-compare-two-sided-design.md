# PR tab — 兩邊分支可選 + 方向交換

日期:2026-07-03
狀態:已批准

## 目標
把 Git Graph+ PR tab 的頂部升級成 GitHub compare 頁頭部:base 與 head **兩邊都能自由選分支**,中間箭頭變成**可交換方向**的 swap 按鈕。目前 head 寫死 `'HEAD'`;改成可選,預設目前 checked-out 分支。

## 現況(PrView.svelte)
- base 下拉可選任意 branch;head 只顯示 `branchStore.currentBranch`(唯讀),`getCommitsBetween`/copy `hash`/`openDiff` `ref2` 全寫死 `'HEAD'`;中間是單向 `codicon-arrow-right`。
- host `commitsBetween(base, head)` **已接受 head 參數**——純 webview 改動即可。

## 改動(全在 PrView.svelte,SNIPCODE-HOOK)
1. **head 可選**:新增 `head` state(預設 `currentBranch.name`),加 head pill + 下拉(複製現有 base 下拉 markup),列同一份 `branchStore.branches`。
2. **swap 按鈕**:中間 `arrow-right` 改成可點的 swap(`codicon-arrow-swap` 或 arrow-right + onclick),交換 `base` ↔ `head` 後重新比對。
3. **移除寫死 `'HEAD'`**:`loadCommits` 送 `head`;`copyAll` 的 `hash` 用 `head`;`openFile` 的 `ref2` 用 `head`。
4. **重新比對觸發**:選 base、選 head、swap 任一 → 重新 `loadCommits`(沿用既有 requestId 防 stale)。
5. **橫幅**:`ahead`/`behind` 是 `base...head` 計數,swap/改 head 後自然反映方向;文字沿用 `pr.aheadInfo`/`pr.behindWarning`(相對 `base`)。

## 不動
- host(commitsBetween/compareCommits/copy 已吃 head 參數)、clipboardFormat.ts/graphCopy.ts 格式契約、three-dot merge-base 邏輯、repo-switch/stale-response guard(既有,head 加入後仍適用)。

## 預設決策
- head 預設 = current branch name(非 `'HEAD'` symbolic,顯示更明確;commitsBetween 用具體 ref 一樣可跑)。
- 兩下拉都列全部 branches(local + remote)。
- copy 讀 head 分支的 committed 內容(與現況 hash='HEAD' 行為一致)。
- base === head 時:清單為空、ahead/behind = 0(合理;不特別擋)。

## 邊界/錯誤
- head 為 null(無分支)時比照 base:不比對;swap 在任一為 null 時 no-op。
- repo 切換:既有 `awaitingBranches` guard 重置 base;head 也需一併重置為新 repo 的 current branch。

## 測試
- 更新 `PrView.test.ts`:head 下拉選擇、swap 交換 base/head 並送正確 `getCommitsBetween`(base/head 對調)、copy/openDiff 帶正確 head、repo 切換重置 head。
- `cd graph && npx vitest run` 綠 + `npm run build` + 根 build/test 綠。

## 發布
0.3.24 patch。
