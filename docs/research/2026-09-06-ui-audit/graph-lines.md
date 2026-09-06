# Snipcode commit graph 線圖審查報告（只讀）

## 0. 方法與證據

- 程式碼：`/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/src/git/git-graph-builder.ts`、`graph/webview-ui/src/components/graph/CommitGraph.svelte`（script 1–700、SVG 1455–1506、rows 1509–1712、`<style>` 2001–2656）、`graph/src/git/git-service.ts` log()、`graph/src/panels/MainPanel.ts`、`graph/webview-ui/src/styles/global.css`、color 三檔 + store、`graph/package.json` 設定。
- **截圖已看五張**（scratchpad）：`graph-dark.png`、`graph-light.png`（1400×900）、`graph-dark-2x.png`（2800×1800）、`graph-narrow-dark.png`（900×700）、`graph-dark-details.png`（含選取列）。以下每條標「截圖」或「程式碼推導」。
- 上游對照（raw GitHub 抓取，經摘要，僅引用承載論點的常數）：SourceGit `src/Models/CommitGraph.cs` / `src/Views/CommitGraph.cs`；IntelliJ `platform/vcs-log/impl/src/com/intellij/vcs/log/paint/PaintParameters.java`、`SimpleGraphCellPainter.kt`、`graph/GraphColorManagerImpl.kt`；另有 scratchpad `reports/jetbrains-baseline.md`（官方 Help 逐字核對）。
- 全部改動點都在 vendored `graph/` 內（host 端 `git-graph-builder.ts` 也是），**一律需 `/* SNIPCODE-HOOK start/end */` 圍欄**，下文不再逐條重複。

---

## 1. 現況描述：線圖的視覺語言與量到的數字

**版面演算法**（SourceGit port，host 端執行，`MainPanel.ts:172–180` → postMessage 到 webview）：`UNIT_W=12`（builder:270），webview `X_SCALE=1.05`（svelte:339）→ **車道間距 12.6px**。`global.css:36` 的 `--lane-width: 14px` 全 repo 只有定義沒有引用（grep 唯一命中），是死變數，實際間距由 `laneX()`（svelte:525）決定。列高 `ROW_HEIGHT=30`（svelte:334）、字 13px。message 起點每列不同：`commitLeftMargin = max(offsetX, maxOffsetOld) + 8`（builder:419）× 1.05 + 4 → 隨當列車道數位移（截圖可見 merge 列 message 比上下列縮排更深）。

**線**：每條 rail 畫兩層 `<path>`：`stroke-width=5 opacity=0.07` + `stroke-width=2 opacity=0.85`（svelte:1465–1466）；merge link 同樣兩層二次曲線（1479–1487）。`buildPathD`（svelte:41–75）：同 X 直線 `L`、往右 `Q`、往左中段 `C`（±4px S 曲線）、末段 `Q`。**光暈算過：** 綠 `#73d13d` 5px@0.07 疊在 `#1e1e1e` 上得 `#242b20`，對比 **1.14:1**；粉 1.09:1；白底 1.05–1.08:1 → 低於可辨門檻，五張截圖裡都看不到（截圖證實）。

**點**（svelte:1495–1504）：一般 `r=4` 實心；merge `r=4` 空心 stroke 1.5 + `r=2` 實心；HEAD `r=5` 空心 stroke 2（外徑 6）；UNCOMMITTED `r=5` 灰虛線圈。空心點的 fill 是 `var(--bg-primary)`（編輯器底色）。

**幾何餘裕**（算）：dot(r4)→鄰道 2px 線淨空 **7.6px**；dot→dot 4.6px；HEAD 環(外徑 6)→鄰線 5.6px。IntelliJ：`WIDTH_NODE=16`、`CIRCLE_RADIUS=4`、`THICK_LINE=1.5`、`SELECT_THICK_LINE=2.5`、`ROW_HEIGHT=22`（依列高等比縮放）→ dot→線淨空 **11.25px**。Snipcode 車道比 IntelliJ 窄 21%，線卻粗 33%。

**顏色策略**：12 色 palette（builder:6–10 / graph-color.ts / graph-colors.ts / package.json 四處同步）。`pickColor`（builder:248–261）= **最低空閒 index**：rail 結束後下一條新 rail 立刻拿回 palette[0]。`gitGraphPlus.branchColors` 規則命中時走 `colorOverride`（字串，builder:373–378，tip 往下染整條 rail，first-set-wins）。**上游 SourceGit 的 `ColorPicker` 是 round-robin queue + `Recycle()`，不是最低空閒 index**——此處是 port 的分歧。

**HEAD / 分支歸屬**：builder:54 `isMerged` 寫死 `false`（註解 "simplified"）；上游 `Path.IsHighlighted` + `CommitGraphHighlighting.CurrentBranchOnly` + view 端 `grayedPen(Gray, 0.4)` 整套沒移植。webview 自己 BFS 出 `currentBranchCommits`（svelte:111–194），只用來給**列文字**加 `.other-branch` opacity 0.6（svelte:1528、CSS 2161–2166）；線圖本身不吃這個集合。

**Badge**（svelte:1559–1691、CSS 2421–2530）：內嵌在 message **前**，`flex-shrink:0; white-space:nowrap`，無 `max-width`；左側 `--badge-bar-width`（預設 4px）色條 + 中性底；顏色 = 該列 lane 色（`nodeColor`），tag 固定 `#f0c040`、stash 灰、worktree `#4caf50`（svelte:1586）；HEAD badge 55% 色填充（light 70%）+ 粗體。同 commit 的 badge 依 head/branch/remote/tag/stash 排序，remote 若被本地 tracking 則折成一顆雲 icon（`badge-cloud-only`）。

**列強調**：hover = `--bg-hover`（CSS 2119）、selected = `--bg-selected`；HEAD 列**沒有**整列底色。`hoveredHash`（svelte:345、637–642）只驅動列/meta 背景。

**local / remote 標示**：`.local-dot` / `.remote-dot` 5px 圓（CSS 2293–2316），放在 `.col-message` 開頭（svelte:1555–1558），只對**當前分支**計算。builder 算出的 `dot.localOnly` / `dot.remoteTip` 在 webview **完全沒用**（svelte:1517 `isRemoteTip` 是死 `@const`）；`remoteOnlySet` 在 builder 裡唯一作用是壓掉 remote-tip 的 merge link（builder:394）。

**排序**：`gitGraphPlus.graphSortOrder` 預設 `topological` → `--topo-order`（git-service.ts:686–689、MainPanel.ts:657）。無 `--first-parent`、無 `--no-merges` 選項（grep 只命中 diff 註解）。初載 200、Load more 50（package.json:400–408）。

**虛擬捲動**：`visiblePaths` 依每條 path 的 y-bounds 過濾（svelte:493–514），`d` 字串預先算好；跨全圖的 rail 永遠整條在 DOM 裡但 `d` 只有轉折點，成本低。SVG 高度 = 全部列高。

---

## 2. Findings（依對「一目了然」的影響排序）

### P0 — 會讓人看錯分支結構

**F1. 車道顏色不穩定：同一顏色在畫面上下反覆出現且不對應同一分支**
- 證據：`git-graph-builder.ts:248–261` 最低空閒 index；`:366`、`:411` 兩個建 rail 點都無偏好色。截圖 `graph-dark.png`：綠色 lane 是 develop，但只要 develop rail 在畫面下方結束，下一條新 rail 就會再拿綠色。上游是 round-robin（至少不會立刻重用剛釋放的色）；IntelliJ `GraphColorManagerImpl.getColor` 對 head fragment 回 `firstRef.name.hashCode()` → **依分支名穩定**。
- 建議：`pickColor(unsolved, preferred?)`——在兩個建 rail 點算 `preferred = hash(tipRefName) % palette.length`（新 head rail 用該 commit 的第一個 branch/remote-branch ref；merge-parent rail 用 `hashIndex.get(parentHash)` 查 parent 的 ref），空閒就用、被佔就退回最低空閒。**不要走 `colorOverride`**：它是字串、繞過 free-mask，兩條同時可見的分支會撞色。branchColors 規則仍優先。
- 成本：演算法層但小（~15 行，builder 內），無 UI 變動。

**F2. 非當前分支的「線」與當前分支一樣亮，只有文字淡化**
- 證據：`CommitGraph.svelte:1528` `.other-branch` 只掛在 row；CSS 2161–2166 只淡 subject/author/hash/date；SVG paths 不知道自己屬於哪些 commit（`GraphPath` 只有 points/color）。`builder.ts:54` `isMerged` 寫死 false → 上游的 `IsHighlighted` / `grayedPen(Gray, 0.4)` 整段沒移植。截圖 `graph-dark.png` 下半：origin/main 列（ci/docs）文字已灰，粉色 lane 仍全亮，「哪條是我的」只能靠找 HEAD 環。
- 建議：builder 在建 rail 時判斷 `headReachable.has(firstCommit)`（HEAD BFS，builder 已有兩個 BFS 可複用同一 `hashIndex`）寫進 `GraphPath.highlighted` / `GraphLink.highlighted` / `GraphDot.highlighted`；webview 非 highlighted 的 path/link `opacity 0.35`（dot 0.5）。保留一個設定 `graphHighlight: 'all' | 'currentBranch'`（對應上游 enum）。
- 成本：演算法層小（BFS ~20 行 + 3 個欄位）+ CSS。

### P1 — 明顯降低辨識度

**F3. 5px@0.07 光暈是白畫，且把 `<path>` 數量翻倍**
- 證據：svelte:1465、1480；對比 1.04–1.14:1（算）；五張截圖皆不可見。
- 建議：刪掉光暈層；主線 `stroke-width 2 → 2` 維持、`opacity 0.85 → 1`（要層次靠 F2 的 highlighted 淡化，不是全體 0.85）。
- 成本：純模板刪 2 行。

**F4. 車道 12.6px 偏窄；`--lane-width:14px` 是死變數**
- 證據：builder:270 + svelte:339；global.css:36 無引用。餘裕 7.6px vs IntelliJ 11.25px。merge link 在 15px（半列）內橫跨 12.6px，曲線很陡（截圖 merge 列可見）。
- 建議：`X_SCALE 1.05 → 1.25`（=15px）或 1.33（=16px 對齊 IntelliJ）；同步 `commitLeftMargin` 乘數已自動跟（svelte:1554 用同一 `X_SCALE`）。刪除或改成真正被引用的 `--lane-width`。
- 成本：一個常數。副作用：graph 欄變寬 ~20%，窄視窗更早進 horizontal-scroll（見 F13）。

**F5. HEAD 列無整列強調；HEAD 環與 merge 環差異小；HEAD 為 merge 時失去 merge 標記**
- 證據：svelte:387–389 `head` 優先於 `merge`；1499–1502 HEAD r5/stroke2 vs merge r4/stroke1.5+r2；CSS 無 head-row 樣式。截圖 `graph-dark.png` y=281（develop）與 y=521/701（merge）同為空心環，1× 下要靠中心小點分辨。IntelliJ：current branch commits 淺藍底（Help 明載）。
- 建議：(a) 新增 `class:head-row` → `background: color-mix(in srgb, var(--vscode-focusBorder) 8%, transparent)` 或 `box-shadow: inset 3px 0 0 <laneColor>`；(b) HEAD 點改「r4 實心 + r6.5 外環 stroke 1.5」（雙環），merge 維持空心；(c) dotType 改成可同時帶 `head && merge`（例如 `isHead` 獨立布林），HEAD 落在 merge 上時畫雙環 + 中心點。
- 成本：(a) CSS+1 個 class；(b) 模板；(c) builder 型別 +1 欄位。

**F6. hover 一列時線圖無反應；沒有 path↔commit 對應**
- 證據：svelte:345、637–642 只設 `hoveredHash`；`GraphDot` 沒有 rail index；`.graph-lines` `pointer-events:none`（CSS 2098–2101）。IntelliJ `SimpleGraphCellPainter.kt` 對 `isSelected` 元素用 `SELECT_THICK_LINE=2.5` 重畫（觸發方式官方文件未描述，程式碼層面確認存在）。
- 建議：builder 在 push dot 時記 `pathIndex`（`dotPaths[i]` 已經是該 rail 的 PathHelper，只差在 `result.paths` 的 index；link 也記 `parent` 的 index）。webview：`hoveredPathIndex = displayDots[hoveredRowIdx]?.pathIndex` → 該 `<path>` `stroke-width 3; opacity 1`，其餘 `opacity 0.3`（有 F2 時疊加）。選取列同理。
- 成本：builder +5 行、webview +1 derived + 2 個 class；不需 pointer-events。

**F7. Badge 內嵌無上限：長名把 message 推走或壓到 0；固定色與 palette 撞色**
- 證據：`.ref-badge` `flex-shrink:0; white-space:nowrap`（CSS 2421–2440）、無 `max-width`；截圖 `graph-narrow-dark.png` 前兩列 message 只剩 `ui: sticky header and column…`，`graph-dark.png` 頭兩列 badge 佔 320–370px。tag `#f0c040` vs palette `#ffc53d`/`#faad14`、worktree `#4caf50` vs `#73d13d`（svelte:1586）——tag/worktree badge 會被誤讀成某條 lane 的顏色。
- 建議（保留左置，理由見 §4）：`.ref-badge { max-width: 180px; overflow:hidden; text-overflow:ellipsis }`（`ref-icon` `flex-shrink:0`）；超過 2 顆 badge 折成 `+N`（tooltip 列全名，點開展開）；tag 改 codicon-tag + 中性底不上色，worktree 只留 icon 不改底色（顏色只留給 lane）。
- 成本：max-width 純 CSS；`+N` 需 ~20 行模板/狀態。

**F8. local-only 5px 點像 stray node；remote-only 完全沒視覺化；builder 資料未用**
- 證據：svelte:1555–1558 把 `.local-dot` 放在 `.col-message` 起點，截圖 `graph-dark.png` develop 列 x≈35 的藍點正好落在下方橘色 lane 的 X 上，1× 下與 lane 節點無法區分。`isRemoteTip`（svelte:1517）死 const；`dot.localOnly`/`dot.remoteTip` 未被讀取；`currentBranchRemoteAhead` 只覆蓋當前分支。
- 建議：local-only 用 `codicon-arrow-up`（12px、lane 色）放在 hash 欄前或 badge 內；remote-only 用 `codicon-cloud` 灰；並改用 builder 的 `dot.localOnly`（覆蓋所有分支，非只 HEAD）。刪除 webview 重複 BFS 或刪 builder 欄位——二選一，不要兩套。
- 成本：模板 + CSS；資料已存在。

**F9. 長邊畫成連續直線**
- 證據：截圖 `graph-dark.png` 最左藍色 lane（`feature/very-long…`，parent 是 c582423）從 y=161 直落到底部跨 25+ 列無 commit，與 develop 綠線並排等粗等亮；IntelliJ 預設 Long Edges 關、以向下箭頭截斷。
- 建議：webview-only——`buildPathD` 遇到垂直 `L` 段長度 > N 列（N=4）時，用 `displayDots[y].center.x === x` 逐列檢查該段是否有 commit（points 只有轉折點，**單靠 points 分不出「經過」與「有 commit 的直段」**）；純經過的段落只畫頭尾各 1.5 列 + 向下/向上小箭頭，中段留白。欄位仍保留（`unsolved` 佔位，與 IntelliJ 行為一致）。點箭頭跳到下一個 commit 需要該 group 開 `pointer-events:auto`。
- 成本：webview ~40 行；不動 builder。

**F10. Light theme 下 palette 半數低於 3:1**
- 證據（算，vs `#fff`）：`#43e8d8` 1.52、`#ffc53d` 1.58、`#73d13d` 1.92、`#36cfc9` 1.92、`#faad14` 1.90、`#63b0f4` 2.32、`#ff7a45` 2.59；tag `#f0c040` 1.70。截圖 `graph-light.png` 綠/藍線已偏淡（粉、橘尚可）。WCAG 1.4.11 圖形元件建議 ≥3:1。
- 建議：不加第二組 palette 設定，改 `style="--c:{pathColor}"` + CSS `stroke: var(--c)`，`:global(body.vscode-light) .graph-lines path { stroke: color-mix(in oklab, var(--c) 72%, #000) }`（circle 的 fill 同理）。high-contrast 主題直接 `stroke-width: 2.5`。
- 成本：純 CSS + 屬性改 style。

### P2 — 打磨

**F11. 空心點 fill=`--bg-primary`，在 selected/hover 列變成一塊暗色圓盤**
- 證據：svelte:1499、1501 `fill="var(--bg-primary)"`；SVG z-index 3 蓋在列上（CSS 2098–2107）。截圖 `graph-dark-details.png` y=521 選取列的 merge 環中心是編輯器底色而非選取藍。
- 建議：fill 改 `transparent`（環內透出列底色），merge 中心點靠 r2 實心已足夠。
- 成本：2 個屬性。

**F12. Root commit（無 parent）點固定 palette[0]**：builder:381–384 `major` 為 null 時 `dotColor=0`。有 F1 後改成用 `tipColorMap`/preferred 同邏輯。成本極小。

**F13. 窄視窗行為**：`maxGraphWidth = max(120, viewport − 345 − 120)`（svelte:355–364）；900px 寬時 graph 可到 435px 才切 h-scroll，實際 5 條 lane 只用 ~65px，所以壓縮的是 message 而非 graph（截圖 `graph-narrow-dark.png` 證實）。F4 加寬 20% 後仍遠低於門檻，無風險。30px 列高 × r4 點 × 13px 字比例正常，不需動。

**F14. 效能**：200 commit、5 lane 的 SVG 元素 ≈ paths 2×~6 + links 2×~4 + circles ~230，遠小於 rows DOM。唯一可行動項是 F3 刪光暈（path 數 −50%）。SVG 高度 = 30px × N，Load more 到數千列仍在瀏覽器限制內，不需處理。

---

## 3. 對照 JetBrains Log

| JetBrains 行為 | Snipcode | 備註 |
|---|---|---|
| Current branch 列淺藍底 | **沒有** | F5；只有 HEAD 環 + badge |
| Label 顏色語意固定（yellow head / green local / violet remote） | **沒有（不同設計）** | Snipcode 用 lane 色 + icon（check/cloud/tag/archive）區分型別；lane↔badge 對應是 JetBrains 沒有的優點，但 local/remote 只差一顆雲 icon |
| Important branches 靠左保色 | **沒有** | F1 顏色不穩；車道順序 = rail 建立順序 |
| Collapse Linear Branches（虛線折疊列） | **沒有** | 需改列數/virtual scroll/selection，建議不做 |
| Long Edges 關 → 向下箭頭 | **沒有** | F9 |
| My Commits 粗體 | **沒有** | webview 無 user.email；host 可從 `git config user.email` 帶入 |
| Merge commit 淡化 | **沒有** | 有 `dot.type==='merge'` 可直接加 class |
| author ≠ committer 星號 | **沒有** | `Commit` 已有 `committer` 欄位（fixture 證實），只差顯示 |
| Topological sort | **有** | 預設 `--topo-order`，比 JetBrains 預設（date）更好 |
| First Parent | **沒有** | log() 無 `--first-parent` |
| No Merges | **沒有** | log() 無 `--no-merges` |
| ← → parent/child 導覽 | **有** | Ctrl/Cmd+↑↓（`graph-navigation.ts:97` `computeJumpTarget`，帶路徑記憶）；只是無 UI 提示 |
| hover 高亮整條線 | **沒有** | F6；IntelliJ 程式碼有 `isSelected`/`SELECT_THICK_LINE`，觸發方式文件未載 |
| Compact References View / badge 折疊 | **有但弱** | 只折 tracked remote 成雲 icon；無 `+N`、無 max-width（F7） |
| 非當前分支淡化 | **有但弱** | 只淡文字，線不淡（F2） |
| local-only / remote-only 標示 | **有但弱** | 5px 點、只當前分支、remote-only 沒畫（F8） |

---

## 4. 建議的兩層方案

### (a) 一週內：CSS / 常數 / 設定層

具體參數組合（全部在 `CommitGraph.svelte` 與 `global.css`，不動演算法）：

| 項目 | 現值 | 建議 | 對應 |
|---|---|---|---|
| 車道 `X_SCALE` | 1.05（12.6px） | **1.25（15px）**；同步刪 `--lane-width` 死變數 | F4 |
| 線 | 5px@0.07 + 2px@0.85 | **單層 2px @1.0**；light 主題 `color-mix(in oklab, var(--c) 72%, #000)`；HC 主題 2.5px | F3、F10 |
| 一般點 | r4 實心 | r4 實心（不變） | — |
| merge 點 | r4 空心 1.5 + r2 | r4 空心 1.5 + r2，fill `transparent` | F11 |
| HEAD 點 | r5 空心 2 | **r4 實心 + r6.5 外環 1.5**（雙環，與 merge 的「空心」明確不同） | F5 |
| HEAD 列 | 無 | `inset 3px 0 0 <laneColor>` + 6–8% focusBorder 底 | F5 |
| other-branch 文字 | 0.6 | 0.6（不變）——線的淡化留給 (b) F2 | — |
| badge | 無 max-width | `max-width:180px` + ellipsis；tag/worktree 改 icon 表意、底色中性 | F7 |
| local/remote 標示 | 5px 圓 | `codicon-arrow-up`（lane 色）/ `codicon-cloud`（灰）12px，放 badge 尾或 hash 前 | F8 |
| merge 列 | 無 | `class:merge-row` → subject `opacity 0.75`（可設定關閉） | 對照表 |
| author≠committer | 無 | subject 後加 `*` + tooltip | 對照表 |

為什麼比 JetBrains 清楚或持平：車道 15px + 1.5–2px 線的餘裕與 IntelliJ 等級；HEAD 列底色 + 雙環點同時給「列」與「線」兩個定位錨，IntelliJ 只有列底色；badge 留在 dot 旁保留 lane↔branch 的顏色對應（IntelliJ 的右置 label 沒有這層對應），加 max-width 後不再犧牲 message。

### (b) 需要演算法 / 新功能

1. **穩定配色**（F1）：`pickColor(unsolved, preferred)`，preferred = `hash(tipRefName) % palette.length`，衝突退回最低空閒；兩個建 rail 點都套。→ 同一分支每次開圖、每次捲動都同色，等同 IntelliJ 的 `name.hashCode()`，而且多了撞色迴避（IntelliJ 沒有）。
2. **非當前分支線淡化**（F2）：builder 補 HEAD BFS → `highlighted` 欄位 → path/link/dot `opacity 0.35/0.5`。→ 還原上游 SourceGit 的 `CurrentBranchOnly` 模式；IntelliJ 只淡列底色不淡線，這裡會更直接。
3. **hover / selected 高亮整條 rail**（F6）：`dot.pathIndex` + `link.pathIndex` → 該 path `stroke-width 3`，其餘 0.3。→ 對應 IntelliJ 的 `SELECT_THICK_LINE`，且由列 hover 觸發（不需精準指到線上），比 IntelliJ 容易命中。
4. **主分支靠左**：在建 rail 時若 tip 命中「important」pattern（沿用 `branchColors` 的 regex 機制，新增 `importantBranches` 設定）改 `unsolved.unshift()` 而非 `push()`。SourceGit 演算法允許（每列依 `unsolved` 順序重算 X，`pass()` 會自動彎過去），**代價是該列所有其他 lane 出現一次單列 S 型位移**——IntelliJ 2024.2 的做法也有同樣的 jog。中等成本，建議在 1、2 之後再評估是否值得。
5. **長邊截斷箭頭**（F9）：webview-only，`buildPathD` 內以 dot 逐列檢查判定「純經過」段，畫頭尾 + 箭頭。→ 對齊 IntelliJ 預設（Long Edges 關）；可點跳需開該 group 的 pointer-events。
6. **badge `+N` 折疊**（F7）：>2 顆時折疊、tooltip 列全名、點擊展開該列。→ 等同 Compact References View，且不必移到右側。
7. **First Parent / No Merges**：`log()` 加兩個 flag 透過 `LogOptions` 傳入，builder 不用改（first-parent 時 `parents.length` 本來就 1）。低成本，補齊對照表兩格。
8. **不建議現在做**：Collapse Linear Branches 的「移除列」版本——牽動 row count、virtual scroll、selection、keyboard nav 四處，是新功能而非清晰度修正；F9 的箭頭截斷已涵蓋 80% 的視覺收益。

### 順序建議
(a) 全部 + (b)1、(b)2、(b)3 是一組：先把線/點/間距做乾淨（否則淡化與高亮沒有對比空間），再讓顏色穩定、非當前分支退場、hover 給焦點——這三件做完，「哪條線是我的、它從哪來、合到哪去」在不點任何東西的情況下就能一眼讀出，這是 IntelliJ 目前也做不到的組合。
