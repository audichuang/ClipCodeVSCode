<script lang="ts">
  import type { DiffData } from '../../lib/types';
  /* SNIPCODE-HOOK start: perf — progressive reveal (untrack: the paint pass writes paintBudget) */
  import { onMount, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  /* SNIPCODE-HOOK end */
  import { t } from '../../lib/i18n/index.svelte';
  import { detectLanguage, highlightLineSync, highlightLineWithRanges, getHighlighter, ensureLanguage, activeShikiTheme, escapeHtml } from '../../lib/utils/highlighter';
  /* SNIPCODE-HOOK (B-2d): intraline word-level diff. */
  import { pairHunkWordDiffs } from '../../lib/utils/word-diff';
  import ImageDiff from '../common/ImageDiff.svelte';
  import { warmHighlightWorker, highlightWorkerBatch } from '../../lib/utils/highlight-worker-client';

  // Right-click target on a diff line. The parent owns the context menu (it
  // already hosts one for the file tree), so we just hand it the location plus
  // enough to address the change: the hunk index lines up with the diff the
  // backend re-parses (see patch-builder / git-parser), where omitting line
  // indices reverses the whole hunk.
  export interface ReverseTarget {
    commitHash: string;
    file: string;
    hunkIndex: number;
    // The changed (+/-) line indices the user selected via the gutter drag,
    // addressing a subset of the hunk to reverse. Omitted reverses the whole hunk.
    selectedLineIndices?: number[];
    selectionText: string;
    // Raw newline-joined text of every gutter-selected line, set only when the
    // right-click originates in the gutter and a line selection is active. The
    // parent offers a "Copy Lines" menu item when present. An empty string is a
    // valid value (a lone blank line was selected), so the parent gates on
    // `!== undefined`, not truthiness. `copyLinesCount` carries the matching
    // line count so the parent need not re-split the text.
    copyLinesText?: string;
    copyLinesCount?: number;
    x: number;
    y: number;
  }

  interface Props {
    diff: DiffData;
    commitHash?: string;
    // Only meaningful for the UNCOMMITTED view: whether the selected file is in
    // the staged (index) tab. Drives the image diff's before/after refs.
    staged?: boolean;
    stacked?: boolean;
    // Optional commit label shown in the toolbar (used by stacked per-commit sections).
    heading?: string;
    // When provided (committed view only), right-clicking a diff line offers to
    // reverse that whole hunk against the working tree.
    onReverse?: (target: ReverseTarget) => void;
    // When provided (committed view only), the per-hunk header "Reverse Hunk"
    // button reverses that hunk immediately (no context menu).
    onReverseHunk?: (target: { commitHash: string; file: string; hunkIndex: number }) => void;
    // When provided (committed view only), the "Reverse Selected Lines" button
    // reverses just the dragged changed lines of a hunk immediately.
    onReverseLines?: (target: { commitHash: string; file: string; hunkIndex: number; lineIndices: number[] }) => void;
    /* SNIPCODE-HOOK start: PR tab inline diff (Task D1) — optional controlled
       diff-mode so PrView's toolbar can drive inline/side-by-side across every
       stacked FileDiffView from one control. Omitted (existing CommitDetails
       usage) falls back to the local uncontrolled toggle — fully backward
       compatible, see `mode` below. */
    diffMode?: 'inline' | 'side-by-side';
    hideModeToggle?: boolean;
    /* SNIPCODE-HOOK (B-2c): full-tab stage/unstage. Fires per-hunk with the file
       + hunk index; the button label follows `staged` (unstaged file → "Stage
       Hunk", staged file → "Unstage Hunk"). Line-level staging (B-2d) is
       onStageLines below. */
    onStageHunk?: (target: { file: string; hunkIndex: number }) => void;
    /* SNIPCODE-HOOK (B-2d): line-level staging. Fires with the file + hunk index
       + the gutter-selected changed line indices, mirroring onReverseLines. */
    onStageLines?: (target: { file: string; hunkIndex: number; lineIndices: number[] }) => void;
    /* SNIPCODE-HOOK start (B-2c): full-tab busy gate — Diff.svelte passes
       diffStore.busy so the Stage/Unstage buttons disable while a hunk op is
       in flight (index shifts once the diff re-parses). Omitted by every other
       caller (CommitDetails, PrView), so `undefined` there never disables. */
    stageBusy?: boolean;
    /* SNIPCODE-HOOK start: Batch B image request identity */
    imageRepoPath?: string;
    imageGeneration?: number;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK end */
    onSelectedLineChange?: (line: number | undefined) => void;
  }

  /* SNIPCODE-HOOK start: Batch B image request identity */
  let { diff, commitHash, staged = false, stacked = false, heading, onReverse, onReverseHunk, onReverseLines, onStageHunk, onStageLines, diffMode: diffModeProp, hideModeToggle = false, stageBusy, imageRepoPath, imageGeneration, onSelectedLineChange }: Props = $props();
  /* SNIPCODE-HOOK end */

  // Whether this diff supports reversing (committed view). Drives both the
  // right-click menu and the per-hunk header reverse affordance. Whole-file
  // additions/deletions reverse too: reversing every line of an added file's
  // hunk removes it, and of a deleted file's hunk restores it (the backend's
  // patch-builder rewrites the whole-file header for partial selections).
  const canReverse = $derived(!!onReverse && !!commitHash);

  /* SNIPCODE-HOOK start: ui/diff D4 CRLF marker */
  // Only worth flagging when the two sides actually DISAGREE on line ending —
  // a file that's consistently CRLF throughout shouldn't get a ␍ badge on
  // every single line (noise); a mixed file is exactly the "you can't see
  // the EOL-only change" case D4 targets.
  const hasMixedCr = $derived.by(() => {
    if (!diff || diff.isBinary) return false;
    let sawCr = false;
    let sawNoCr = false;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.cr) sawCr = true; else sawNoCr = true;
        if (sawCr && sawNoCr) return true;
      }
    }
    return false;
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start (B-2c): staging affordance gate + action. */
  const canStage = $derived(!!onStageHunk);
  /* SNIPCODE-HOOK (B-2d): gutter line-selection turns on for the reverse view
     (canReverse) OR the staging view (canStage). */
  const canSelectLines = $derived(canReverse || canStage);

  function stageHunk(hunkIndex: number) {
    if (!onStageHunk || !isHunkComplete(hunkIndex)) return;
    onStageHunk({ file: diff.file, hunkIndex });
  }

  /* SNIPCODE-HOOK (B-2d): stage/unstage just the gutter-selected changed lines. */
  function stageSelectedLines(hunkIndex: number) {
    if (!onStageLines || !lineSel || lineSel.hunkIdx !== hunkIndex) return;
    const indices = selectedChangedIndices;
    if (!indices.length || !isHunkComplete(hunkIndex)) return;
    onStageLines({ file: diff.file, hunkIndex, lineIndices: indices });
  }

  /* SNIPCODE-HOOK: IntelliJ-style per-change-block staging. stage/unstage exactly
     the lines of one contiguous +/- block (the gutter arrow that sits next to it). */
  function stageBlock(hunkIndex: number, lineIndices: number[]) {
    if (!onStageLines || !lineIndices.length || !isHunkComplete(hunkIndex)) return;
    onStageLines({ file: diff.file, hunkIndex, lineIndices });
  }
  /* SNIPCODE-HOOK end */

  // A truncated diff renders only the first N lines of its final hunk (see
  // renderHunks). Reversing then would silently undo the unseen tail too, so we
  // only allow reverse on hunks rendered in full. Untruncated diffs are always
  // complete (renderHunks === diff.hunks).
  function isHunkComplete(hunkIndex: number): boolean {
    const full = diff.hunks[hunkIndex];
    const shown = renderHunks[hunkIndex];
    return !!full && !!shown && shown.lines.length === full.lines.length;
  }

  // Drag-to-select whole lines in the inline gutter (single hunk at a time).
  // `indices` holds every line index the drag has covered; the right-click menu
  // then narrows it to just the changed (+/-) lines via selectedChangedIndices.
  let lineSel = $state<{ hunkIdx: number; anchor: number; indices: Set<number> } | null>(null);
  // Plain (non-reactive) flag tracking whether a gutter drag is in progress.
  let dragging = false;

  // SBS: the hunk currently under the cursor (in either pane), highlighted in
  // both panes so the reverse extent is obvious before right-clicking.
  let hoveredHunkIdx = $state<number | null>(null);

  // All indices from min(a,b)..max(a,b) inclusive.
  function rangeSet(a: number, b: number): Set<number> {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out = new Set<number>();
    for (let i = lo; i <= hi; i++) out.add(i);
    return out;
  }

  function getSelectedWorkingLine(): number | undefined {
    if (!lineSel) return undefined;
    const hunk = diff.hunks[lineSel.hunkIdx];
    if (!hunk) return undefined;
    const indices = [...lineSel.indices].sort((a, b) => a - b);
    for (const idx of indices) {
      const line = hunk.lines[idx];
      if (line) {
        if (typeof line.newLineNumber === 'number') return line.newLineNumber;
        for (let i = idx + 1; i < hunk.lines.length; i++) {
          if (typeof hunk.lines[i]?.newLineNumber === 'number') return hunk.lines[i].newLineNumber;
        }
        for (let i = idx - 1; i >= 0; i--) {
          if (typeof hunk.lines[i]?.newLineNumber === 'number') return hunk.lines[i].newLineNumber;
        }
        return hunk.newStart;
      }
    }
    return hunk.newStart;
  }

  $effect(() => {
    onSelectedLineChange?.(getSelectedWorkingLine());
  });

  // The selected line indices that are actually reversible (+/- lines), sorted.
  // Context lines in the dragged range are dropped. Pure projection of lineSel +
  // diff.hunks, so it's derived rather than recomputed on every template access.
  const selectedChangedIndices = $derived.by<number[]>(() => {
    if (!lineSel) return [];
    const hunk = diff.hunks[lineSel.hunkIdx];
    if (!hunk) return [];
    return [...lineSel.indices]
      .filter(i => hunk.lines[i] && hunk.lines[i].type !== 'context')
      .sort((a, b) => a - b);
  });

  // The full text of every currently selected line (context included), in line
  // order, joined by newlines — for the "Copy Lines" gutter action.
  function selectedLinesText(): string {
    if (!lineSel) return '';
    const hunk = diff.hunks[lineSel.hunkIdx];
    if (!hunk) return '';
    return [...lineSel.indices]
      .sort((a, b) => a - b)
      .map(i => hunk.lines[i]?.content ?? '')
      .join('\n');
  }

  function startLineSelect(e: MouseEvent, hunkIdx: number, lineIndex: number) {
    if (e.button !== 0) return; // right/middle-click must not reset an active selection
    if (!canSelectLines || !isHunkComplete(hunkIdx)) return;
    e.preventDefault(); // suppress native text-selection beginning in the gutter
    if (e.shiftKey && lineSel && lineSel.hunkIdx === hunkIdx) {
      lineSel = { ...lineSel, indices: rangeSet(lineSel.anchor, lineIndex) };
      return;
    }
    // Plain click on a line already in the selection → deselect.
    if (lineSel && lineSel.hunkIdx === hunkIdx && lineSel.indices.has(lineIndex)) {
      lineSel = null;
      return;
    }
    lineSel = { hunkIdx, anchor: lineIndex, indices: rangeSet(lineIndex, lineIndex) };
    dragging = true;
    window.addEventListener('mouseup', () => { dragging = false; }, { once: true });
  }

  function extendLineSelect(_e: MouseEvent, hunkIdx: number, lineIndex: number) {
    if (dragging && lineSel && lineSel.hunkIdx === hunkIdx) {
      lineSel = { ...lineSel, indices: rangeSet(lineSel.anchor, lineIndex) };
    }
  }

  function handleLineContextMenu(e: MouseEvent, hunkIndex: number, lineIndex = -1) {
    if (!onReverse || !commitHash) return;                 // not reversible → native menu
    const changed = selectedChangedIndices;
    // Only offer "Reverse Selected Lines" when the right-click lands on a line
    // that is part of the active selection; otherwise fall back to whole-hunk.
    const inSelection = !!lineSel && lineSel.hunkIdx === hunkIndex && lineSel.indices.has(lineIndex) && changed.length > 0;
    const sel = inSelection ? { hunkIdx: lineSel!.hunkIdx, indices: changed } : null;
    const targetHunk = sel ? sel.hunkIdx : hunkIndex;
    if (!isHunkComplete(targetHunk)) return;              // truncated hunk → don't reverse unseen lines
    e.preventDefault();
    const selectionText = window.getSelection()?.toString() ?? '';
    // Right-clicking the gutter while lines are selected → offer "Copy Lines".
    // Restricted to the SAME hunk that holds the selection so the menu never
    // mixes one hunk's "Copy Lines" with another hunk's "Reverse Hunk".
    const inGutter = !!(e.target as HTMLElement).closest('.line-gutter');
    const hasCopyLines = inGutter && !!lineSel && lineSel.hunkIdx === hunkIndex && lineSel.indices.size > 0;
    onReverse({
      commitHash,
      file: diff.file,
      hunkIndex: targetHunk,
      selectedLineIndices: sel ? sel.indices : undefined,
      selectionText,
      copyLinesText: hasCopyLines ? selectedLinesText() : undefined,
      copyLinesCount: hasCopyLines ? lineSel!.indices.size : undefined,
      x: e.clientX,
      y: e.clientY,
    });
  }

  function reverseHunk(hunkIndex: number) {
    if (!onReverseHunk || !commitHash || !isHunkComplete(hunkIndex)) return;
    onReverseHunk({ commitHash, file: diff.file, hunkIndex });
  }

  function reverseSelectedLines() {
    if (!onReverseLines || !commitHash || !lineSel) return;
    const indices = selectedChangedIndices;
    if (!indices.length || !isHunkComplete(lineSel.hunkIdx)) return;
    onReverseLines({ commitHash, file: diff.file, hunkIndex: lineSel.hunkIdx, lineIndices: indices });
  }

  // Friendly hunk header label, e.g. "Hunk 1: Lines 1-5". Uses the new-side range
  // (what the file looks like after the change); falls back to the old side for
  // pure-deletion hunks where the new side is empty.
  function hunkLabel(hunk: DiffData['hunks'][number], hunkIdx: number): string {
    const useNew = hunk.newLines > 0;
    const start = useNew ? hunk.newStart : hunk.oldStart;
    const count = useNew ? hunk.newLines : hunk.oldLines;
    const end = start + Math.max(count, 1) - 1;
    const range = end > start ? `${start}-${end}` : `${start}`;
    /* SNIPCODE-HOOK start: X1-7 hunk header label through i18n (was hardcoded "Hunk N:") */
    return t('file.hunkLabel', { n: hunkIdx + 1, range });
    /* SNIPCODE-HOOK end */
  }

  function getFileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  // Syntax highlighting
  /* SNIPCODE-HOOK start: publish only changed keys; replacing the entire map
     invalidates every already-visible line on each progressive reveal step. */
  const highlightedLines = new SvelteMap<string, string>();
  /* SNIPCODE-HOOK end */
  let sbsLeftEl = $state<HTMLElement | undefined>();
  let sbsRightEl = $state<HTMLElement | undefined>();
  let sbsCenterEl = $state<HTMLElement | undefined>();
  let isSyncing = false;

  function handleSbsScroll(e: Event) {
    if (isSyncing) return;
    const target = e.target as HTMLElement;
    const other = target === sbsLeftEl ? sbsRightEl : sbsLeftEl;
    if (other) {
      isSyncing = true;
      other.scrollTop = target.scrollTop;
      other.scrollLeft = target.scrollLeft;
      if (sbsCenterEl) sbsCenterEl.scrollTop = target.scrollTop;
      requestAnimationFrame(() => { isSyncing = false; });
    }
  }

  // Cap how many diff lines we render to the DOM at once. A very large diff
  // (lockfiles, generated files, mass deletions) would otherwise create tens of
  // thousands of nodes on open and freeze the panel. Past the cap we render the
  // first N lines and offer a "show full diff" button — same opt-in philosophy
  // as MAX_HIGHLIGHT_LINES. Side-by-side roughly doubles the node count, so the
  // cap is deliberately below the highlight cap.
  const MAX_RENDER_LINES = 3000;
  let showFullDiff = $state(false);

  // Reset the toggle whenever the diff prop changes, so opening a new large
  // diff starts collapsed even if the previous one was expanded.
  $effect(() => {
    diff;
    /* SNIPCODE-HOOK start: D7 stop clobbering the highlight cache on every diff
       change. The old eager reset cleared it synchronously the instant `diff`
       changed (e.g. every stage/unstage re-push), so every unchanged line
       flashed plain (unhighlighted) text until the async highlight pass below
       finished. The highlighting $effect now owns `highlightedLines` fully —
       it reuses cache entries whose content-addressed key still matches and
       only recomputes the rest, so there's no reason to blank it here. */
    showFullDiff = false;
    lineSel = null;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: perf — the progressive reveal restarts for a NEW FILE
       only. A same-file re-push (every stage/unstage) keeps its rows: collapsing
       the budget there would blank the diff for a frame — the flash D7 removed. */
    if (diff && diff.file !== paintFile) {
      paintFile = diff.file;
      paintBudget = firstStep();
    }
    /* SNIPCODE-HOOK end */
  });

  /* SNIPCODE-HOOK start: PR tab inline diff (Task D1) — `internalMode` is the
     pre-existing local toggle state (unchanged behavior for CommitDetails,
     which never passes `diffMode`); `mode` resolves to the controlling prop
     when the parent supplies one (PrView), otherwise falls back to
     `internalMode`. Template/toggle below use `mode` exclusively. */
  let internalMode = $state<'inline' | 'side-by-side'>('inline');
  const mode = $derived(diffModeProp ?? internalMode);
  /* SNIPCODE-HOOK end */

  let totalDiffLines = $derived(
    diff && !diff.isBinary
      ? diff.hunks.reduce((s, h) => s + h.lines.length, 0)
      : 0
  );
  let diffTruncated = $derived(!showFullDiff && totalDiffLines > MAX_RENDER_LINES);

  /* SNIPCODE-HOOK start: Batch C describe file/content-aware highlight keys. */
  // Hunks actually handed to the template. When truncated, include whole hunks
  // until the line budget runs out, slicing the final partial hunk. The sliced
  // hunk keeps its original `oldStart`, content, and first-N line indices, so
  // its file/content-aware highlight keys still line up.
  /* SNIPCODE-HOOK end */
  let renderHunks = $derived.by(() => {
    if (!diff || diff.isBinary) return [];
    if (!diffTruncated) return diff.hunks;
    const out: typeof diff.hunks = [];
    let budget = MAX_RENDER_LINES;
    for (const hunk of diff.hunks) {
      if (budget <= 0) break;
      if (hunk.lines.length <= budget) {
        out.push(hunk);
        budget -= hunk.lines.length;
      } else {
        out.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
        budget = 0;
      }
    }
    return out;
  });

  /* SNIPCODE-HOOK start: perf — reveal rows in steps, first screen first.
     Measured on the production bundle (480-line java diff, 40 hunks, headless
     Chrome, real time): opening a file was ONE ~130ms task — Svelte building
     all 480 rows (48ms) and then, still before the browser got a frame, the
     grammar load plus the first 250-line highlight chunk (~65ms). The first
     paint arrived at ~140ms, already coloured: nothing was slow per se, the
     task was shaped wrong. Now every hunk CONTAINER still renders in the first
     flush (Diff.svelte counts `.diff-hunk` right after the DOM patch for its
     N/M hunk counter, so it must never see a partial list), but only the first
     `firstStep()` rows are built and tokenised before the first frame; the tail
     fills in STEP rows per task behind it, each step highlighted BEFORE it is
     revealed so a row mounts coloured exactly once. Reveal order is document
     order — the same order the highlight pass runs — so the two share the one
     loop in the paint pass below. `renderHunks` keeps meaning "what this diff
     shows" (truncation, isHunkComplete, block arrows); `paintHunks` is only
     "what is on screen right now". */
  // .diff-line is min-height 20px; this only sizes the first step, never layout.
  const ROW_PX = 20;
  // 優化後續批次顆粒至 100 行，單次主執行緒任務控制在 25ms 內，兼顧高吞吐量與低互動延遲
  const STEP = 100;
  // One viewport of rows plus slack, so the first frame is a full screen on a
  // tall monitor too. Clamped: a hidden/zero-height webview must still reveal.
  function firstStep(): number {
    const rows = typeof window !== 'undefined' ? Math.ceil((window.innerHeight || 0) / ROW_PX) : 0;
    return Math.min(240, Math.max(60, rows + 20));
  }
  let paintBudget = $state(firstStep());
  // Deliberately the INITIAL file (untrack silences state_referenced_locally):
  // the per-diff reset effect above compares against it to spot a file change.
  let paintFile = untrack(() => diff?.file);
  const EMPTY_LINES: DiffLine[] = [];
  const paintHunks = $derived.by(() => {
    let left = paintBudget;
    return renderHunks.map(hunk => {
      // Fully revealed → same object, so Svelte sees no change for that hunk.
      if (left >= hunk.lines.length) { left -= hunk.lines.length; return hunk; }
      // slice(0, n) keeps line indices, so lineSel / highlight keys line up.
      const shown = { ...hunk, lines: left > 0 ? hunk.lines.slice(0, left) : EMPTY_LINES };
      left = 0;
      return shown;
    });
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch C align replacement rows side-by-side. */
  type DiffLine = DiffData['hunks'][number]['lines'][number];
  interface SbsLine { line: DiffLine; index: number }
  interface SbsRow { left?: SbsLine; right?: SbsLine }

  function pairSideBySideRows(lines: DiffLine[]): SbsRow[] {
    const rows: SbsRow[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type === 'context') {
        const entry = { line: lines[i], index: i };
        rows.push({ left: entry, right: entry });
        i++;
        continue;
      }
      if (lines[i].type === 'add') {
        rows.push({ right: { line: lines[i], index: i } });
        i++;
        continue;
      }
      const deletes: SbsLine[] = [];
      while (i < lines.length && lines[i].type === 'delete') {
        deletes.push({ line: lines[i], index: i });
        i++;
      }
      const adds: SbsLine[] = [];
      while (i < lines.length && lines[i].type === 'add') {
        adds.push({ line: lines[i], index: i });
        i++;
      }
      for (let row = 0; row < Math.max(deletes.length, adds.length); row++) {
        rows.push({ left: deletes[row], right: adds[row] });
      }
    }
    return rows;
  }

  /* SNIPCODE-HOOK start: perf — rows follow the reveal, not the full render set */
  const EMPTY_SBS_ROWS: SbsRow[] = [];
  const sbsCache = new WeakMap<DiffLine[], SbsRow[]>();
  function getCachedSbsRows(lines: DiffLine[]): SbsRow[] {
    if (lines.length === 0) return EMPTY_SBS_ROWS;
    let cached = sbsCache.get(lines);
    if (!cached) {
      cached = pairSideBySideRows(lines);
      sbsCache.set(lines, cached);
    }
    return cached;
  }
  const sbsRows = $derived(paintHunks.map(hunk => getCachedSbsRows(hunk.lines)));
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: contiguous change blocks per hunk. Each run of adjacent
     +/- lines is one block; the SBS gutter arrow anchors on the block's first
     line so it sits next to the actual change (not the hunk top). Keyed
     hunkIdx → (firstLineIndex → all line indices in that block) for O(1) lookup
     in the render loop. */
  const blockFirstByHunk = $derived.by(() => {
    const map = new Map<number, Map<number, number[]>>();
    renderHunks.forEach((hunk, hunkIdx) => {
      const byFirst = new Map<number, number[]>();
      let cur: number[] | null = null;
      hunk.lines.forEach((line, i) => {
        if (line.type !== 'context') {
          if (!cur) { cur = []; byFirst.set(i, cur); }
          cur.push(i);
        } else {
          cur = null;
        }
      });
      map.set(hunkIdx, byFirst);
    });
    return map;
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start (B-2d): per-line word-diff ranges, keyed like the
     highlight cache so the effect can overlay them on the Shiki output. */
  const wordDiffByKey = $derived.by(() => {
    const map = new Map<string, { ranges: import('../../lib/utils/word-diff').Range[]; kind: 'add' | 'delete' }>();
    for (const hunk of renderHunks) {
      const paired = pairHunkWordDiffs(hunk.lines);
      for (const [lineIdx, entry] of paired) {
        map.set(highlightKey(diff.file, hunk.oldStart, lineIdx, hunk.lines[lineIdx].content), entry);
      }
    }
    return map;
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch C bind cached HTML to file and content identity. */
  function highlightKey(file: string, hunkStart: number, lineIdx: number, content: string): string {
    return JSON.stringify([file, hunkStart, lineIdx, content]);
  }
  /* SNIPCODE-HOOK end */

  const MAX_HIGHLIGHT_LINES = 5000;

  /* SNIPCODE-HOOK start: D7 incremental highlight cache */
  // Theme the currently-cached HTML was rendered under. A cache entry is only
  // reusable when the theme hasn't changed since — reusing dark-plus HTML
  // under a light theme would render wrong-colored tokens.
  let lastHighlightTheme: 'dark-plus' | 'light-plus' | undefined;
  /* SNIPCODE-HOOK end */

  // Tracks the VS Code color theme so highlighting re-runs (with the matching
  // light/dark token colours) when the user switches themes mid-session.
  let shikiTheme = $state<'dark-plus' | 'light-plus'>(activeShikiTheme());
  onMount(() => {
    const observer = new MutationObserver(() => { shikiTheme = activeShikiTheme(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  });

  // Escape clears any active gutter line-selection.
  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => { if (e.key === 'Escape') lineSel = null; };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  /* SNIPCODE-HOOK start: perf — the paint pass: one loop that highlights AND
     reveals, first screen first (see paintHunks above for the measurements).
     Per step: tokenise the next lines, then publish `highlightedLines` and
     raise `paintBudget` in the same synchronous stretch, so Svelte mounts the
     new rows already coloured in one flush — no plain→coloured double render,
     and no plain flash. Step 1 covers exactly the rows the first flush mounted
     plain (firstStep()); with a warm engine that is all microtasks, so the
     very first frame is coloured. Later steps yield a task between them so
     paint and input run while the tail fills in.
     Restructured from the Batch C / D7 chunked pass: the D7 content-addressed
     cache is unchanged (a same-file re-push reuses every untouched line, no
     flash), but `lastHighlightTheme` is now recorded on the FIRST publish —
     a pass cancelled mid-way (fast file switch, theme flip) used to throw the
     whole cache away on restart because it was only set after the last chunk.
     The no-grammar / CSP-refused / over-cap paths used to return early; they
     must still run the loop, or the tail of the diff never reveals. */
  $effect(() => {
    if (!diff || diff.isBinary) return;
    const target = diff;
    const lang = detectLanguage(diff.file);
    const totalLines = diff.hunks.reduce((s, h) => s + h.lines.length, 0);
    const wantHighlight = !!lang && totalLines <= MAX_HIGHLIGHT_LINES;
    // Only what's actually rendered (renderHunks is capped at MAX_RENDER_LINES).
    // Toggling showFullDiff changes renderHunks and re-runs this effect, so the
    // newly rendered tail is revealed and highlighted then — in steps too.
    const visibleHunks = renderHunks;
    const theme = shikiTheme; // capture so a theme switch invalidates the pass
    let cancelled = false;
    const workerAbort = new AbortController();
    if (wantHighlight && totalLines > 400) warmHighlightWorker(lang);
    const stale = () => cancelled || diff !== target;
    const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    (async () => {
      let h: Awaited<ReturnType<typeof getHighlighter>> | null = null;
      let ready = false;
      if (wantHighlight) {
        // Grammars load on demand; a language without a Shiki grammar (or an
        // engine the host CSP refused) reveals plain text instead.
        try {
          h = await getHighlighter();
          if (stale()) return;
          ready = await ensureLanguage(h, lang);
        } catch {
          ready = false;
        }
        if (stale()) return;
      }
      // D7: reuse cache entries whose content-addressed key is unchanged (same
      // file+hunkStart+lineIndex+content — see highlightKey) so an unrelated
      // hunk's stage/unstage doesn't re-highlight — or flash — every OTHER line.
      const reusable = ready && theme === lastHighlightTheme ? highlightedLines : undefined;

      const flat: Array<{ key: string; content: string }> = [];
      for (const hunk of visibleHunks) {
        for (let i = 0; i < hunk.lines.length; i++) {
          flat.push({ key: highlightKey(target.file, hunk.oldStart, i, hunk.lines[i].content), content: hunk.lines[i].content });
        }
      }
      // Bound retained HTML to this render set even after cancelled passes.
      // A partial theme pass must never mix old-theme tail entries into its cache.
      const activeKeys = new Set(flat.map(line => line.key));
      untrack(() => {
        if (theme !== lastHighlightTheme) highlightedLines.clear();
        for (const key of highlightedLines.keys()) {
          if (!activeKeys.has(key)) highlightedLines.delete(key);
        }
      });
      let pos = 0;
      let first = true;
      do {
        const end = Math.min(flat.length, pos + (first ? firstStep() : STEP));
        if (ready && h) {
          const missing = flat.slice(pos, end).filter(line => reusable?.get(line.key) === undefined);
          const work = missing.map(line => ({ content: line.content, ...wordDiffByKey.get(line.key) }));
          const background = first ? undefined : await highlightWorkerBatch(work, lang, theme, workerAbort.signal);
          if (stale()) return;
          missing.forEach(({ key, content }, index) => {
            const wd = wordDiffByKey.get(key);
            highlightedLines.set(key, background?.[index] ?? (wd
              ? highlightLineWithRanges(h!, content, lang, wd.ranges, wd.kind, theme)
              : highlightLineSync(h!, content, lang, theme)));
          });
          // SvelteMap notifies only the rows whose cached HTML changed.
          lastHighlightTheme = theme;
        } else if (first) {
          highlightedLines.clear();
        }
        // Never shrink: a same-file re-push already shows every row.
        if (end > untrack(() => paintBudget)) paintBudget = end;
        pos = end;
        first = false;
        if (pos < flat.length) {
          await yieldTask();
          if (stale()) return;
        }
      } while (pos < flat.length);
    })().catch(() => {});
    return () => { cancelled = true; workerAbort.abort(); };
  });
  /* SNIPCODE-HOOK end */

  function getHighlighted(hunkStart: number, lineIdx: number, content: string): string {
    /* SNIPCODE-HOOK start: Batch C file/content highlight identity. */
    const key = highlightKey(diff.file, hunkStart, lineIdx, content);
    /* SNIPCODE-HOOK end */
    return highlightedLines.get(key) ?? escapeHtml(content);
  }
</script>

<!-- SNIPCODE-HOOK start: ui/diff D2 no-newline-at-EOF marker -->
{#snippet noNewlinePill(line: DiffLine)}
  {#if line.noNewline}
    <span class="no-newline-pill" title={t('diff.noNewlineAtEof')}>⏎ {t('diff.noNewlineAtEof')}</span>
  {/if}
{/snippet}
<!-- SNIPCODE-HOOK end -->

<!-- SNIPCODE-HOOK start: ui/diff D4 CRLF marker -->
{#snippet crMarker(line: DiffLine)}
  {#if hasMixedCr && line.cr}
    <span class="cr-marker" title={t('diff.mixedLineEndings')}>␍</span>
  {/if}
{/snippet}
<!-- SNIPCODE-HOOK end -->

<div class="diff-wrapper" class:stacked>
  <div class="diff-toolbar">
    {#if heading}<div class="diff-commit-label" title={heading}>{heading}</div>{/if}
    <div class="diff-toolbar-row">
      <span class="diff-file-name" title={diff.file}>
        {#if diff.file.includes('/')}
          <span class="diff-dir">{diff.file.substring(0, diff.file.lastIndexOf('/') + 1)}</span>
        {/if}
        <span class="diff-base">{getFileName(diff.file)}</span>
      </span>
      <!-- SNIPCODE-HOOK start: PR tab inline diff (Task D1) — hidden when the
           parent (PrView) hosts its own shared toggle via hideModeToggle; the
           onclick guards on diffModeProp === undefined so a controlled
           instance without hideModeToggle (not currently used) doesn't fight
           the parent's state. -->
      {#if !hideModeToggle}
        <div class="diff-mode-toggle">
          <button
            class:active={mode === 'inline'}
            onclick={() => { if (diffModeProp === undefined) { internalMode = 'inline'; lineSel = null; } }}
          >{t('details.inline')}</button>
          <button
            class:active={mode === 'side-by-side'}
            onclick={() => { if (diffModeProp === undefined) { internalMode = 'side-by-side'; lineSel = null; } }}
          >{t('details.sideBySide')}</button>
        </div>
      {/if}
      <!-- SNIPCODE-HOOK end -->
    </div>
  </div>

  <div class="diff-panel">
    {#if diffTruncated}
      <div class="diff-truncated-banner">
        <span>{t('details.diffTruncated', { shown: MAX_RENDER_LINES, total: totalDiffLines })}</span>
        <button onclick={() => { showFullDiff = true; }}>{t('details.showFullDiff')}</button>
      </div>
    {/if}
    <!-- SNIPCODE-HOOK start: F4 renamed-from note also shown above hunks (not
         just the empty-hunks state below) — a rename+modify has real hunks so
         the old path was previously invisible. renderHunks is empty for binary
         diffs, so this never doubles up with the empty-hunks message. -->
    {#if renderHunks.length > 0 && diff.oldPath}
      <div class="diff-rename-note">{t('diff.renamedFrom', { oldPath: diff.oldPath, similarity: diff.similarity ?? 100 })}</div>
    {/if}
    <!-- SNIPCODE-HOOK end -->
    {#if diff.isBinary && diff.isImage}
      {#if commitHash && commitHash !== 'UNCOMMITTED'}
        <!-- SNIPCODE-HOOK start: Batch B image request identity -->
        <ImageDiff file={diff.file} staged={false} commitHash={commitHash} repoPath={imageRepoPath} generation={imageGeneration} />
        <!-- SNIPCODE-HOOK end -->
      {:else}
        <!-- UNCOMMITTED: no real commit to diff against; compare index/working
             trees based on which tab (staged vs unstaged) the file is in. -->
        <!-- SNIPCODE-HOOK start: Batch B image request identity -->
        <ImageDiff file={diff.file} {staged} repoPath={imageRepoPath} generation={imageGeneration} />
        <!-- SNIPCODE-HOOK end -->
      {/if}
    {:else if diff.isBinary}
      <div class="diff-empty">{t('details.binaryFile')}</div>
    <!-- SNIPCODE-HOOK start: ui/diff D3 rename/mode-only empty-hunks explanation -->
    {:else if renderHunks.length === 0}
      <!-- A rename-only / mode-only / already-empty-file diff has no content
           hunks — previously this rendered as a blank body with no text at
           all, indistinguishable from "still loading". Say what actually
           happened instead. -->
      <div class="diff-empty diff-empty-meta">
        {#if diff.oldPath}
          <div>{t('diff.renamedFrom', { oldPath: diff.oldPath, similarity: diff.similarity ?? 100 })}</div>
        {/if}
        {#if diff.oldMode && diff.newMode}
          <div>{t('diff.modeChanged', { oldMode: diff.oldMode, newMode: diff.newMode })}</div>
        {/if}
        {#if !diff.oldPath && !diff.oldMode}
          {#if diff.newFile}
            <div>{t('diff.newFile')}</div>
          {:else if diff.deletedFile}
            <div>{t('diff.deletedFile')}</div>
          {:else}
            <div>{t('diff.noTextualChanges')}</div>
          {/if}
        {/if}
      </div>
    <!-- SNIPCODE-HOOK end -->
    {:else if mode === 'inline'}
      <div class="diff-content">
        <!-- SNIPCODE-HOOK: perf — paintHunks (progressive reveal), see the paint pass -->
        {#each paintHunks as hunk, hunkIdx}
          {@const hunkStart = hunk.oldStart}
          <div class="diff-hunk" data-side={staged ? 'staged' : 'unstaged'} data-new-start={hunk.newStart} class:reversible={(canReverse || canStage) && isHunkComplete(hunkIdx)} class:has-selection={lineSel?.hunkIdx === hunkIdx && selectedChangedIndices.length > 0}>
            <div class="diff-hunk-header">
              <div class="hunk-header-inner">
                <span class="diff-hunk-range" title={hunkLabel(hunk, hunkIdx)}>{hunkLabel(hunk, hunkIdx)}</span>
                {#if canReverse && isHunkComplete(hunkIdx)}
                  {#if lineSel?.hunkIdx === hunkIdx && selectedChangedIndices.length > 0}
                    <button class="hunk-action-btn hunk-lines-btn" onclick={reverseSelectedLines}
                            aria-label={t('file.reverseLines')} title={t('file.reverseLines')}>
                      <i class="codicon codicon-discard"></i>
                      <span>{t('file.reverseLines')} ({selectedChangedIndices.length})</span>
                    </button>
                  {/if}
                  <button class="hunk-action-btn hunk-hunk-btn" onclick={() => reverseHunk(hunkIdx)}
                          aria-label={t('file.reverseHunk')} title={t('file.reverseHunk')}>
                    <i class="codicon codicon-discard"></i>
                    <span>{t('file.reverseHunk')}</span>
                  </button>
                {/if}
                <!-- SNIPCODE-HOOK start (B-2c/B-2d): inline per-hunk + per-line Stage/Unstage -->
                {#if canStage && isHunkComplete(hunkIdx)}
                  {#if onStageLines && lineSel?.hunkIdx === hunkIdx && selectedChangedIndices.length > 0}
                    <button class="hunk-action-btn hunk-stage-lines-btn" onclick={() => stageSelectedLines(hunkIdx)}
                            disabled={stageBusy}
                            aria-label={staged ? t('file.unstageLines') : t('file.stageLines')}
                            title={staged ? t('file.unstageLines') : t('file.stageLines')}>
                      <i class="codicon {staged ? 'codicon-chevron-left' : 'codicon-chevron-right'}"></i>
                      <!-- SNIPCODE-HOOK start: ui/diff D10 label the line-stage button (was a bare number) -->
                      <span>{staged ? t('file.unstageLines') : t('file.stageLines')} ({selectedChangedIndices.length})</span>
                      <!-- SNIPCODE-HOOK end -->
                    </button>
                  {/if}
                    <button class="hunk-action-btn hunk-stage-btn" onclick={() => stageHunk(hunkIdx)}
                          disabled={stageBusy}
                          aria-label={staged ? t('file.unstageHunk') : t('file.stageHunk')}
                          title={staged ? t('file.unstageHunk') : t('file.stageHunk')}>
                    <i class="codicon {staged ? 'codicon-chevron-left' : 'codicon-chevron-right'}"></i>
                    <span>{staged ? t('file.unstageHunk') : t('file.stageHunk')}</span>
                  </button>
                {/if}
                <!-- SNIPCODE-HOOK end -->
              </div>
            </div>
            {#each hunk.lines as line, lineIndex}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="diff-line diff-{line.type}" class:line-selected={lineSel?.hunkIdx === hunkIdx && lineSel.indices.has(lineIndex)} oncontextmenu={(e) => handleLineContextMenu(e, hunkIdx, lineIndex)}>
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span
                  class="line-gutter"
                  onmousedown={(e) => startLineSelect(e, hunkIdx, lineIndex)}
                  onmouseenter={(e) => extendLineSelect(e, hunkIdx, lineIndex)}
                >
                  <span class="line-num old">{line.oldLineNumber ?? ''}</span>
                  <span class="line-num new">{line.newLineNumber ?? ''}</span>
                  <span class="line-prefix">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
                </span>
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <span class="line-content" onmousedown={(e) => { if (e.button === 0) lineSel = null; }}>{@html getHighlighted(hunkStart, lineIndex, line.content)}</span>
                {@render crMarker(line)}
                {@render noNewlinePill(line)}
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {:else}
      <!-- SBS keeps right-click → Reverse Hunk parity via the per-hunk wrapper
           handler (so right-clicking any line, context line, or empty placeholder
           row offers Reverse Hunk). Hovering a hunk in either pane highlights it
           in both (no header bar): both panes write the shared hoveredHunkIdx. -->
      <div class="diff-sbs">
        <div class="sbs-pane sbs-left" bind:this={sbsLeftEl} onscroll={handleSbsScroll}>
          <div class="sbs-inner">
            <!-- SNIPCODE-HOOK: perf — paintHunks (progressive reveal), see the paint pass -->
            {#each paintHunks as hunk, hunkIdx}
              {@const hunkStart = hunk.oldStart}
              {#if hunkIdx > 0}<div class="hunk-separator" aria-hidden="true"></div>{/if}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="sbs-hunk"
                data-side={staged ? 'staged' : 'unstaged'}
                data-new-start={hunk.newStart}
                class:hunk-hover={(canReverse || canStage) && isHunkComplete(hunkIdx) && hoveredHunkIdx === hunkIdx}
                onmouseenter={() => { hoveredHunkIdx = hunkIdx; }}
                onmouseleave={() => { if (hoveredHunkIdx === hunkIdx) hoveredHunkIdx = null; }}
                oncontextmenu={(e) => handleLineContextMenu(e, hunkIdx)}
              >
                <!-- SNIPCODE-HOOK start: Batch C shared aligned SBS rows. -->
                {#each sbsRows[hunkIdx] as row}
                  {@const isModify = !!(row.left && row.right && row.left.line.type === 'delete' && row.right.line.type === 'add')}
                  {#if row.left}
                    {@const line = row.left.line}
                    {@const sourceIndex = row.left.index}
                    <div class="diff-line diff-{line.type}" class:diff-modify={isModify}>
                      <span class="line-num">{line.oldLineNumber ?? ''}</span>
                      <span class="line-content">{@html getHighlighted(hunkStart, sourceIndex, line.content)}</span>
                      {@render crMarker(line)}
                      {@render noNewlinePill(line)}
                    </div>
                  {:else}
                    <div class="diff-line diff-empty-line">
                      <span class="line-num"></span>
                      <span class="line-content"></span>
                    </div>
                  {/if}
                {/each}
                <!-- SNIPCODE-HOOK end -->
              </div>
            {/each}
          </div>
        </div>

        <!-- SNIPCODE-HOOK start: IntelliJ-style independent center action and connector gutter -->
        <div class="sbs-center-gutter" bind:this={sbsCenterEl} onwheel={(e) => {
          if (sbsLeftEl) sbsLeftEl.scrollTop += e.deltaY;
        }}>
          <div class="sbs-center-inner">
            {#each paintHunks as hunk, hunkIdx}
              {#if hunkIdx > 0}<div class="hunk-separator" aria-hidden="true"></div>{/if}
              <div class="sbs-center-hunk">
                {#each sbsRows[hunkIdx] as row}
                  {@const lineIndex = row.left?.index ?? row.right?.index ?? -1}
                  {@const blockLines = canStage && onStageLines && isHunkComplete(hunkIdx) ? blockFirstByHunk.get(hunkIdx)?.get(lineIndex) : undefined}
                  {@const isModify = !!(row.left && row.right && row.left.line.type === 'delete' && row.right.line.type === 'add')}
                  {@const isDelete = !!(row.left && row.left.line.type === 'delete' && !row.right)}
                  {@const isAdd = !!(row.right && row.right.line.type === 'add' && !row.left)}
                  <div
                    class="sbs-center-cell"
                    class:cell-modify={isModify}
                    class:cell-delete={isDelete}
                    class:cell-add={isAdd}
                  >
                    {#if blockLines}
                      <button class="sbs-block-stage-btn" class:staged-btn={staged} onclick={() => stageBlock(hunkIdx, blockLines)}
                              disabled={stageBusy}
                              aria-label={staged ? t('file.unstageBlock') : t('file.stageBlock')}
                              title={staged ? t('file.unstageBlock') : t('file.stageBlock')}>
                        <span class="intellij-arrow-glyph" aria-hidden="true">{staged ? '«' : '»'}</span>
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          </div>
        </div>
        <!-- SNIPCODE-HOOK end -->

        <div class="sbs-pane sbs-right" bind:this={sbsRightEl} onscroll={handleSbsScroll}>
          <div class="sbs-inner">
            <!-- SNIPCODE-HOOK: perf — paintHunks (progressive reveal), see the paint pass -->
            {#each paintHunks as hunk, hunkIdx}
              {@const hunkStart = hunk.oldStart}
              {#if hunkIdx > 0}<div class="hunk-separator" aria-hidden="true"></div>{/if}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="sbs-hunk"
                class:hunk-hover={(canReverse || canStage) && isHunkComplete(hunkIdx) && hoveredHunkIdx === hunkIdx}
                onmouseenter={() => { hoveredHunkIdx = hunkIdx; }}
                onmouseleave={() => { if (hoveredHunkIdx === hunkIdx) hoveredHunkIdx = null; }}
                oncontextmenu={(e) => handleLineContextMenu(e, hunkIdx)}
              >
                <!-- SNIPCODE-HOOK start: Batch C shared aligned SBS rows. -->
                {#each sbsRows[hunkIdx] as row}
                  {@const isModify = !!(row.left && row.right && row.left.line.type === 'delete' && row.right.line.type === 'add')}
                  {#if row.right}
                    {@const line = row.right.line}
                    {@const sourceIndex = row.right.index}
                    <div class="diff-line diff-{line.type}" class:diff-modify={isModify}>
                      <span class="line-num">{line.newLineNumber ?? ''}</span>
                      <span class="line-content">{@html getHighlighted(hunkStart, sourceIndex, line.content)}</span>
                      {@render crMarker(line)}
                      {@render noNewlinePill(line)}
                    </div>
                  {:else}
                    <div class="diff-line diff-empty-line">
                      <span class="line-num"></span>
                      <span class="line-content"></span>
                    </div>
                  {/if}
                {/each}
                <!-- SNIPCODE-HOOK end -->
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ── Diff panel ── */
  .diff-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
  }

  .diff-panel {
    flex: 1;
    overflow: auto;
  }

  .diff-toolbar {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border-color);
    flex-shrink: 0;
    z-index: 5;
  }

  .diff-toolbar-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .diff-file-name {
    font-size: var(--vscode-font-size, 13px);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    display: flex;
    align-items: baseline;
    gap: 0;
  }

  .diff-dir {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.9;
    font-weight: normal;
  }

  .diff-base {
    flex-shrink: 0;
    font-weight: 600;
  }

  .diff-mode-toggle {
    display: flex;
    gap: 2px;
    background: rgba(128, 128, 128, 0.15);
    border-radius: 3px;
    padding: 1px;
  }

  .diff-mode-toggle button {
    padding: 2px 8px;
    font-size: 0.75em;
    border-radius: 2px;
    background: transparent;
    color: var(--text-secondary);
  }

  .diff-mode-toggle button.active {
    background: var(--button-bg);
    color: var(--button-fg);
  }

  .diff-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    min-width: 100%;
    width: max-content;
  }

  /* SNIPCODE-HOOK start: ui/diff IntelliJ-style minimalist hunk header divider */
  /* Each hunk is a grouping container so it can carry a header bar and show a
     hover highlight outlining exactly what "Reverse Hunk" will affect. */
  .diff-hunk {
    position: relative;
  }

  .diff-hunk-header {
    display: flex;
    align-items: center;
    padding: 2px 10px;
    min-height: 20px;
    background: var(--vscode-editor-background, #1e1e1e);
    border-top: 1px solid var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.12));
    color: var(--vscode-descriptionForeground, #858585);
    font-size: 11px;
  }

  /* inline-flex (content width, not the hunk's full max-content width) so the
     label + buttons cluster at the left and the buttons sit right after the
     label instead of being pushed to the far-right edge. sticky left:0 keeps
     them pinned to the viewport's left so they stay reachable when the diff is
     scrolled horizontally. */
  .hunk-header-inner {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    left: 0;
  }

  /* No flex-grow: the label takes only its own width so it can't push the
     buttons right. It may still shrink/ellipsize if the panel is very narrow. */
  .diff-hunk-range {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--vscode-descriptionForeground, #858585);
    opacity: 0.7;
  }

  .hunk-action-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    white-space: nowrap;
    min-height: 18px;
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid transparent;
    cursor: pointer;
    font-size: 11px;
    font-family: var(--vscode-font-family, sans-serif);
    transition: opacity 0.15s, background-color 0.1s;
  }

  /* The Reverse HUNK button is a hover/focus affordance; the Reverse LINES button
     is explicit (only renders when a selection exists), so it's always visible. */
  .hunk-hunk-btn {
    opacity: 0;
    color: var(--vscode-errorForeground, #f44336);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f44336) 8%, transparent);
    border-color: color-mix(in srgb, var(--vscode-errorForeground, #f44336) 18%, transparent);
  }

  .hunk-lines-btn {
    opacity: 1;
    color: var(--vscode-errorForeground, #f44336);
    background: color-mix(in srgb, var(--vscode-errorForeground, #f44336) 8%, transparent);
    border-color: color-mix(in srgb, var(--vscode-errorForeground, #f44336) 18%, transparent);
  }

  .hunk-hunk-btn:hover,
  .hunk-lines-btn:hover {
    background: color-mix(in srgb, var(--vscode-errorForeground, #f44336) 16%, transparent);
  }

  .hunk-stage-lines-btn {
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff);
    background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff) 8%, transparent);
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff) 18%, transparent);
    opacity: 0.95;
  }
  .hunk-stage-lines-btn:hover {
    background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff) 16%, transparent);
  }

  /* Stage/unstage buttons (green accent) */
  .hunk-stage-btn {
    color: var(--vscode-gitDecoration-addedResourceForeground, #48bf91);
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 8%, transparent);
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 18%, transparent);
    opacity: 0;
  }
  .diff-hunk.reversible:hover .hunk-stage-btn,
  .hunk-stage-btn:focus,
  .hunk-stage-btn:hover {
    opacity: 0.95;
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 16%, transparent);
  }

  /* ── IntelliJ-style Center Action & Connection Gutter ── */
  .sbs-center-gutter {
    width: 28px;
    min-width: 28px;
    max-width: 28px;
    flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 1.5;
    background: var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    border-left: 1px solid var(--vscode-editorOverviewRuler-border, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.18)));
    border-right: 1px solid var(--vscode-editorOverviewRuler-border, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.18)));
    user-select: none;
    z-index: 2;
    overflow: hidden;
  }

  .sbs-center-inner {
    display: flex;
    flex-direction: column;
    min-height: 100%;
  }

  .sbs-center-hunk {
    position: relative;
  }

  .sbs-center-cell {
    min-height: max(20px, 1.5em);
    line-height: 1.5;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    box-sizing: border-box;
  }

  /* 行高 strut：確保即使單元格內無文字，高度也與代碼行的 line box 100% 絕對等高 */
  .sbs-center-cell::before {
    content: '\00a0';
    visibility: hidden;
    width: 0;
    display: inline-block;
    line-height: inherit;
    font-size: inherit;
    font-family: inherit;
  }

  /* 中央連接色帶（IntelliJ 區塊連接對應感） */
  .sbs-center-cell.cell-modify {
    background: linear-gradient(to right, color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 16%, transparent), color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 16%, transparent));
  }

  .sbs-center-cell.cell-delete {
    background: linear-gradient(to right, color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 16%, transparent) 55%, transparent 100%);
  }

  .sbs-center-cell.cell-add {
    background: linear-gradient(to right, transparent 0%, color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 16%, transparent) 45%);
  }

  /* 變更區塊首行上方細邊界（使用 inset box-shadow 避免破壞行高） */
  :not(.cell-modify):not(.cell-delete):not(.cell-add) + .cell-modify,
  :not(.cell-modify):not(.cell-delete):not(.cell-add) + .cell-add {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 22%, transparent);
  }
  :not(.cell-modify):not(.cell-delete):not(.cell-add) + .cell-delete {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 22%, transparent);
  }

  /* Per-change-block gutter arrow in SBS mode (IntelliJ-style) */
  .sbs-block-stage-btn {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 18px;
    padding: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 40%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 18%, var(--vscode-editor-background, #1e1e1e));
    color: var(--vscode-gitDecoration-addedResourceForeground, #48bf91);
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    transition: opacity 0.12s ease, background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, transform 0.08s ease;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
    z-index: 1;
  }

  /* 擴大透明點擊熱區至 28px 中軸槽全寬與單元格高，在大字體下無須像素級對準小圖示即可觸發 */
  .sbs-block-stage-btn::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 28px;
    height: 100%;
    min-height: 28px;
  }

  /* 取消暫存按鈕樣式（解耦多語系文案，支援 staged-btn class） */
  .sbs-block-stage-btn.staged-btn,
  .sbs-block-stage-btn[aria-label*="Unstage"] {
    border-color: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff) 18%, var(--vscode-editor-background, #1e1e1e));
    color: var(--vscode-gitDecoration-modifiedResourceForeground, #3794ff);
  }

  .intellij-arrow-glyph {
    display: inline-block;
    font-family: var(--vscode-editor-font-family, 'JetBrains Mono', monospace);
    font-weight: 700;
    font-size: 13px;
    line-height: 1;
    transform: translateY(-0.5px);
  }

  .sbs-center-cell:hover .sbs-block-stage-btn,
  .sbs-block-stage-btn:hover,
  .sbs-block-stage-btn:focus {
    opacity: 1;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
    border-color: var(--vscode-focusBorder, #4a9eff);
    box-shadow: 0 0 6px var(--vscode-focusBorder, rgba(74, 158, 255, 0.4));
  }
  .sbs-block-stage-btn:active {
    transform: translate(-50%, -50%) scale(0.92);
  }
  /* Busy gate (stageBusy prop): dim + block clicks even while hovered/focused. */
  .hunk-stage-btn:disabled,
  .hunk-stage-lines-btn:disabled,
  .sbs-block-stage-btn:disabled {
    opacity: 0.35 !important;
    cursor: not-allowed;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start (B-2d): intraline word-diff highlight. Sits on top of
     the whole-line add/delete background; uses a stronger tint so the changed
     characters stand out (IntelliJ-style). Inherits the Shiki syntax color. */
  :global(.word-diff-del) {
    background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 38%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 28%, transparent);
    border-radius: 2px;
  }
  :global(.word-diff-add) {
    background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 38%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 28%, transparent);
    border-radius: 2px;
  }
  /* SNIPCODE-HOOK end */

  .diff-hunk.reversible:hover .hunk-hunk-btn,
  .diff-hunk.has-selection .hunk-hunk-btn,
  .hunk-action-btn:focus {
    opacity: 1;
  }

  .hunk-action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--bg-hover));
  }

  .hunk-action-btn i {
    font-size: 1em;
  }

  /* Outline the whole hunk on hover so the reverse extent is obvious. Inline only
     when reversible (compare/uncommitted diffs get no misleading hint); SBS
     outlines the hovered hunk in both panes (.sbs-hunk.hunk-hover below). */
  .diff-hunk.reversible:hover,
  .sbs-hunk.hunk-hover {
    outline: 1px solid var(--vscode-focusBorder, rgba(120, 120, 255, 0.4));
    outline-offset: -1px;
  }

  /* SBS mode still uses a plain dashed separator between hunks (no header bar). */
  .hunk-separator {
    height: 0;
    border-top: 1px dashed var(--border-color);
    margin: 6px 0;
    opacity: 0.6;
    width: 100%;
  }

  .diff-line {
    display: flex;
    min-height: max(20px, 1.5em);
    /* SNIPCODE-HOOK start: ui/diff D P2 line-height scales with editor font size */
    line-height: 1.5;
    box-sizing: border-box;
    /* SNIPCODE-HOOK end */
  }

  .diff-add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(72, 191, 145, 0.12)); }
  .diff-delete { background: var(--vscode-diffEditor-removedLineBackground, rgba(255, 60, 60, 0.12)); }
  .diff-empty-line {
    background: repeating-linear-gradient(
      -45deg,
      rgba(128, 128, 128, 0.025),
      rgba(128, 128, 128, 0.025) 6px,
      transparent 6px,
      transparent 12px
    );
  }

  /* Modify row subtle boundary（使用 inset box-shadow 避免影響行高） */
  .diff-modify {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 18%, transparent),
                inset 0 -1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 18%, transparent);
  }
  .diff-modify + .diff-modify {
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 18%, transparent);
  }

  /* Change block top/bottom subtle boundary */
  :not(.diff-add) + .diff-add:not(.diff-modify) {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 15%, transparent);
  }
  :not(.diff-delete) + .diff-delete:not(.diff-modify) {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 15%, transparent);
  }
  .diff-delete + .diff-add {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #48bf91) 20%, transparent);
  }
  .diff-add + .diff-delete {
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground, #f44336) 20%, transparent);
  }

  /* Inline gutter (line numbers + prefix) */
  .line-gutter {
    display: flex;
    flex-shrink: 0;
    user-select: none;
    cursor: pointer;
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    border-right: 1px solid var(--vscode-editorOverviewRuler-border, rgba(128, 128, 128, 0.12));
    box-sizing: border-box;
  }

  /* Gutter left accent stripe for change blocks (IntelliJ-style) */
  .diff-add .line-gutter {
    background:
      linear-gradient(var(--vscode-diffEditor-insertedLineBackground, rgba(72, 191, 145, 0.10)), var(--vscode-diffEditor-insertedLineBackground, rgba(72, 191, 145, 0.10))),
      var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    border-left: 2px solid var(--vscode-gitDecoration-addedResourceForeground, #48bf91);
  }
  .diff-delete .line-gutter {
    background:
      linear-gradient(var(--vscode-diffEditor-removedLineBackground, rgba(255, 60, 60, 0.10)), var(--vscode-diffEditor-removedLineBackground, rgba(255, 60, 60, 0.10))),
      var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    border-left: 2px solid var(--vscode-gitDecoration-deletedResourceForeground, #f44336);
  }
  .diff-context .line-gutter {
    border-left: 2px solid transparent;
  }

  /* Selected lines */
  .diff-line.line-selected {
    background: var(--vscode-editor-selectionBackground, rgba(120, 150, 255, 0.25));
  }
  .line-selected .line-gutter {
    background:
      linear-gradient(var(--vscode-editor-selectionBackground, rgba(120, 150, 255, 0.25)), var(--vscode-editor-selectionBackground, rgba(120, 150, 255, 0.25))),
      var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    border-left: 2px solid var(--vscode-focusBorder, #4a9eff);
  }

  .line-num {
    width: 40px;
    flex-shrink: 0;
    text-align: right;
    padding-right: 8px;
    color: var(--vscode-editorLineNumber-foreground, rgba(128, 128, 128, 0.45));
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
    user-select: none;
    box-sizing: border-box;
  }

  .diff-add .line-num.new,
  .diff-delete .line-num.old {
    color: var(--vscode-editorLineNumber-activeForeground, var(--vscode-foreground, #cccccc));
    opacity: 0.9;
    font-weight: 500;
  }

  /* Side-by-side pane line-num */
  .sbs-pane .line-num {
    width: 44px;
    padding-right: 10px;
    border-right: 1px solid var(--vscode-editorOverviewRuler-border, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.18)));
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    color: var(--vscode-editorLineNumber-foreground, rgba(128, 128, 128, 0.45));
  }
  .sbs-pane .diff-add .line-num {
    background:
      linear-gradient(var(--vscode-diffEditor-insertedLineBackground, rgba(72, 191, 145, 0.15)), var(--vscode-diffEditor-insertedLineBackground, rgba(72, 191, 145, 0.15))),
      var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    box-shadow: inset 3px 0 0 var(--vscode-gitDecoration-addedResourceForeground, #48bf91);
    color: var(--vscode-editorLineNumber-activeForeground, #7cd98a);
    font-weight: 600;
  }
  .sbs-pane .diff-delete .line-num {
    background:
      linear-gradient(var(--vscode-diffEditor-removedLineBackground, rgba(255, 60, 60, 0.15)), var(--vscode-diffEditor-removedLineBackground, rgba(255, 60, 60, 0.15))),
      var(--vscode-editorGutter-background, var(--vscode-editor-background, #1e1e1e));
    box-shadow: inset 3px 0 0 var(--vscode-gitDecoration-deletedResourceForeground, #f44336);
    color: var(--vscode-editorLineNumber-activeForeground, #f48771);
    font-weight: 600;
  }

  .line-prefix {
    width: 14px;
    flex-shrink: 0;
    text-align: center;
    user-select: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    font-weight: 700;
  }

  .diff-add .line-prefix {
    color: var(--vscode-gitDecoration-addedResourceForeground, #48bf91);
  }
  .diff-delete .line-prefix {
    color: var(--vscode-gitDecoration-deletedResourceForeground, #f44336);
  }
  .diff-context .line-prefix {
    opacity: 0;
  }
  /* SNIPCODE-HOOK end */

  .line-content {
    white-space: pre;
    /* SNIPCODE-HOOK start: ui/diff D8 tab-size */
    /* Browser default is 8; the editor default is 4 — a tab-indented line
       looks twice as wide here as in the file it came from. */
    tab-size: 4;
    -moz-tab-size: 4;
    /* SNIPCODE-HOOK end */
    padding-left: 4px;
    padding-right: 24px;
  }

  /* SNIPCODE-HOOK start: ui/diff D2 no-newline-at-EOF marker */
  .no-newline-pill {
    display: inline-flex;
    align-items: center;
    margin-left: 8px;
    padding: 0 5px;
    font-size: 0.8em;
    font-family: var(--vscode-font-family, sans-serif);
    white-space: nowrap;
    color: var(--vscode-editorWarning-foreground, #cca700);
    border: 1px solid currentColor;
    border-radius: 3px;
    opacity: 0.85;
    user-select: none;
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: ui/diff D4 CRLF marker */
  .cr-marker {
    margin-left: 2px;
    color: var(--vscode-editorWarning-foreground, #cca700);
    opacity: 0.75;
    user-select: none;
    font-weight: bold;
  }
  /* SNIPCODE-HOOK end */

  .diff-empty {
    padding: 20px;
    text-align: center;
    color: var(--text-secondary);
  }

  /* SNIPCODE-HOOK start: ui/diff D3 rename/mode-only empty-hunks explanation */
  .diff-empty-meta div {
    margin: 2px 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
  /* SNIPCODE-HOOK end */

  .diff-truncated-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    font-size: 12px;
    color: var(--text-secondary);
    background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
  }

  .diff-truncated-banner button {
    flex-shrink: 0;
    padding: 2px 10px;
    cursor: pointer;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border: none;
    border-radius: 2px;
    font-size: 12px;
  }

  .diff-truncated-banner button:hover {
    background: var(--vscode-button-hoverBackground, #1177bb);
  }

  /* SNIPCODE-HOOK start: F4 renamed-from note also shown above hunks */
  .diff-rename-note {
    padding: 4px 12px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    color: var(--text-secondary);
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK (B-2c): hunk-level positioning context (block arrows now anchor
     on their own line via .has-block-arrow). */
  .sbs-hunk { position: relative; }

  /* Side-by-side */
  .diff-sbs {
    display: flex;
    height: 100%;
    width: 100%;
  }

  .sbs-pane {
    flex: 1;
    min-width: 0;
    overflow: auto;
    background: var(--bg-primary);
  }

  .sbs-inner {
    display: flex;
    flex-direction: column;
    min-width: 100%;
    width: max-content;
    min-height: 100%;
  }

  .sbs-left {
    border-right: none;
  }

  .sbs-pane .diff-line {
    width: 100%;
    min-height: max(20px, 1.5em);
  }

  /* ── Stacked mode (multiple FileDiffViews in a scrolling column) ── */
  /* The outer .sections-pane owns the scroll; each FileDiffView must grow to  */
  /* its full content height rather than filling/clipping inside a flex child. */
  .diff-wrapper.stacked {
    flex: none;
    overflow: visible;
  }

  .diff-wrapper.stacked .diff-panel {
    overflow: visible;
    max-height: none;
  }

  /* In SBS mode, .diff-sbs uses height:100% which resolves to 0 when the     */
  /* parent has no fixed height. Switch to auto so both panes size to content. */
  .diff-wrapper.stacked .diff-sbs,
  .diff-wrapper.stacked .sbs-center-gutter {
    height: auto;
  }

  /* The toolbar (commit label + file name) sticks to the top while scrolling  */
  /* through this section's diff. Constrained to the section's own wrapper, so */
  /* the next section's toolbar takes over instead of piling up at the top.    */
  .diff-wrapper.stacked .diff-toolbar {
    position: sticky;
    top: 0;
  }

  .diff-commit-label {
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--text-secondary);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
