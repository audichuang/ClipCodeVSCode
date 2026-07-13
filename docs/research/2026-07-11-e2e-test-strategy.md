# 端到端測試策略：發現真實問題的完整驗證

Date: 2026-07-11
Status: Strategy agreed（Claude 與 Codex/GPT-5.6 兩輪辯論收斂）. **§3 matrix is still the
aspirational plan; §1 inventory below is a historical snapshot and is NOT
authoritative for “what green means today”** (boot handshake shipped in 0.3.36;
e2e now also covers graph copy-full-source + UNCOMMITTED + blame smoke — see
repo `AGENTS.md` “Build / test”).
Companion: [2026-07-10-vscode-git-operations-audit.md](2026-07-10-vscode-git-operations-audit.md)（風險與驗收來源）

## 1. 現有四層閘門實際保證了什麼

> ⚠ **Stale inventory (2026-07-11).** Treat as historical baseline only. Live
> guarantees: repo-root `AGENTS.md`. Live e2e sources: `test-e2e/suite/`.

`npm run build` + `npm test` + graph vitest + `npm run test:e2e` 全綠，**當時**保證：

- host 與 vendored graph 能 bundle、webview assets 能產出並複製到 `dist/`。
- root unit（135）與 graph backend（真 Git fixture）／webview（happy-dom）測試通過。
- extension 能在真實 VS Code Electron 中 activation、建立 graph panel，且 selected-file copy → 真實 clipboard → restore 到磁碟的**單一 happy path**成立。

**當時不**保證：graph webview 真正 boot（JS 404／CSP／bundle error 仍全綠）、使用者操作到 host 的 message bridge、任何 Git mutation、multi-repo／repo switch、packaged VSIX、以及 audit P1-1～P1-7 的驗收。現有 e2e 本質是 smoke test 加一條 copy/restore round-trip。

已知兩個「測試鎖住錯誤行為」案例（詳見 audit 文件 P1-2／P1-3 驗收註記）：`MainPanel.test.ts#L337` 期待 pull 後無條件 pop、`PrView.test.ts#L125/L204` 期待 open/copy 送 symbolic ref——實作對應票時必須同步反轉。

## 2. 三個經辯論確立的原則

### 2.1 每個 P1 必須有 real-git ground truth，mock 只做精確覆蓋

mock／happy-dom 適合 error branch、sequence guard、UI payload 的精確覆蓋，但**不能作最終 correctness oracle**——上述兩個鎖錯行為的測試就是直接反例：deterministic 層驗證的是「我們以為的行為」，不是「對使用者正確的行為」。

### 2.2 Git binary shim：用真 Git 做確定性 race 測試

graph 所有主要 spawn 都經 `getGitBinaryPath()`（`graph/src/git/git-binary.ts#L15`），測試可注入 wrapper script 攔截特定 subcommand、在 sentinel file 出現前 block、之後 `exec "$REAL_GIT" "$@"` 透明轉發。這讓 P1-3／P1-4／P1-7 的 race 能以**真 Git＋確定性時序**重現，不 mock service、不靠機率。

Shim 實作防護（缺一即 flaky 或誤攔）：

1. GitService 會在 subcommand 前插入 `-c core.quotePath=false` 等 global options——matcher 不可假設 `argv[1]` 是 subcommand，必須先跳過 global options。
2. sentinel 用唯一 temp dir／token（`entered`＋`release` 兩個檔），等待有 ~10 秒 hard timeout，不可無界 block。
3. matcher 至少含 `{cwd, canonical subcommand, one-shot token}`，避免同一 refresh 的其他 `log` 被誤攔。
4. 真 Git 用預先解析好的 absolute path，否則 shim 會遞迴呼叫自己。
5. POSIX 端用 `exec` 轉發，signal／exit code／stdio 透明；shim 不得向 stdout/stderr 印診斷。
6. 控制變數用 `SNIPCODE_TEST_*` 前綴，不用 `GIT_*`，避免與 env sanitizer（P1-1）互相干擾；shim 原樣保留所有 env。
7. `setGitBinaryPath` 是 module-global：shim suite serial 執行、`afterEach` restore。
8. **第一版限定 Linux gate**。Windows 不假設 `.cmd` 能透明取代 executable（目前 spawn 無 `shell:true`，`%*` 有二次 quoting 問題）；Windows 跑不需 shim 的 casing/env real-git tests。絕不為了測試把 production spawn 改成 `shell:true`。

### 2.3 Webview boot handshake：不需要 Playwright 就能抓 boot 級假綠

`App.svelte` mount 後立即送 `getLog`／`getBranches`（`App.svelte#L255`），host 有唯一 `onDidReceiveMessage` 入口。最小實作：

1. MainPanel 收到該 panel 第一個 `getLog` 時 resolve `whenWebviewReady()`。
2. `gitGraphPlus.open` command 回傳該 Promise，e2e 直接 `await executeCommand(...)`，timeout 10–15 秒。
3. **實作時修正順序**：目前 MainPanel 先設 `webview.html` 後掛 listener（`MainPanel.ts#L368` vs `#L381`），存在錯過極快 handshake 的窗口——應先掛 listener 再設 HTML。

這一條抓 main.js 漏包／404、script CSP 阻擋、bundle syntax error、Svelte boot crash。不能證明 CSS/font 與後續 DOM 互動——那由 #24（VSIX smoke）與 #25（單條 CDP bridge journey）補。

### 2.4 P1-1 需要四層 defense-in-depth（單層都不足）

- unit：sanitizer contract（denylist 逐 key、askpass/proxy/locale 保留）。
- architecture guard：禁止 approved wrapper 以外直接使用 `child_process.spawn`（防未來新增 spawn site 繞過）。
- real-git integration：每個 wrapper 在污染 env 下操作正確 repo。
- Electron e2e：`extensionTestsEnv` 污染整個 extension host 後跑 boot/refresh/copy，驗 critical path 整體閉合——但它只證明被該流程執行到的 spawn sites，不能取代前三層。
- 注意：built-in `vscode.git` 也繼承污染 env；測試要能區分「VS Code Git 未發現 repo」與「Snipcode raw spawn 讀錯 repo」，不可只得到模糊 timeout。

## 3. 最終測試矩陣（25 條）

| # | 測試名 | 層 | fixture 與確定性控制 | 對應風險 | 抓到的 bug class | gate/nightly |
|---:|---|---|---|---|---|---|
| 1 | Git env sanitizer contract＋spawn-site architecture guard | unit | denylist 逐 key；掃描 direct `spawn` 只允許 approved wrappers | P1-1 | sanitizer 漏 key、新 spawn 繞過 wrapper | gate |
| 2 | Poisoned env dual-repo ground truth | integration | 真 repo A/B；分別污染 `GIT_DIR+WORK_TREE`、`GIT_INDEX_FILE`、object dir | P1-1 | `-C repoB` 仍被導向 A | gate |
| 3 | Polluted extension-host closure | electron-e2e | `extensionTestsEnv` 污染為 A；workspace 為 B；boot/refresh/copy 必須得到 B 內容 | P1-1 | 整體 critical path 被父 env 污染 | gate |
| 4 | Auto-stash transaction state machine | unit | fake adapter 回傳 created OID/no-op/conflict；驗 apply→resolve→drop 與 error aggregation | P1-2 | 固定 `stash@{0}`、apply 失敗仍 drop | gate |
| 5 | Clean tree＋既有 stash pull | integration | 真 bare remote＋working repo；clean tree 執行 handler `pull {stash:true}`，不 mock GitService | P1-2 | exit 0 未建 stash、誤 pop 既有 stash | gate |
| 6 | Dirty tree＋既有 stash＋pull failure | integration | shim 使 pull 確定失敗；驗本次 stash restore、原 stash OID/內容/數量不變 | P1-2 | restore 錯物件、error 遺失、stash 殘留 | gate |
| 7 | PR response/open/copy 只傳 snapshot OID | happy-dom | 注入含 `baseOid/headOid` 的 response；斷言 open/copy payload 只含 OID | P1-3 | UI 重送 symbolic ref | gate |
| 8 | PR immutable snapshot ground truth | integration | shim 在 ref resolve 後 block 第一個 head-dependent command；移動 head 後 release | P1-3 | compare 各 command 混到不同 tip | gate |
| 9 | Epoch/cache/provider deterministic matrix | unit/integration | deferred promises 覆蓋 A→B、A→B→A、修正 refresh failure、五 provider 每個 cache write | P1-4 | stale cache、fallback 無守衛、失敗後殘留 | gate |
| 10 | Delayed old refresh real-git ground truth | integration | shim 只 block A 的 `log`；切到 B 完成 refresh 後才 release A；capture 真 MainPanel posts | P1-4 | 舊 refresh 晚到覆寫 B UI/cache/sidebar | gate |
| 11 | Streaming blob parser limits | unit | synthetic chunk stream；header 宣告大 body；驗 drain 不 retain、aggregate cap、framing | P1-5 | oversize 破壞 batch framing、總量無界 | gate |
| 12 | Blob abort/timeout/copy-generation | unit | controllable fake child；驗 kill→close 後才 settle、不寫 clipboard | P1-5/copy race | zombie、舊 copy 覆寫新 clipboard | gate |
| 13 | Oversized real Git blob ground truth | integration | 真 repo 含 oversize blob＋後續小檔；低 maxBytes | P1-5 | 真 `cat-file --batch` framing 與假設不符 | gate |
| 14 | Heap/RSS 與 zombie benchmark | 獨立 benchmark | 獨立 Node process；量 peak RSS；abort 後確認 child 消失 | P1-5 | heap 隨 blob 線性成長、process leak | nightly |
| 15 | POSIX case-distinct repositories | integration | Linux 真實 `Foo`/`foo` repos 同時 discovery/switch；case-only rename | P1-6 | lowercase 合併 repo、rename 丟 path | gate |
| 16 | Windows mixed-case Git tree path | integration | Windows runner 真 Git tree 含 `Src/A.ts` | P1-6 | comparison key 傳回 Git、fallback 失效 | nightly |
| 17 | Repo pill casing 與 active 標記 | happy-dom | repo list 同時含 `Foo`/`foo` | P1-6 | webview 第三份 comparator 仍 case-fold | gate |
| 18 | Cross-repo auto-stash transaction | integration | 真 repo A/B；shim 在 A `stash push` 前 block；送 `switchRepo(B)` 後 release；記錄每個 Git cwd | P1-7 | stash 在 A、pull/pop 跑到 B | gate |
| 19 | Repo pill operating 期間 disabled | happy-dom | 設 `uiStore.operating='pull'`，驗不可送 `switchRepo` | P1-7 | host 正確但 UI 仍允許危險切換 | gate |
| 20 | Real webview boot handshake | electron-e2e | `gitGraphPlus.open` await 首個 webview→host `getLog`；15 秒 timeout | graph boot 缺口 | asset 404、CSP、syntax error、boot crash | gate |
| 21 | Git changes discovery→clipboard | electron-e2e | 真 workspace 含 staged/unstaged/delete/rename/untracked；執行 `clipcode.copyGitChanges` 不手工餵 status | 核心流程缺口 | resource mapping、status、wiring 錯誤 | gate |
| 22 | Destructive restore matrix | electron-e2e | payload 含 create/overwrite/delete；驗 Overwrite/Skip/Cancel 與最終磁碟 bytes | restore 缺口 | overwrite 錯、delete 未執行、cancel 仍 mutation | gate |
| 23 | Multi-root copy/restore 與 repo selection | electron-e2e | `.code-workspace` 含兩 roots/repos；跨 root copy/restore；切 active repo | multi-root/P1-4/P1-6 | root 解析錯、錯 repo、路徑落錯 root | gate |
| 24 | Packaged VSIX boot smoke | electron-e2e | `vsce package`→乾淨 profile 安裝→webview handshake→一次 round-trip | packaging 缺口 | `.vscodeignore` 漏 asset、VSIX 不可跑 | nightly/release 前 |
| 25 | PR Copy Full Source 真 UI bridge | electron-e2e | CDP 僅此一條：開 PR tab、選 base/head、點 Copy、驗 clipboard bytes | UI bridge/P1-3 | Svelte event→message→MainPanel→host 斷裂 | nightly |

Electron gate 預算約束：一個正常 launch 承載 #20–#23、一個 polluted-env launch 承載 #3；不用固定 sleep，只用事件/sentinel 等待；單一等待上限 10–15 秒，整個 Electron job 外層 hard timeout 300 秒；#24/#25 不進一般 gate。

## 4. 實作順序（ROI 前五）

1. **#20 webview boot handshake**——改動最小，立即消除目前最明顯的假綠。
2. **Linux git shim 基礎＋#18**——先鎖最高資料風險的跨 repo mutation；同一 harness 重用於 #6/#8/#10。
3. **#1–#3 P1-1 三層閉合**——sanitizer、dual-repo、污染 Electron host 一起落地。
4. **#5/#6 auto-stash ground truth**——以 stash OID/內容為 oracle，不再以「有呼叫 pop」為準。
5. **#8/#10 PR snapshot 與 refresh race**——同一 shim 做確定性時序。

之後依序：bounded blob reader #11–#14、path casing #15–#17、核心 Electron flows #21–#23。

## 5. 不做的事（YAGNI）

- 不做完整 Playwright/webview DOM matrix；只保留 #25 一條最高價值 bridge journey。
- 不把所有 Git mutation 複製成 Electron tests；transaction correctness 由 real-git MainPanel integration 驗。
- 不在 Electron 內量 RSS 或檢查 zombie；P1-5 用獨立 benchmark。
- 不在 e2e 重做完整 clipboard golden fixtures（cross-tool contract 已有 SHA-guarded fixtures）。
- 不為 Windows shim 把 production spawn 改成 `shell:true`；不引入泛用 Git library。
- 不把大 blob／Windows matrix／VSIX 安裝／CDP 互動塞進五分鐘 gate。
