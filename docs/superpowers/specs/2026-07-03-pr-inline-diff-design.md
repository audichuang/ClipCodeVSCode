# PR tab — 內嵌 diff 預覽 + inline/side-by-side 切換 + 上下跳變更

日期:2026-07-03
狀態:已批准(含追加)

## 目標
PR tab 的 Files 子頁從「清單 + 點檔開 native diff」升級成 GitHub Files-changed 內嵌預覽:
1. 右側**內嵌**顯示每個檔的語法高亮 `+/-` diff hunks(複用既有 `FileDiffView.svelte`,stacked)。
2. **inline ⇄ side-by-side** 切換(一個控制,套用到所有 stacked 檔)。
3. **↑/↓ 跳到上一個/下一個變更**(捲動導航)。

## 偵察結論(可行性)
- `FileDiffView.svelte` 是獨立可複用元件:唯一必需 prop `diff: DiffData`,Shiki 語法高亮內建(共用 `highlighter.ts` singleton),已有 inline(`:386-428`)與 side-by-side(`:429-493`)兩種 render,模式目前是元件內 local `$state`(`:232`)+ 內建 toggle(`:356-365`)。
- `DiffData`(`types.ts:126-147`)= 預解析 hunks(非 raw patch)。
- `parseDiff`(git-parser)在 host 把 unified diff 解析成 `DiffData`。
- prev/next 導航、齒輪 diff-settings 目前**皆不存在**。

## Host(`graph/src/`,SNIPCODE-HOOK)— 一處小改
`commitsBetween` 回應多帶 `diffs: DiffData[]`:現已跑 `git diff -M -z --name-status <mergeBase ?? base> HEAD`(檔案清單),再加 `git diff -M --no-color <mergeBase ?? base> HEAD` → `parseDiff` → `diffs`。message-bus `commitsBetween` payload + git-service 回傳各加 `diffs`。走既有 requestId stale-guard、不撞 CommitDetails 的 `commitDiffData` channel、`-M` 讓 diff 文字與清單 rename 一致。

## Webview(PrView.svelte + FileDiffView.svelte,SNIPCODE-HOOK)
- **FileDiffView.svelte**:加 optional prop `diffMode?: 'inline' | 'side-by-side'` + `hideModeToggle?: boolean`。給 prop 時用 prop(取代 local `$state`)並隱藏內建 toggle;不給時維持現有 local 行為 → **CommitDetails 完全不受影響**(向後相容)。
- **PrView.svelte**:
  - Files 子頁:左側保留現有檔案清單(點擊捲到對應 diff)+ 右側依 `commitsBetween.diffs` **stacked 渲染每檔 `<FileDiffView diff stacked diffMode={mode} hideModeToggle />`**(依 path 對應 files↔diffs;找不到 diff 的檔顯示「binary/no preview」)。
  - toolbar(既有 `.pr-subtabs` 列):加 **inline/side-by-side segmented toggle**(`diffMode` $state,套用全部)+ **↑/↓ 按鈕**(prev/next 變更)。
  - prev/next:掃 `.pr-content` 內 `.diff-hunk, .sbs-hunk`(或 `.diff-add, .diff-delete`),依當前 scrollTop 找下/上一個 `scrollIntoView({block:'center'})`。純 PrView 層,不改 FileDiffView DOM。
  - 保留「在 VS Code 開 native diff」當每檔次要入口(可選小按鈕)。

## 範圍外(這版不做)
- **齒輪 diff-settings**(ignore whitespace / word wrap / context 行數):需 host 端 git 參數支援(目前無),超出純 webview 範圍。之後單獨規劃。

## 效能
一次載入全部 diffs(多數 PR 夠快)。超大 PR first-paint 慢再加 lazy per-file(這版不做)。

## 複用(零改動)
`FileDiffView`(加 optional prop 後仍向後相容)、`highlighter.ts` Shiki singleton、`parseDiff`、既有 requestId guard、three-dot merge-base、copy/格式契約不動。

## 測試
- Host:`commitsBetween` 回 `diffs`(git-service 測試,graph vitest)。
- Webview:PrView 渲染 FileDiffView、toggle 切換 diffMode、prev/next 掃 hunk;FileDiffView diffMode prop 向後相容(不給 prop 時 local 行為不變)。`cd graph && npx vitest run` + `npm run build` + 根 build/test 綠。

## 發布
0.3.25 patch。
