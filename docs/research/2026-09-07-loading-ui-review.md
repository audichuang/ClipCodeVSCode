# Loading and UI review — 8e9f2d8

Reviewed 2026-09-07 on macOS against `d2e2d34...8e9f2d8` (12 commits). Fast-forward pull completed. Built the new host and webviews, then opened the development extension with `/Users/audi/GoogleDrive/cat`. This is a review: no product fixes or release actions were performed.

## Standards / operation safety

### P1 — Progressive paint understates the scope of Commit

`graph/src/tree/changes-tree.ts:72` publishes partial groups through the same event used by CommitBox to calculate its scope. `graph/src/tree/changes-workbench.ts:430` snapshots only unchecked repositories, then reads every repository again. Repositories still loading are implicitly selected.

Deterministic real-Git reproduction: A and B each have one staged file; block B's initial status with the existing Git shim. The partial tree reports one staged repository and one staged file. Calling Commit while that is the displayed scope ultimately commits BOTH A and B. The reproduction passed and was retained outside the product tree at `/tmp/snipcode-review-scope-repro.test.ts`.

This is an operation-scope bug rather than a literal style violation. Preserve progressive read-only display, but block Commit/Amend until the scope is complete, or freeze the explicitly displayed selection and enforce it in the host. A UI-only disabled button is insufficient if the shortcut/command path remains callable.

## Spec / user-visible behavior

### P2 — Added/deleted historical files cannot open in native Diff

Requirement: clicking a file in commit details opens its parent-versus-commit comparison. `graph/src/tree/recent-commits-view.ts:249` always supplies a Git URI for both sides; line 281 does the same for multi-diff.

Native reproduction in cat: cub-mock-gateway, commit `55c0bc2`, added file `sql/seed-filegrep-route.sql`. Clicking the file shows “The editor could not be opened because the file was not found.” The blob exists in the commit (2,182 bytes) and does not exist in its parent `f093e0a`. The native Git log confirms it is the LEFT URI that fails. Modified-file comparison opened normally.

The installed VS Code Git provider treats the empty-tree revision as empty content, but throws for an ordinary missing blob. Non-root additions therefore fail on the left; deletions fail on the right by the same code path. Root commits already use the empty-tree base and are an exception. The old full Graph had this flaw before the review baseline; the new sidebar details expose it on another surface.

Resolve side existence together with each file's actual comparison parent. Use an empty side for single Diff and omit absent sides for multi-diff. For merges, do not derive side existence solely from the union file status.

### P2 — Collapsing Diff leaves an invalid current-change index

Requirement: the new toolbar accurately shows current/total changes and navigates that same set. `graph/webview-ui/src/diff/Diff.svelte:149` refreshes the total after collapse but not the selected index. Native reproduction: open README.md with one staged and one unstaged hunk; click Next twice and collapse Unstaged. The toolbar shows **2/1**.

Additionally, lines 116–122 bound Next but not Previous, and dereference `hunks[next]` without a guard. With four hunks reduced to one, Previous would throw. The 2/1 state was observed natively; the out-of-range throw is established by the code path, not claimed as a native reproduction. Recompute/reset selection whenever the rendered hunk set changes and bound both directions.

### P2 — Keyboard Open File opens historical Diff instead

Requirement: the inline Open File action opens the working file. `graph/webview-ui/src/workbench/RecentCommits.svelte:530` handles Enter/Space bubbling from its child button and prevents that button's default activation.

Native reproduction: select cub-mock-gateway commit `f093e0a`, Tab to the inline Open File button for CLAUDE.md, press Enter. It opens `CLAUDE.md (f093e0a)` as a historical Diff. A focused test also confirms the wrong `recentCommitsOpenFile` message. Only handle row keyboard activation when `event.target === event.currentTarget`.

### P2 — Quick hide/show can strand commit details on Loading

Requirement / documented convention: requests whose replies disappear need recovery. The host drops file replies while hidden. `RecentCommits.svelte:384` retries only on a state message that arrives at least one second after the request; there is no timer for the remaining interval.

Focused reproduction: issue selection, simulate the unanswered hidden query, send the visible state after 200ms, then advance another two seconds without repository activity. No retry is sent. This is a deterministic component test, not a claimed native timing reproduction. Ensure visibility recovery schedules or issues the missing request.

### P2 — HC Light change-count badge has unreadable contrast

Requirement: the new change counter must remain readable. Natively inspected Dark Modern, Light Modern and Default High Contrast Light. In HC Light the count is dark text on a dark-blue badge.

`Diff.svelte:400–405` combines `badge.background` with `descriptionForeground`/`foreground`. Installed VS Code defaults are background `#0F4A85`, foreground `#292929`, description foreground at 70% alpha: contrast is approximately **1.62:1** for the current number and **1.44:1** for the denominator. The paired `badge.foreground` is white (**8.98:1**). Use that token for the count and let its bold child inherit it.

## Performance measurements

Read-only discovery against real cat, three trials, median milliseconds; warmed filesystem, separately executed old/new modules. These are discovery timings, NOT VS Code first-paint or end-to-end startup timings.

| Layout | Old first batch | New first batch | Old complete | New complete |
|---|---:|---:|---:|---:|
| cat as one workspace root, 25 discovered repos | 47 | 66 | 515 | 481 |
| 24 direct repository roots, 26 discovered repos | 181 | 52 | 637 | 534 |

The multiple-root fast pass improved about 71%; the single-root case does not establish a first-batch improvement. Raw trials are `/tmp/snipcode-discovery-review-benchmark.json`. Production Diff highlighted JSON and Markdown correctly in native VS Code; this review did not repeat the author's instrumented before/after Diff paint benchmark, so their 300ms-to-118ms result is not independently certified here.

## Visual assessment and next optimization

The sidebar now uses its width more effectively: branch labels are recognizable, commit details remain beside code, and changed files occupy a separate scroll area. The Diff gutter and lighter hunk dividers give code more emphasis. These changes are worth keeping.

After the correctness fixes, the most useful small improvement would be a visible active-repository name in the Recent Commits title/summary. Currently a populated view exposes the repo path only in a tooltip; in a multi-repo workspace the branch badge and counts alone do not say whose history is shown. Keep Stage Hunk discoverable when its ghost styling is not hovered. Neither suggestion warrants another large redesign.

## Validation and boundaries

- Host: **185 passed**, 0 failed.
- Graph: **2,453 passed**, 11 skipped, 162 test files.
- Svelte: 0 errors / 0 warnings; graph TypeScript check passed.
- Existing local VS Code E2E: **7 passed**. These do not cover the newly found native Diff/keyboard interactions.
- Native tests used icons, file rows and normal Tab/Enter navigation; setup/build and read-only diagnostics used the CLI.
- Cat was not staged, committed or edited by this review. Before/after snapshots retain identical HEAD and staged diffs for all 25 baseline repositories. `inv-svc-bfs-query` acquired a working-tree/status change during the session; this review did not operate on that repository, so it is not reported as globally unchanged.
- Test workspace theme was restored to Dark Modern. No commit, push, tag or publishing was performed after pulling.

Review totals: **Standards/operation safety: 1 finding (worst P1 scope mismatch). Spec/UI: 5 findings (P2).**
