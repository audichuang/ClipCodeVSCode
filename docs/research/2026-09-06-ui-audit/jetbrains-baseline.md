## JetBrains IntelliJ IDEA 內建 Git UI 對照基準（研究報告）

方法說明：全部內容取自 JetBrains 官方 Help（2026.2 版，最後修訂 2026-06～08）、JetBrains 官方 blog / What's New、JetBrains 支援論壇、YouTrack，以及少量 HN / Reddit / 部落格。官方 Help 頁面用 firecrawl 抓了原始 markdown 逐字核對（Log tab、Diff Viewer、Commit 設定、Commit and push、File status）。文件沒寫的一律標 **(未在文件確認)**。未碰任何本機程式碼。

---

### 1. Log tab（Git 歷史線圖）

**版面**
- 四個 pane：**Branches**（左）、**Commits**（中）、**Changed Files**（右）、**Commit Details**（右、在 Changed Files 之下）。 https://www.jetbrains.com/help/idea/log-tab.html
- Commits pane 每列顯示 commit message、author、timestamp；「每個 branch 的最新 commit 帶一個 branch 名稱 label」。 https://www.jetbrains.com/help/idea/log-tab.html

**Label / 顏色 / 強調**
- Label 顏色語意固定：**yellow = current branch head**、**green = local branches**、**violet = remote branches**。 https://www.jetbrains.com/help/idea/log-tab.html
- 「Commits to the current branch are displayed against the light blue background, while commits to all other branches are shown against the white background.」可由 Presentation Settings → Highlight → *Current Branch: blue background* 開關。 https://www.jetbrains.com/help/idea/log-tab.html
- Highlight 選項：*My Commits: bold font*、*Merge Commits: greyed out*、*Current Branch: blue background*、*Not Cherry-Picked Commits: greyed out*（僅 Git；「Non-picked commits are commits from the selected branch that have not yet been applied to the current branch」）。 https://www.jetbrains.com/help/idea/log-tab.html
- author ≠ committer 的 commit 旁顯示 **asterisk**。 https://www.jetbrains.com/help/idea/log-tab.html
- Label 位置預設在 message 右側；*References on the Left* 選項才會移到左邊。*Compact References View* 把同一 commit 的多個 branch reference 折疊。*Tag Names* 關閉時只顯示 tag icon，hover 才看到名字。 https://www.jetbrains.com/help/idea/log-tab.html
- **Graph 車道顏色分配演算法：官方文件沒有描述。** 可確認的只有：
  - 2024.2 What's New：「We've refined the color encoding and layout of branch lines for the commit graph… Important branch lines now consistently remain on the left-hand side of the graph and retain their designated colors」。 https://www.jetbrains.com/idea/whatsnew/2024-2/
  - 支援論壇 JetBrains 回覆：「There is no API to modify branches' colors and it is not possible to change branches' colors via theme.」 https://intellij-support.jetbrains.com/hc/en-us/community/posts/4419237732498-Is-it-possible-to-change-color-of-branches-in-Git-Log
  - YouTrack IJPL-149533（Open）：使用者抱怨 master「constantly moves left/right and changes colors」、「identifying the checked out commit in the log is difficult」、parent/child 導覽困難；開發者 Julia Beliaeva 回覆 2024.2 加入 `--first-parent`、「Fix for the graph layout to keep more important branches on the left and avoid color changes」、Intelli Sort 改名 Topological Sort、實驗性 Linear Intelli Sort（把 merge 轉成 rebase 呈現）；另有使用者回報 2024.3.1.1 仍有 main 不在最左的情況。 https://youtrack.jetbrains.com/issue/IJPL-149533
  - IDEA-126522「More distinct branch colors needed」狀態 Obsolete，無演算法說明。 https://youtrack.jetbrains.com/issue/IDEA-126522
- hover 高亮整條路徑：**(未在文件確認)**。

**Graph Options（工具列）**
- 排序：預設 *By commit date*；*Topologically*「displaying incoming commits first, directly below the merge commit」。 https://www.jetbrains.com/help/idea/log-tab.html
- *Show First Parent*、*No Merges*（2024.2 新增）。 https://www.jetbrains.com/help/idea/log-tab.html 、 https://www.jetbrains.com/idea/whatsnew/2024-2/
- *Collapse Linear Branches*：「a dotted line is shown instead of successive commits」，也可點單一 branch 個別折疊/展開；*Expand Linear Branches* 反向。 https://www.jetbrains.com/help/idea/log-tab.html
- *Long Edges*：開啟時長 branch 完整畫出「even if there are no commits in them」；**預設關閉，長邊以一個向下箭頭取代**；點箭頭跳到該 branch 下一個 commit。 https://www.jetbrains.com/help/idea/log-tab.html
- 鍵盤 ← / → 跳 parent / child commit；右鍵 *Go to Child Commit* / *Go to Parent Commit*。 https://www.jetbrains.com/help/idea/log-tab.html

**欄位**
- Presentation Settings → *Columns*：可選是否顯示 author、date、commit hash、GitHub commit checks（CI）。*Commit Timestamp* 切換顯示 commit time 或 author time。*Show Root Names* 展開 Roots 欄。 https://www.jetbrains.com/help/idea/log-tab.html

**篩選 / 搜尋**
- Search field：可輸入完整或部分 commit message、revision number、regex；Enter 或失焦才套用；Ctrl+L 聚焦；Find icon 顯示歷史搜尋。切換 *Regex* / *Match Case*。 https://www.jetbrains.com/help/idea/log-tab.html
- 下拉篩選：**Branch**（含 favorite branches、All）、**User**（Select 後打字選 author）、**Date**（time-frame 或特定日期）、**Paths**（單 root 選 folder；多 root 在 Roots 區塊勾 root）。 https://www.jetbrains.com/help/idea/log-tab.html
- **Go to Hash/Branch/Tag**（Ctrl+F）：「You can select a reference with the same name from different repositories. The name of each repository is displayed on the right along with its color indicator.」 https://www.jetbrains.com/help/idea/log-tab.html
- 點「+」新增帶篩選條件的 Log 分頁，不重設既有篩選。 https://www.jetbrains.com/help/idea/investigate-changes.html
- *Enable Git Log Indexing*：快速過濾、file history 內可用 branch filter、Search Everywhere 搜歷史。 https://www.jetbrains.com/help/idea/log-tab.html
- 設好 Issue Navigation 後，message 中的 issue 編號會變成連結。 https://www.jetbrains.com/help/idea/log-tab.html

**多 repo**
- 「the colored stripe on the left indicates which root the selected commit belongs to (each root is marked with its own color). Hover over the colored stripe to invoke a tip that shows the root path.」 https://www.jetbrains.com/help/idea/log-tab.html

**Changed Files pane**
- 工具列：*Show Diff*（Ctrl+D）、*Revert Selected Changes*、*History Up to Here*、*View Options*（「Group the modified files by directory or module」；Layout：*Show Details* 顯示 Commit Details pane、*Show Diff Preview* 開 Preview Diff pane）、*Expand All / Collapse All*（僅 tree view）。 https://www.jetbrains.com/help/idea/log-tab.html
- 在 commit 列表按 Ctrl+A → 列出「自上次 update 以來所有變更檔案」；點 Group By 可改成 flat list。 https://www.jetbrains.com/help/idea/log-tab.html
- 右鍵：Show Diff、Show Diff in a New Window、Compare with Local、Compare Before with Local、Edit Source (F4)、Open Repository Version、Revert Selected Changes、Cherry-Pick Selected Changes、Extract Selected Changes to Separate Commit、Drop Selected Changes、Create Patch、Get from Revision、History Up to Here、*Show Changes to Parents*（merge commit 顯示對兩個 parent 的變更）。 https://www.jetbrains.com/help/idea/log-tab.html
- Merge commit：無衝突時 Changed Files pane 顯示訊息建議檢視兩個 parent 的變更；有衝突時 Show Diff 開三欄 diff，顯示 current 與各 parent、以及衝突如何解。 https://www.jetbrains.com/help/idea/investigate-changes.html

**Commit Details pane**
- 顯示 message、hash、author、author email 連結、date、time、GPG signature、root、branches；超過 6 個 branch 只顯示前 6 個 + *Show All*；message 中引用的 hash 可點擊跳轉。 https://www.jetbrains.com/help/idea/log-tab.html
- 2025.1：「Commit details are now displayed directly in the diff view.」 https://blog.jetbrains.com/idea/2025/04/intellij-idea-2025-1/

**多選 commit**
- 選兩個 commit → 右鍵 *Compare Versions* → Changes tool window 列出差異檔案。 https://www.jetbrains.com/help/idea/investigate-changes.html
- *Squash Commits*（「Combine selected commits」）、*Drop Commits* 支援多選；Branches pane 的 *Update* / *Delete* 也支援多選批次。 https://www.jetbrains.com/help/idea/log-tab.html

**Commits pane 右鍵選單（完整）**
- Copy Revision Number、Create Patch、Cherry-pick、Checkout Revision、Show Repository at Revision、Compare with Local、Reset Current Branch to Here、Revert Commit、Undo Commit（僅自己的 commit）、Edit Commit Message（僅未 push）、Fixup、Squash Into、Drop Commits、Squash Commits、Interactively Rebase from Here、Push All up to Here、Add Commits to Remote Branch、Rebase <current> onto Selected Commit、Branch <name> / Branches（若開啟 Control repositories synchronously 且 branch 存在多 repo，多一個 *In All Repositories* 子選單）、New Branch、New Tag、Go to Child/Parent Commit、View in browser。 https://www.jetbrains.com/help/idea/log-tab.html

**Branches pane（左）**
- 工具列：Hide、New Branch、Update Selected、Delete、Compare with Current、Show My Branches、Fetch All Remotes、Mark/Unmark as Favorite（favorites 置頂）、Navigate Log to Selected Branch Head、Settings（單擊行為：*Update Branch Filter* 或 *Navigate Log to Branch Head*；*Group By Directory*；*Show Tags*）、Expand/Collapse All。 https://www.jetbrains.com/help/idea/log-tab.html

---

### 2. Commit tool window（Changes 樹 / staging）

**窗格型態**
- 預設是左側直立的非 modal Commit tool window（Alt+0）；Options → *View Mode | Window*（非阻斷獨立視窗）/ *Float*；*Close Tool Window After Committing* 可關。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Advanced Settings：*Toggle commit controls*（平時只列 local changes，要 commit 才切出 message 欄）；關閉 *Enable Commit tool window* 則變成 Git tool window 的 Local Changes tab；modal 介面已移成 plugin（2025.1）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html 、 https://www.jetbrains.com/help/idea/advanced-settings.html 、 https://blog.jetbrains.com/idea/2025/04/intellij-idea-2025-1/

**Changes 樹的分組**
- 預設為 **changelist** 模式：「*Changes*」changelist 顯示所有修改（藍）與已 add 未 commit 的新檔（綠）；「*Unversioned Files*」changelist 顯示未追蹤檔；View Options → *Show Ignored Files* 可顯示 ignored。 https://www.jetbrains.com/help/idea/file-status-highlights.html
- 勾 Unversioned Files 節點下的檔案即可「stage and commit these files in one step」；有快捷鍵可一次選整個 active changelist（文件圖示未渲染出鍵名）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Log 的 Changed Files pane 可 group by directory / module 或 flat；**Commit tool window 本身是否有 Directory / Module / Repository 分組選項：(未在文件確認)**。 https://www.jetbrains.com/help/idea/log-tab.html

**檔案狀態顏色（Light theme 預設，Version Control | File Status Colors 可改）**
- Added `#0A7700`（綠）、Added in not active changelist `#0EAA00`、Modified `#0032A0`（藍）、Modified in not active changelist `#0047E4`、Deleted `#616161`（灰）、Deleted from file system `#773895`（紫）、Unversioned `#993300`（棕）、Ignored `#727238`（橄欖）、Merged with conflicts / Changelist conflict `#FF0000`（紅）、Merged `#7503DC`、Renamed `#007C7C`（青）、Have changed descendants `#8AA4C8`、Have immediate changed children `#3264B4`、Up to date 預設色。同一色碼用在 editor、tool window、Project tree 的檔名上。 https://www.jetbrains.com/help/idea/file-status-highlights.html
- *Highlight directories that contain modified files in the Project tree*（Version Control | Confirmation）→ 目錄也著色。 https://www.jetbrains.com/help/idea/file-status-highlights.html
- Editor gutter change marker（Light）：Modified `#C3D6E8`、Whitespace-only modified `#EDDCBC`、Added `#C9DEC1`、Deleted 灰三角 `#9F9F9F`；hover marker 出現工具列並顯示該行舊內容，可 revert、show diff、或複製舊內容片段。 https://www.jetbrains.com/help/idea/file-status-highlights.html

**Changelists**
- 預設 changelist「Changes」；active changelist 自動接收新變更；New Changelist（名稱 + 描述）；Set Active；*Move to Another Changelist*（Alt+Shift+M，對話框可選現有或新建、*Set active*、*Track context*）；可拖放；Delete Changelist。 https://www.jetbrains.com/help/idea/managing-changelists.html
- 在 editor 點 gutter change marker → 工具列可直接把該 chunk 指派到別的 changelist；diff 內 chunk 右鍵 *Move to Another Changelist…*。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html

**Staging area（取代 changelists 的模式）**
- Settings | Version Control | Git → *Enable staging area*；切換模式不會丟失 changelists。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Stage 整檔：Commit tool window 檔案旁的 **+** 按鈕；stage chunk：editor gutter marker → *Stage*；已 stage 的變更（含 IDE 外 stage 的）在 gutter 以 **hollow change marker** 顯示。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- 行級 / 同一行多處 stage：右鍵 *Compare HEAD, Staged and Local Versions* → 三欄 Diff，左 repository、右 local、**中間為可編輯的 staged 版本**。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html

**Partial commit（changelist 模式）**
- Ctrl+D 開 diff → 勾每個 chunk 旁的 checkbox；右鍵某一行 → *Split Chunks and Include Selected Lines into Commit*；或 hover gutter 勾/取消該行的 checkbox；未勾的變更留在目前 changelist。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- 從 editor 直接 commit：點 gutter marker → 工具列輸入 message → *Commit this change*；旁邊有 *Amend* inline。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html

**Amend / message**
- 勾 *Amend* 並點 chevron 選要修改的 commit；未 push 前可在 Log 用 *Edit Commit Message* 改。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Message 欄：history 按鈕列最近 message；「a quick-fix and the Reformat action that wrap a long line or reformat the message」；template 透過 `git config --local commit.template`。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Version Control | Commit 設定頁：*Clear initial commit message*、*Commit message inspections*（「Select the inspections that you want to be applied to the commit message」）。具體 inspection 名稱文件未列；YouTrack 標題可佐證存在「Blank line between Subject & Body」檢查（IDEA-290260），subject 長度限制等 **(未在文件確認)**。 https://www.jetbrains.com/help/idea/commit-dialog.html 、 https://youtrack.jetbrains.com/issue/IDEA-290260

**進階選項（右下齒輪）**
- *Author*（代他人 commit）、*Sign-off commit*（自動附「Signed off by: <username>」）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Commit Checks：Reformat code、Rearrange code、Optimize imports、Cleanup（選 profile）、Update copyright、Check malicious dependencies。 https://www.jetbrains.com/help/idea/commit-dialog.html
- Advanced Commit Checks：Analyze code、Check TODO、Run Configuration（跑測試）、*Run advanced checks after a commit is done*（失敗仍 commit；Commit and Push 時改為 commit 前跑）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- *Run Git hooks* 可逐次取消；Advanced Settings *Do not run Git commit hooks* 全局關閉。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html

**Commit and Push / Push dialog**
- *Commit* 與 *Commit and Push*；Push Commits dialog 列出所有 repo 及各 repo 自上次 push 後的 commit；非同步控制的多 repo「only the current repository is selected by default」；點 repo 名改目標 remote、點 branch 名改目標 branch、*Edit all targets*；右側 pane 預覽選中 commit 的變更；author 不同標 asterisk；同一檔跨多 commit 只列一次，diff 會合併；*Push tags*（All / Current Branch）；Push / Force push（`--force-with-lease`，protected branch 不可）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- Push Rejected dialog：*Update all repositories*、*Remember the update method choice and silently update in the future*、Rebase / Merge。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html

**Diff 開啟方式**
- Options → *Show on Double-Click*：Diff 或 Source。Advanced Settings：*Open Diff as Editor Tab*、*All-in-One Diff*（「all changed files are shown in a single, continuous Diff view」）。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html 、 https://www.jetbrains.com/help/idea/advanced-settings.html

**多 root 專案**
- Log：root 色條 + Show Root Names + Paths filter 勾 roots；Push dialog 列所有 repo；Branches popup 有 *Common Local Branches / Common Remote Branches* 區塊，需開 Settings | Version Control | Git 的 *Execute branch operations on all roots*（JetBrains 員工 2021 回覆）；Log 右鍵有 *In All Repositories*。 https://www.jetbrains.com/help/idea/log-tab.html 、 https://intellij-support.jetbrains.com/hc/en-us/community/posts/4408726305682-Project-with-multiple-git-repos
- Commit tool window 是否按 repository 分組：**(未在文件確認)**。

---

### 3. Diff viewer

**基本**
- 「You can compare files of any types, including binaries and .jar files.」開在新 tab；diff 內編輯器有 code completion、live templates；修改即時寫回檔案。 https://www.jetbrains.com/help/idea/differences-viewer.html
- 顏色：Green = Added、Blue = Modified、Gray = Deleted。 https://www.jetbrains.com/help/idea/differences-viewer.html

**檢視模式 / 設定（齒輪）**
- *Side-by-side viewer / Unified viewer*：兩種都可編輯與 Accept / Append / Revert；side-by-side 只能改右欄，unified 只能改下方行；唯讀檔不可編輯。 https://www.jetbrains.com/help/idea/differences-viewer.html
- *Align Changes in Side-by-Side Diff*（以空白填補對齊對應行）、*Synchronize Scrolling*、*Show Diff in Editor Tab* / *Show Diff in Separate Window*。 https://www.jetbrains.com/help/idea/differences-viewer.html
- *Ignore Differences* 五級：**None**（預設）、**Trim whitespaces**（只差尾端空白視為相同；By word 模式不高亮尾端空白）、**Ignore whitespaces**、**Ignore whitespaces and empty lines**（忽略純空白行增刪與純換行的拆合，例 `a b c` vs `a \n b c`）、**Ignore imports and formatting**（String literal 內空白仍比對）。 https://www.jetbrains.com/help/idea/differences-viewer.html
- *Highlighting Differences* 五種：**Words**、**Lines**、**Split changes**（大 change 拆小，例 `A \n B` vs `A X \n B X` 視為兩處）、**Characters**、**None**（建議大改檔案時用）。 https://www.jetbrains.com/help/idea/differences-viewer.html
- *Collapse Unchanged Fragments*；保留的 context 行數在 Tools | Diff & Merge 用 slider 設定。 https://www.jetbrains.com/help/idea/differences-viewer.html 、 https://www.jetbrains.com/help/idea/settings-tools-diff-and-merge.html

**導覽**
- *Previous / Next Difference*（Shift+F7 / F7）；到達最後/第一個差異時提示再按一次即切到下一個本地修改檔（受 *Go to the next file after reaching last change* 控制）。 https://www.jetbrains.com/help/idea/differences-viewer.html
- *Compare Previous / Next File*（Alt+← / Alt+→，多檔時才出現）、*Jump to Source*（F4，caret 停在相同位置）、Ctrl+Shift+D 常用 diff 指令 popup、Ctrl+Shift+Tab 切換欄。 https://www.jetbrains.com/help/idea/differences-viewer.html

**在 diff 內操作單一 chunk**
- 兩側 chevron **Accept**（套用差異）；按住 Ctrl 變成 **Append** chevron（附加而非取代）。 https://www.jetbrains.com/help/idea/differences-viewer.html
- Commit 的 diff 中每個 chunk 有 checkbox 決定是否納入 commit；gutter 上逐行 checkbox。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- 右鍵：Annotate、Show Whitespaces、Show Line Numbers、Show Indent Guides、Soft-Wrap、Highlighting level、Compare with Clipboard、*Switch to Three-Side Viewer*（載入第三個檔案）、Show code lens on scrollbar hover。 https://www.jetbrains.com/help/idea/differences-viewer.html
- 從 Local History diff 可用 gutter 的 revert 按鈕回滾單一修改。 https://blog.jetbrains.com/idea/2022/06/compare-anything-in-intellij-idea/

**三方合併**
- 衝突時先出 *Files Merged with Conflicts* dialog：Accept Yours / Accept Theirs / Merge。 https://www.jetbrains.com/help/idea/resolve-conflicts.html
- 三欄：左 read-only local、右 read-only repository 版本、中間「fully-functional editor」為結果；顏色 blue modified、grey deleted、green added、**red conflicting**。 https://www.jetbrains.com/help/idea/resolve-conflicts.html
- 工具列：*Apply All Non-Conflicting Changes*（可設為自動）、*Apply Non-Conflicting Changes from the Left/Right Side*、*Resolve Simple Conflicts*（魔杖，處理同一行前後段各改的情況）、*Compare Contents*（Base vs Middle 等組合）；Ctrl+Z 撤銷 merge 操作。 https://www.jetbrains.com/help/idea/differences-viewer.html
- Diff & Merge 設定：*Context lines* slider、*Go to the next file after reaching last change*、*Automatically apply non-conflicting changes*、*Highlight modified lines in gutter*。 https://www.jetbrains.com/help/idea/settings-tools-diff-and-merge.html
- 2024.2 新增 *Resolve Conflicts in Import Statements*；2026.2 標註「Streamlined Git conflict resolution flow」（無細節）。 https://www.jetbrains.com/idea/whatsnew/2024-2/ 、 https://blog.jetbrains.com/idea/2026/07/intellij-idea-2026-2/

**圖片 / 二進位 / 大檔**
- 2011 起「Every binary content you're able to open in IntelliJ might be compared in Diff Tool: UML diagrams, SWF files, of course images」。 https://blog.jetbrains.com/idea/2011/11/new-in-11-diff-tool-for-binary-files/
- 大檔案特殊處理：**(未在文件確認)**。

**其他**
- 資料夾 diff：以 size / content / timestamp 比對，工具列過濾「只在左」「只在右」「不同」「相同」，可 Synchronize。 https://www.jetbrains.com/help/idea/comparing-files-and-folders.html
- *Open Blank Diff Window*、可設外部 diff 工具。 https://www.jetbrains.com/help/idea/comparing-files-and-folders.html

---

### 4. 分支比較與 PR

**Compare branches**
- *Compare with Current*：「A new tab will be added to the Git tool window listing all commits that exist in the selected branch and do not exist in the current branch.」是**單向**列表，附 *Swap Branches* 連結切換基準；在該分頁按 Ctrl+A → Changed Files pane 列出兩 branch 所有差異檔。**沒有文件描述 A→B / B→A 兩欄並排。** https://www.jetbrains.com/help/idea/manage-branches.html
- *Show Diff with Working Tree*：開 Changes tool window；**灰 = 只在選中 branch 存在**、**綠 = 只在目前 branch 存在**、**藍 = 兩邊都有但內容不同**。 https://www.jetbrains.com/help/idea/manage-branches.html

**Branches popup（VCS widget）與 Branches pane**
- 節點：*Recent*（最多 5 個最近 checkout）、*Local*、*Remote*、*Tags*（2024.2 起有專屬節點）。 https://www.jetbrains.com/help/idea/manage-branches.html 、 https://www.jetbrains.com/idea/whatsnew/2024-2/
- 名稱含 `/` 的 branch 自動依目錄分組成可展開清單（可關）。 https://www.jetbrains.com/help/idea/manage-branches.html
- Favorites 永遠置頂（widget 與 Branches pane 皆是）；main 預設為 favorite；星號切換。 https://www.jetbrains.com/help/idea/manage-branches.html
- **Incoming / outgoing**：「the number of incoming commits that have not yet been fetched (blue arrow icon next to the branch name) and the number of outgoing commits (green arrow icon next to the branch name)」。相關設定：Advanced Settings *Check for incoming and outgoing commits*；Git 設定 *Check remote for incoming changes*。 https://www.jetbrains.com/help/idea/manage-branches.html 、 https://www.jetbrains.com/help/idea/advanced-settings.html 、 https://www.jetbrains.com/help/idea/settings-version-control-git.html
- Popup 內 Ctrl+F / speed search；齒輪：*Group by Directory*、*Show Recent Branches*、*Show Tags*。 https://www.jetbrains.com/help/idea/manage-branches.html
- 右鍵動作：Checkout、Checkout and Rebase onto、New Branch From、Compare with Current、Show Diff with Working Tree、Rebase current onto、Merge into current、New Worktree from、Pull into … Using Rebase / Merge、Update、Push、Rename、Delete。 https://www.jetbrains.com/help/idea/log-tab.html
- Welcome screen 的 recent projects 顯示各專案 checkout 的 branch 名（可關）。 https://www.jetbrains.com/help/idea/advanced-settings.html

**GitHub Pull Requests tool window**
- 開啟：Git | GitHub | View Pull Requests；Ctrl+F5 刷新；tool window 有白點、未讀 PR 藍點。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 過濾：state、author、label、assignee、review status；排序：newest / oldest / most-least commented / recently-least recently updated。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 雙擊 PR → *Overview* tab（PR 編號連結、branch 資訊、變更檔案含留言計數、*Changes from* 選 commit）與 *Timeline* tab（*View Timeline*）。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 點 branch 名 → *Checkout 'branch'* → 進入 **Review mode**：「you can see the highlighted changes and comments… right in the editor」；gutter **pink markers** 標示變更，點擊顯示原始碼 popup。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 留言：hover gutter 點 add icon（單行或多行）；*Add Single Comment*（立即送出）或 *Start Review*（pending 可再編輯）；*Submit* → Approve / Request changes / Comment；Ctrl+Alt+↑/↓ 在留言間跳；右鍵 *Jump to Source*（F4）。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 合併：Merge / Squash and Merge / Rebase 下拉；More → Request Review、Close Pull Request；合併後 timeline 內可刪 branch。 https://www.jetbrains.com/help/idea/work-with-github-pull-requests.html
- 「Mark file as viewed」、從 IDE 建立 PR 的流程：**(未在文件確認)**（本頁抓取內容未涵蓋）。

---

### 5. 常被稱讚的「清楚」細節

- **Annotate（blame）**：「Annotations for lines modified in the current revision are marked with a bold type and an asterisk」；「Different commits are highlighted with different colors」；hover annotation 高亮該 commit 對應的行；點擊跳 Log；右鍵 gutter 可選顯示 revision / date / author / commit number、Colors、Options（Ignore Whitespaces、Detect Movements Within File、Detect Movements Across Files、Show Commit Timestamp）；*Annotate Previous Revision*、*Hide Revision*（跳過格式化 commit）。Code Vision *Code author* inlay 預設在行上方，可改行尾。 https://www.jetbrains.com/help/idea/investigate-changes.html
- **Gutter change marker 工具列**：hover 顯示該行舊內容框，可 revert、show diff、複製舊內容、直接 commit 或指派 changelist / Stage。 https://www.jetbrains.com/help/idea/file-status-highlights.html 、 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
- **Show Repository at Revision**：以 Project view 快照瀏覽任一 commit 的整個專案；Reddit 使用者描述為「being able to browse any commit in the history as if you've checked it out」。 https://www.jetbrains.com/help/idea/log-tab.html 、 https://www.reddit.com/r/IntelliJIDEA/comments/z5yudy/lets_take_a_minute_to_appreciate_intellij_ideas/
- **Changelists**：HN 使用者 matsemann「It's sooo nice to have the different changelists. Easy to make changes that I don't want to accidentally commit by putting them on a different changelist」。 https://news.ycombinator.com/item?id=26367410
- **Diff / merge 工具**：HN solardev「resolve conflicts (best diff viewer I've used)」、「its Git interface is IMO still a bit better than Gitlens」，同時指 PR 介面「still a bit young and clunky」（2022）。 https://news.ycombinator.com/item?id=32683649
- **Commit dialog 工作流**：r/VisualStudioCode 發文者「I always find myself missing the workflow provided by IntelliJ's commit dialog」。 https://www.reddit.com/r/VisualStudioCode/comments/wzg8mq/git_commit_dialog_comparable_to_the_old/
- **Blame 為基本功能**：r/devops 評 VS Code「(no git blame, seriously?)」、列 IntelliJ「git client with git blame, history and more advanced features」為關鍵差異。 https://www.reddit.com/r/devops/comments/1ak758m/intellij_vs_vscode_is_intellij_still_the_best/
- **一站式 Git tool window**：mokkapps「The Git tool window shows branches, stashes, and local changes in a single place」、「Run a diff against branch or commit, and preview the results inline」、對 VS Code「the experience can feel piecemeal compared to IntelliJ's cohesive toolset」。 https://mokkapps.de/blog/why-i-switched-back-from-vscode-to-intellij-idea
- **Annotate hover 與 interactive rebase**：geekworkbench「Hover a line and the full commit appears in a tooltip with the message and changed files」、rebase 對話框「you drag to reorder commits, squash adjacent ones, or drop ones you don't want」。 https://geekworkbench.com/blog/technical/ide-git-integration/
- **Graph 清晰度的反面證據**（使用者覺得不清楚的點，可作為避雷）：IJPL-149533 列出 main 左右漂移、變色、merge 呈現不直覺、找不到 checked-out commit、parent/child 導覽差；JetBrains 以 2024.2「important branches stay left, retain colors」+ Topological Sort + First Parent 回應。 https://youtrack.jetbrains.com/issue/IJPL-149533 、 https://www.jetbrains.com/idea/whatsnew/2024-2/
- Changes 樹的目錄折疊/壓縮規則：**(未在文件確認)**。

---

### 關鍵行為清單：JetBrains 有、值得 VS Code 擴充對標（依日常清晰度影響排序）

1. **Current branch 的 commit 列淺藍底、其他白底**（Highlight → Current Branch 可關）。 https://www.jetbrains.com/help/idea/log-tab.html
2. **Label 顏色語意固定**：yellow = current head、green = local、violet = remote；label 預設在 message 右側；Compact References View 折疊多 ref；tag 只顯 icon、hover 出名。 https://www.jetbrains.com/help/idea/log-tab.html
3. **重要 branch 線固定靠左並保留顏色**（2024.2）+ Topological sort 讓被 merge 進來的 commit 緊貼在 merge commit 下方；First Parent / No Merges 簡化。 https://www.jetbrains.com/idea/whatsnew/2024-2/ 、 https://www.jetbrains.com/help/idea/log-tab.html
4. **Collapse Linear Branches 用虛線取代連續 commit、可點單條展開**；Long Edges 預設關、長邊以向下箭頭取代且可點跳；← / → 走 parent / child。 https://www.jetbrains.com/help/idea/log-tab.html
5. **My Commits 粗體、author ≠ committer 星號、merge / not-cherry-picked 淡化**。 https://www.jetbrains.com/help/idea/log-tab.html
6. **一列篩選器**：text（regex / match case、Ctrl+L）、Branch（含 favorites）、User、Date、Paths；**Go to Hash/Branch/Tag** 同名 ref 跨 repo 時右側顯示 repo 名與色標。 https://www.jetbrains.com/help/idea/log-tab.html
7. **右側 Changed Files + 其下 Commit Details 兩個 pane**；Show Diff Preview 就地預覽；group by directory / module 或 flat；merge commit 有 Show Changes to Parents。 https://www.jetbrains.com/help/idea/log-tab.html
8. **Commit Details 內容**：message、hash、author + email 連結、date/time、GPG、root、branches（>6 折疊 + Show All）、message 內 hash 與 issue 編號可點。 https://www.jetbrains.com/help/idea/log-tab.html
9. **多 root：左側彩色 root 色條 + hover 顯示路徑 + Show Root Names + Paths 篩選勾 root**。 https://www.jetbrains.com/help/idea/log-tab.html
10. **檔案狀態顏色全 IDE 一致**（Added 綠 `#0A7700`、Modified 藍 `#0032A0`、Deleted 灰 `#616161`、Unversioned 棕 `#993300`、Conflict 紅、Renamed 青），Project tree 目錄也著色。 https://www.jetbrains.com/help/idea/file-status-highlights.html
11. **Partial commit：diff 內每個 chunk 有 checkbox，gutter 可逐行勾，Split Chunks and Include Selected Lines**。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
12. **Staging 模式：已 stage 變更在 gutter 顯示 hollow marker；從 gutter Stage chunk；HEAD / Staged / Local 三欄可編輯中間欄做行級 stage**。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
13. **Changelist 與 Staging 兩種心智模型可切換不丟資料；Unversioned Files 節點勾了即 add + commit；Show Ignored Files**。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html 、 https://www.jetbrains.com/help/idea/file-status-highlights.html
14. **Commit message 輔助**：history 下拉、template、inspections + 自動換行 quick-fix、Amend 可選目標 commit、Author / Sign-off。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
15. **Commit and Push + Push dialog 預覽**：逐 repo 列待 push commit、右欄看變更、可改目標 branch/remote、tags 選項、force-with-lease 且 protected branch 禁用。 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
16. **Diff 五級 whitespace × 五種高亮粒度 + Collapse unchanged（context 行數 slider）+ Align Changes**。 https://www.jetbrains.com/help/idea/differences-viewer.html 、 https://www.jetbrains.com/help/idea/settings-tools-diff-and-merge.html
17. **Diff 導覽**：F7 / Shift+F7 到底自動提示切下一檔、Alt+← / → 換檔、F4 跳原檔且 caret 同位置。 https://www.jetbrains.com/help/idea/differences-viewer.html
18. **Diff 可開在 editor tab 或獨立視窗；All-in-One Diff 把所有檔案串成一個連續 diff；雙擊行為可選 Diff / Source**。 https://www.jetbrains.com/help/idea/advanced-settings.html 、 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
19. **Diff 內直接編輯 + Accept / Append chevron（Ctrl 切換）+ 單 chunk revert**。 https://www.jetbrains.com/help/idea/differences-viewer.html
20. **三欄 merge：左 local / 右 theirs 唯讀、中間可編輯；四色（藍改、綠增、灰刪、紅衝突）；Apply All Non-Conflicting、Resolve Simple Conflicts**。 https://www.jetbrains.com/help/idea/resolve-conflicts.html 、 https://www.jetbrains.com/help/idea/differences-viewer.html
21. **Compare with Current 單向 commit 列表 + Swap Branches + Ctrl+A 看所有差異檔；Show Diff with Working Tree 以灰 / 綠 / 藍區分「只在對方」「只在本地」「兩邊不同」**。 https://www.jetbrains.com/help/idea/manage-branches.html
22. **Branch 名旁 incoming（藍箭頭 + 數量）/ outgoing（綠箭頭 + 數量）**；favorites 置頂、Recent 節點、`/` 自動分組、Tags 節點。 https://www.jetbrains.com/help/idea/manage-branches.html
23. **Annotate：目前 revision 改的行粗體 + 星號、每個 commit 不同色、hover 高亮對應行、點擊跳 Log；Code Vision author inlay**。 https://www.jetbrains.com/help/idea/investigate-changes.html
24. **Gutter change marker hover 工具列**：顯示舊內容、revert、show diff、直接 commit / 指派 changelist / Stage。 https://www.jetbrains.com/help/idea/file-status-highlights.html 、 https://www.jetbrains.com/help/idea/commit-and-push-changes.html
25. **Show Repository at Revision**：任一 commit 的整棵專案樹快照。 https://www.jetbrains.com/help/idea/log-tab.html

**未能確認、審查時請勿當作 JetBrains 基準的項目**：hover 高亮整條 commit 路徑；Changes 樹目錄折疊/壓縮規則；Commit tool window 內 Directory / Module / Repository 分組；diff 大檔處理；PR 的 mark-as-viewed 與 IDE 內建 PR；commit message 檢查的完整清單；graph 車道顏色分配演算法（僅有 2024.2 的「stay left, retain colors」聲明）。
