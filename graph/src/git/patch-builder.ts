// Builds minimal, reverse-applicable patches from a single-file unified diff so
// we can undo part of a commit's change (one hunk, or a subset of changed lines)
// against the working tree via `git apply --reverse`.
//
// The line indexing here intentionally mirrors `parseDiff` in git-parser.ts:
// `lineIndices` refer to positions in a hunk's `DiffLine[]` exactly as the
// webview sees them, so the frontend can pass back the indices it rendered.

interface PatchEntry {
  kind: 'context' | 'add' | 'delete';
  /** Raw diff line including its leading ' ', '+' or '-'. */
  text: string;
  /** Trailing "\ No newline at end of file" markers attached to this line. */
  markers: string[];
}

interface PatchHunk {
  /** The original `@@ -a,b +c,d @@ ...` header line. */
  headerLine: string;
  entries: PatchEntry[];
}

interface ParsedFileDiff {
  /** Everything before the first hunk: `diff --git`, mode/index lines, ---/+++. */
  header: string[];
  hunks: PatchHunk[];
}

/** Parse a single-file `git diff` (or `git show`) body into header + hunks,
 *  classifying body lines the same way `parseDiff` does so indices line up.
 *  "\ No newline at end of file" markers are attached to the line they follow
 *  (never counted as their own index), matching parseDiff which skips them. */
function parseFileDiff(rawFileDiff: string): ParsedFileDiff {
  const lines = rawFileDiff.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) {
    return { header: lines, hunks: [] };
  }

  const header = lines.slice(0, firstHunk);
  const hunks: PatchHunk[] = [];
  let current: PatchHunk | null = null;

  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('@@')) {
      current = { headerLine: line, entries: [] };
      hunks.push(current);
      continue;
    }
    if (!current) { continue; }

    if (line.startsWith('\\')) {
      // "\ No newline at end of file" — belongs to the preceding content line.
      const last = current.entries[current.entries.length - 1];
      if (last) { last.markers.push(line); }
      continue;
    }

    if (line.startsWith('+')) {
      current.entries.push({ kind: 'add', text: line, markers: [] });
    } else if (line.startsWith('-')) {
      current.entries.push({ kind: 'delete', text: line, markers: [] });
    } else if (line.startsWith(' ')) {
      current.entries.push({ kind: 'context', text: line, markers: [] });
    } else if (line === '' && i < lines.length - 1) {
      // A blank context line whose trailing space was stripped (git's normal
      // output keeps the leading ' '). The final '' is split('\n')'s trailing
      // artifact, not real content — skip it (`i < lines.length - 1`).
      current.entries.push({ kind: 'context', text: ' ', markers: [] });
    }
  }

  return { header, hunks };
}

/** Rewrite a hunk header with recomputed line counts, preserving the original
 *  start positions and the trailing section heading. */
function rewriteHunkHeader(headerLine: string, oldCount: number, newCount: number): string {
  const m = headerLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!m) { return headerLine; }
  const [, oldStart, newStart, rest] = m;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${rest}`;
}

/** A reconstructed body line, tagged with which file side(s) it appears on so
 *  we can find each side's last line when re-attaching no-newline markers. */
interface BodyLine {
  text: string;
  onOld: boolean;
  onNew: boolean;
}

/** The "\ No newline at end of file" marker text git emits. We always re-emit
 *  the canonical form rather than echoing the (whitespace-identical) original. */
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/* SNIPCODE-HOOK start: mirror whole-file paths even when Git C-quotes them */
function mirrorHeaderPath(
  header: string[],
  sourceMarker: '---' | '+++',
  sourcePrefix: 'a/' | 'b/',
  targetMarker: '---' | '+++',
  targetPrefix: 'a/' | 'b/',
): string | undefined {
  const unquoted = `${sourceMarker} ${sourcePrefix}`;
  const quoted = `${sourceMarker} "${sourcePrefix}`;
  const source = header.find((line) => line.startsWith(unquoted) || line.startsWith(quoted));
  if (!source) return undefined;
  const prefix = source.startsWith(quoted) ? quoted : unquoted;
  const target = source.startsWith(quoted) ? `${targetMarker} "${targetPrefix}` : `${targetMarker} ${targetPrefix}`;
  return target + source.slice(prefix.length);
}
/* SNIPCODE-HOOK end */

/**
 * A whole-file add/delete diff carries a `new file mode`/`deleted file mode`
 * line and a `/dev/null` side. That header reverses cleanly only while one side
 * stays empty (reverse a pure add → delete the file; reverse a pure delete →
 * recreate it). A PARTIAL reverse leaves content on the formerly-empty side, so
 * the operation is really an in-place modification — and git then rejects the
 * `/dev/null` header ("new file ... depends on old contents"). Rewrite those
 * header lines into a normal modification header whenever a side is no longer
 * empty:
 *  - old side now non-empty but header says newly added (`--- /dev/null`) →
 *    restore the real old path (mirrored from the `+++ b/...` side) and fold the
 *    `new file mode` into the index line.
 *  - new side now non-empty but header says deleted (`+++ /dev/null`) →
 *    restore the real new path (mirrored from the `--- a/...` side) and fold the
 *    `deleted file mode` into the index line.
 * A whole-file reverse keeps its empty side, so this is a no-op for it (and for
 * ordinary modification diffs, which have no `/dev/null` side at all).
 */
function normalizeWholeFileHeader(header: string[], oldCount: number, newCount: number): string[] {
  const rewriteOld = oldCount > 0 && header.includes('--- /dev/null');
  const rewriteNew = newCount > 0 && header.includes('+++ /dev/null');
  if (!rewriteOld && !rewriteNew) { return header; }

  let mode = '';
  const out: string[] = [];
  for (const line of header) {
    const modeMatch = line.match(/^(?:new|deleted) file mode (\d+)$/);
    if (modeMatch) { mode = modeMatch[1]; continue; }
    if (rewriteOld && line === '--- /dev/null') {
      /* SNIPCODE-HOOK start: support Git C-quoted whole-file paths */
      out.push(mirrorHeaderPath(header, '+++', 'b/', '---', 'a/') ?? line);
      /* SNIPCODE-HOOK end */
    } else if (rewriteNew && line === '+++ /dev/null') {
      /* SNIPCODE-HOOK start: support Git C-quoted whole-file paths */
      out.push(mirrorHeaderPath(header, '---', 'a/', '+++', 'b/') ?? line);
      /* SNIPCODE-HOOK end */
    } else {
      out.push(line);
    }
  }
  // The mode lived on the now-dropped `new/deleted file mode` line; a normal
  // diff carries it on the index line, so re-attach it there if it's missing.
  if (mode) {
    const i = out.findIndex((l) => l.startsWith('index '));
    if (i !== -1 && !/ \d+$/.test(out[i])) { out[i] = out[i] + ' ' + mode; }
  }
  return out;
}

/**
 * Build a patch containing a single hunk from `rawFileDiff`, optionally narrowed
 * to a subset of that hunk's changed lines. The result is meant to be applied
 * with `git apply --reverse` to undo those changes in the working tree.
 *
 * Selection semantics (`lineIndices` index into the hunk's `DiffLine[]`):
 *  - omitted → reverse every changed (+/-) line in the hunk;
 *  - provided → reverse only the listed +/- lines. Unselected additions become
 *    context (they stay in the file); unselected deletions are dropped entirely
 *    (they aren't in the file and we aren't restoring them).
 *
 * No-newline handling: a "\ No newline at end of file" marker is a property of a
 * SIDE's file end, not of any fixed source line. Echoing each line's original
 * marker inline corrupts the output whenever a partial selection reshuffles
 * which line is last on a side. So we derive, from the original hunk, whether
 * each side ends unterminated, then re-attach a single marker after whichever
 * reconstructed line is actually last on that side (and only one marker when the
 * old- and new-side last line is the same shared context line).
 *
 * @throws if the hunk index is out of range or nothing reversible is selected.
 */
export function buildReversePatch(rawFileDiff: string, hunkIndex: number, lineIndices?: number[]): string {
  const { header, hunks } = parseFileDiff(rawFileDiff);
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found in diff`);
  }

  const selected = lineIndices ? new Set(lineIndices) : null;
  const isReversing = (idx: number, kind: PatchEntry['kind']): boolean =>
    kind !== 'context' && (selected ? selected.has(idx) : true);

  // Determine, from the ORIGINAL hunk (before filtering), whether each side's
  // file ends without a trailing newline. A context marker means BOTH sides end
  // unterminated at that shared line; a delete marker → old side; an add → new.
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const entry of hunk.entries) {
    if (entry.markers.length === 0) { continue; }
    if (entry.kind === 'context') { oldNoNewline = true; newNoNewline = true; }
    else if (entry.kind === 'delete') { oldNoNewline = true; }
    else { newNoNewline = true; }
  }

  // Whether the original hunk's final old-side entry survives onto the old side
  // of our reconstruction (and so the old side still reaches old-EOF). Context
  // is always retained; a trailing delete is retained only if selected. Adds are
  // never on the old side, so they don't bear on old-EOF.
  let oldReachesEof = false;
  for (let i = hunk.entries.length - 1; i >= 0; i--) {
    const entry = hunk.entries[i];
    if (entry.kind === 'context') { oldReachesEof = true; break; }
    if (entry.kind === 'delete') { oldReachesEof = isReversing(i, 'delete'); break; }
    // 'add' — not on the old side; keep scanning past it.
  }

  const bodyLines: BodyLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let reversedAny = false;

  for (let i = 0; i < hunk.entries.length; i++) {
    const entry = hunk.entries[i];

    if (entry.kind === 'context') {
      bodyLines.push({ text: entry.text, onOld: true, onNew: true });
      oldCount++;
      newCount++;
    } else if (entry.kind === 'add') {
      if (isReversing(i, 'add')) {
        // Keep as an addition (new side only); `--reverse` turns it into a removal.
        bodyLines.push({ text: entry.text, onOld: false, onNew: true });
        newCount++;
        reversedAny = true;
      } else {
        // Demote to context: the line stays in the working tree (both sides).
        bodyLines.push({ text: ' ' + entry.text.slice(1), onOld: true, onNew: true });
        oldCount++;
        newCount++;
      }
    } else {
      if (isReversing(i, 'delete')) {
        // Keep as a removal (old side only); `--reverse` restores it.
        bodyLines.push({ text: entry.text, onOld: true, onNew: false });
        oldCount++;
        reversedAny = true;
      }
      // Unselected deletion: drop it — it's absent from the file either way.
    }
  }

  if (!reversedAny) {
    throw new Error('No changed lines selected to reverse');
  }

  // Re-attach no-newline markers from the RECONSTRUCTED body. A marker is the
  // terminator of a side's file end, so we find each side's actual last body line
  // and decide whether that side ends unterminated.
  let lastOld = -1;
  let lastNew = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].onOld) { lastOld = i; }
    if (bodyLines[i].onNew) { lastNew = i; }
  }

  // New side: always reaches new-EOF (adds/context are never dropped — adds may
  // demote to context but remain). It ends unterminated iff the new file did.
  const newEndsNoNewline = newNoNewline && lastNew !== -1;

  // Old side (the post-reverse file the reverse-apply produces). It ends
  // unterminated when either:
  //  - the old side's last line is the same shared trailing line as the new side
  //    and the new file ended unterminated (the unchanged tail carries over), or
  //  - the old side's last line is its own trailing line (a kept delete or a
  //    demoted line followed only by reversed adds) and the file it represents
  //    ended unterminated. A trailing delete reflects old-EOF (`oldNoNewline`);
  //    a demoted tail followed by reversed adds reflects the new file's EOF
  //    (`newNoNewline`) since reversing those trailing adds leaves it last.
  let oldEndsNoNewline = false;
  if (lastOld !== -1) {
    if (lastOld === lastNew) {
      oldEndsNoNewline = newNoNewline || (oldNoNewline && oldReachesEof);
    } else if (lastOld > lastNew) {
      // Kept deletions trail the last shared/new line → old side reaches old-EOF.
      oldEndsNoNewline = oldNoNewline && oldReachesEof;
    } else {
      // Reversed adds trail the old side's last line. Reversing them away leaves
      // that line last in the result, so the result ends unterminated iff the
      // new file did.
      oldEndsNoNewline = newNoNewline;
    }
  }

  // Emit the body, attaching markers after the appropriate lines. When the old-
  // and new-side terminators are the SAME shared line we emit exactly one marker.
  // When they differ, each marker sits immediately after its own line; if the
  // old-side terminator is a shared line followed by new-only (reversed-add)
  // lines, a bare marker there would wrongly terminate the new side too, so we
  // split that shared line into a delete/add pair (`-line`⟵marker, `+line`) which
  // terminates only the old side while the new side continues.
  const body: string[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const ln = bodyLines[i];
    const isOldTerm = oldEndsNoNewline && i === lastOld;
    const isNewTerm = newEndsNoNewline && i === lastNew;

    if (isOldTerm && isNewTerm) {
      // Same shared trailing line terminates both sides → one marker.
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isOldTerm && i < lastNew && ln.onOld && ln.onNew) {
      // Shared line that is the old-side terminator but new-only lines follow:
      // split so the marker terminates the old side without truncating the new.
      // The split contributes one old + one new line — the same as the context
      // line it replaces — so the running counts are unchanged.
      const content = ln.text.slice(1);
      body.push('-' + content, NO_NEWLINE_MARKER, '+' + content);
    } else if (isOldTerm) {
      // Old-only terminator (a kept delete): marker after it is unambiguous.
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isNewTerm) {
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else {
      body.push(ln.text);
    }
  }

  const headerLine = rewriteHunkHeader(hunk.headerLine, oldCount, newCount);
  const finalHeader = normalizeWholeFileHeader(header, oldCount, newCount);
  return [...finalHeader, headerLine, ...body].join('\n') + '\n';
}

/**
 * Build a patch that stages ONLY the selected hunks of a HEAD→working-tree
 * file diff, for `git apply --cached`. Each hunk of a HEAD→working diff is an
 * independent region, so staging a subset just means emitting those hunks
 * verbatim (original header line + entries + no-newline markers) and dropping
 * the rest — no line-count rewriting is needed because whole hunks keep their
 * own already-correct `@@` counts.
 *
 * Hunk-level only (v1). Per-line selection (lineIndices) is intentionally left
 * to v2. `selectedHunkIndices` index into the parsed hunk list exactly as
 * `parseFileDiff`/`parseDiff` produce it; they are de-duplicated and applied in
 * ascending file order (git apply wants hunks in file order).
 *
 * `normalizeWholeFileHeader` runs for parity with the reverse builder and to
 * cover the whole-file `/dev/null` cases (new/deleted file selected in full);
 * for ordinary modification diffs and verbatim hunk selection it is a no-op.
 *
 * @throws if nothing is selected or a selected index is out of range.
 */
/* SNIPCODE-HOOK start: byte-preserving forward hunk and line patches */
function decodePatchBytes(rawFileDiff: string | Buffer): string {
  return Buffer.isBuffer(rawFileDiff) ? rawFileDiff.toString('latin1') : rawFileDiff;
}

function encodePatchBytes(rawFileDiff: string | Buffer, patch: string): string | Buffer {
  return Buffer.isBuffer(rawFileDiff) ? Buffer.from(patch, 'latin1') : patch;
}

export function buildForwardPatch(rawFileDiff: Buffer, selectedHunkIndices: number[]): Buffer;
export function buildForwardPatch(rawFileDiff: string, selectedHunkIndices: number[]): string;
export function buildForwardPatch(rawFileDiff: string | Buffer, selectedHunkIndices: number[]): string | Buffer {
  if (selectedHunkIndices.length === 0) {
    throw new Error('No hunks selected to stage');
  }
  const { header, hunks } = parseFileDiff(decodePatchBytes(rawFileDiff));
  const ordered = [...new Set(selectedHunkIndices)].sort((a, b) => a - b);

  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (const idx of ordered) {
    const hunk = hunks[idx];
    if (!hunk) {
      throw new Error(`Hunk ${idx} not found in diff`);
    }
    body.push(hunk.headerLine);
    for (const entry of hunk.entries) {
      body.push(entry.text, ...entry.markers);
      if (entry.kind === 'context') { oldCount++; newCount++; }
      else if (entry.kind === 'delete') { oldCount++; }
      else { newCount++; }
    }
  }

  const finalHeader = normalizeWholeFileHeader(header, oldCount, newCount);
  const patch = [...finalHeader, ...body].join('\n') + '\n';
  return encodePatchBytes(rawFileDiff, patch);
}

/**
 * Build a single-hunk patch that stages ONLY the selected changed lines of one
 * hunk from an index→working diff, for `git apply --cached`.
 *
 * Selection semantics (forward / stage direction; baseline = the current index):
 *  - omitted lineIndices → stage every changed (+/-) line in the hunk;
 *  - provided → stage only the listed +/- lines:
 *     - selected `+` → kept as `+` (added to the index);
 *     - UNSELECTED `+` → OMITTED entirely (not in the index, not being staged).
 *       It does NOT demote to context — unlike reverse — because a context line
 *       must exist in the baseline/index and an unstaged addition does not;
 *     - selected `-` → kept as `-` (removed from the index);
 *     - UNSELECTED `-` → demoted to context ` ` (it stays in the index).
 *
 * This is the mirror image of {@link buildReversePatch} with the old/new sides
 * swapped: for `'stage'`, the OLD side (the index baseline) always reaches EOF
 * because deletions are never dropped, while the NEW side (the staged result)
 * can lose a trailing line when an unselected trailing addition is omitted.
 * `'unstage'` inverts which side can be shortened instead: an unselected
 * deletion is OMITTED (not demoted), so the OLD side can now end short of the
 * hunk's true old-EOF entry — the no-newline re-anchoring tracks reachability
 * for BOTH sides (`oldReachesEof`/`newReachesEof`) rather than assuming one
 * side is always intact.
 *
 * `direction` picks which side of the RAW diff is the "current, don't-touch"
 * baseline for an UNSELECTED changed line, because the same function is reused
 * by both stage and unstage call sites on structurally different raw diffs:
 *  - `'stage'` (default): raw = index→working; the baseline is the DELETE side
 *    (current index content), matching the semantics above.
 *  - `'unstage'`: raw = HEAD→index (the staged diff); the baseline is the ADD
 *    side (current index content) instead, so the roles invert — an
 *    unselected `-` (HEAD content, not the baseline) is OMITTED entirely, and
 *    an unselected `+` (index content, the baseline) is demoted to context —
 *    otherwise the reconstructed "new" side (which `git apply --cached
 *    --reverse` must match against the CURRENT index) would use stale
 *    HEAD-side text for the untouched portion instead of what is actually
 *    staged right now.
 *
 * Both directions also reorder each maximal run of consecutive +/- entries by
 * pairing the k-th delete with the k-th add (see `orderedEntries` below):
 * git diff emits a run as ALL deletes then ALL adds, so selecting only one
 * pair out of several in the same run — e.g. keep A→A2, leave B→B2 alone —
 * would otherwise place the demoted/omitted line(s) out of position relative
 * to the kept line(s) and silently swap two lines' order in the result.
 *
 * @throws if the hunk index is out of range or nothing stageable is selected.
 */
export function buildForwardPatchLines(
  rawFileDiff: Buffer,
  hunkIndex: number,
  lineIndices?: number[],
  direction?: 'stage' | 'unstage',
): Buffer;
export function buildForwardPatchLines(
  rawFileDiff: string,
  hunkIndex: number,
  lineIndices?: number[],
  direction?: 'stage' | 'unstage',
): string;
export function buildForwardPatchLines(
  rawFileDiff: string | Buffer,
  hunkIndex: number,
  lineIndices?: number[],
  direction: 'stage' | 'unstage' = 'stage',
): string | Buffer {
  const { header, hunks } = parseFileDiff(decodePatchBytes(rawFileDiff));
  const hunk = hunks[hunkIndex];
  if (!hunk) {
    throw new Error(`Hunk ${hunkIndex} not found in diff`);
  }

  const selected = lineIndices ? new Set(lineIndices) : null;
  const isStaging = (idx: number, kind: PatchEntry['kind']): boolean =>
    kind !== 'context' && (selected ? selected.has(idx) : true);

  // Each side's original EOF-newline state, from the ORIGINAL hunk markers
  // (identical derivation to buildReversePatch).
  let oldNoNewline = false;
  let newNoNewline = false;
  for (const entry of hunk.entries) {
    if (entry.markers.length === 0) { continue; }
    if (entry.kind === 'context') { oldNoNewline = true; newNoNewline = true; }
    else if (entry.kind === 'delete') { oldNoNewline = true; }
    else { newNoNewline = true; }
  }

  // Reorder each maximal run of consecutive +/- entries by pairing the k-th
  // delete with the k-th add (same convention as word-diff's pairHunkWordDiffs).
  // Raw git diff emits a run as ALL deletes then ALL adds; when a delete in the
  // middle of a run is demoted to context (kept in the index) while a LATER add
  // in the same run is staged, emitting them in raw order would place the
  // demoted context AHEAD of the staged add in the body, and since `git apply`
  // emits `+` content strictly in patch-encounter order, that silently swaps the
  // two lines' order in the resulting index blob. Pairing keeps each add
  // adjacent to "its" delete's original slot so partial-run selection preserves
  // line order. `origIdx` still refers to the ORIGINAL hunk.entries index (the
  // lineIndices convention), only the traversal order changes.
  // ponytail: only reorders WITHIN a same-kind run; runs that are pure adds or
  // pure deletes (the SAMPLE-based unit tests) are emitted unchanged.
  const orderedEntries: Array<{ entry: (typeof hunk.entries)[number]; origIdx: number }> = [];
  {
    let i = 0;
    while (i < hunk.entries.length) {
      if (hunk.entries[i].kind === 'context') {
        orderedEntries.push({ entry: hunk.entries[i], origIdx: i });
        i++;
        continue;
      }
      const runStart = i;
      while (i < hunk.entries.length && hunk.entries[i].kind !== 'context') { i++; }
      const dels: number[] = [];
      const adds: number[] = [];
      for (let j = runStart; j < i; j++) {
        (hunk.entries[j].kind === 'delete' ? dels : adds).push(j);
      }
      const pairCount = Math.max(dels.length, adds.length);
      for (let k = 0; k < pairCount; k++) {
        if (k < dels.length) { orderedEntries.push({ entry: hunk.entries[dels[k]], origIdx: dels[k] }); }
        if (k < adds.length) { orderedEntries.push({ entry: hunk.entries[adds[k]], origIdx: adds[k] }); }
      }
    }
  }

  // Whether the hunk's final NEW-side entry survives onto the new side of our
  // reconstruction (so the new side still reaches new-EOF). Context always
  // survives; a trailing add survives only if selected. Deletions aren't on the
  // new side, so scan past them. (Mirror of buildReversePatch's oldReachesEof.)
  // Scanned over the REORDERED traversal — the pairing above can change which
  // entry ends up last on the new side.
  let newReachesEof = false;
  for (let i = orderedEntries.length - 1; i >= 0; i--) {
    const { entry, origIdx } = orderedEntries[i];
    if (entry.kind === 'context') { newReachesEof = true; break; }
    if (entry.kind === 'add') {
      // 'stage': an unselected add is OMITTED (not on the new side) → depends
      // on selection. 'unstage': an unselected add is DEMOTED to context
      // (always on the new side) → always survives regardless of selection.
      newReachesEof = direction === 'unstage' ? true : isStaging(origIdx, 'add');
      break;
    }
    if (direction === 'stage' && !isStaging(origIdx, 'delete')) {
      // An unselected deletion is demoted to context, so the staged result
      // retains the old side's EOF instead of reaching the working side's EOF.
      break;
    }
    // Selected delete — absent from the new side; keep scanning.
  }

  // Whether the hunk's final OLD-side entry survives onto the old side of our
  // reconstruction (mirror of newReachesEof, for deletions). Context always
  // survives; a trailing delete survives per direction: 'stage' demotes an
  // unselected delete to context (always on the old side, so this is always
  // true there — same as before this existed); 'unstage' OMITS an unselected
  // delete entirely (survives only if selected). Adds aren't on the old side,
  // so scan past them.
  let oldReachesEof = false;
  for (let i = orderedEntries.length - 1; i >= 0; i--) {
    const { entry, origIdx } = orderedEntries[i];
    if (entry.kind === 'context') { oldReachesEof = true; break; }
    if (entry.kind === 'delete') {
      oldReachesEof = direction === 'stage' ? true : isStaging(origIdx, 'delete');
      break;
    }
    if (direction === 'unstage' && !isStaging(origIdx, 'add')) {
      // An unselected addition is demoted to context, so the partially
      // unstaged result retains the index side's EOF.
      break;
    }
    // Selected add — removed from the old side on reverse; keep scanning.
  }

  const bodyLines: BodyLine[] = [];
  let oldCount = 0;
  let newCount = 0;
  let stagedAny = false;

  for (const { entry, origIdx } of orderedEntries) {
    if (entry.kind === 'context') {
      bodyLines.push({ text: entry.text, onOld: true, onNew: true });
      oldCount++;
      newCount++;
    } else if (entry.kind === 'add') {
      if (isStaging(origIdx, 'add')) {
        // Keep as an addition (new side only); apply --cached adds it to the index.
        bodyLines.push({ text: entry.text, onOld: false, onNew: true });
        newCount++;
        stagedAny = true;
      } else if (direction === 'unstage') {
        // 'unstage': the add side IS the baseline (current index) here, so an
        // unselected add stays exactly as currently staged → demote to context
        // instead of omitting it.
        bodyLines.push({ text: ' ' + entry.text.slice(1), onOld: true, onNew: true });
        oldCount++;
        newCount++;
      }
      // 'stage', unselected addition: OMIT it — not in the index and we aren't staging it.
    } else {
      if (isStaging(origIdx, 'delete')) {
        // Keep as a removal (old side only); apply --cached removes it from the index.
        bodyLines.push({ text: entry.text, onOld: true, onNew: false });
        oldCount++;
        stagedAny = true;
      } else if (direction === 'unstage') {
        // 'unstage': the delete side is HEAD content, not the baseline, so an
        // unselected delete is OMITTED entirely rather than demoted.
      } else {
        // 'stage': demote to context — the line stays in the index (both sides).
        bodyLines.push({ text: ' ' + entry.text.slice(1), onOld: true, onNew: true });
        oldCount++;
        newCount++;
      }
    }
  }

  if (!stagedAny) {
    throw new Error('No changed lines selected to stage');
  }

  // Re-attach no-newline markers from the RECONSTRUCTED body (mirror of reverse,
  // old/new swapped).
  let lastOld = -1;
  let lastNew = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].onOld) { lastOld = i; }
    if (bodyLines[i].onNew) { lastNew = i; }
  }

  // The current-index baseline is always complete: old for stage, new for
  // unstage. The reconstructed opposite side uses its own EOF state only when
  // it reaches that side's original EOF; otherwise an unselected trailing
  // change leaves the baseline side's EOF state in place.
  const oldEndsNoNewline = lastOld !== -1 && (
    (direction === 'stage' || oldReachesEof) ? oldNoNewline : newNoNewline
  );
  const newEndsNoNewline = lastNew !== -1 && (
    (direction === 'unstage' || newReachesEof) ? newNoNewline : oldNoNewline
  );

  const body: string[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const ln = bodyLines[i];
    const isOldTerm = oldEndsNoNewline && i === lastOld;
    const isNewTerm = newEndsNoNewline && i === lastNew;

    if (isOldTerm && isNewTerm) {
      // Same shared trailing line terminates both sides → one marker.
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isNewTerm && i < lastOld && ln.onOld && ln.onNew) {
      // Shared line that is the new-side terminator but old-only (kept-delete)
      // lines follow: split so the marker terminates the new side without
      // truncating the old. The split contributes one old + one new line — the
      // same as the context line it replaces — so the running counts are unchanged.
      const content = ln.text.slice(1);
      body.push('+' + content, NO_NEWLINE_MARKER, '-' + content);
    } else if (isOldTerm && i < lastNew && ln.onOld && ln.onNew) {
      // Mirror split: shared line is the old-side terminator but new-only
      // (kept-add) lines follow (reachable in 'unstage', where the old side can
      // now end short of the new side) — split so the marker terminates the old
      // side without truncating the new.
      const content = ln.text.slice(1);
      body.push('-' + content, NO_NEWLINE_MARKER, '+' + content);
    } else if (isNewTerm) {
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else if (isOldTerm) {
      body.push(ln.text, NO_NEWLINE_MARKER);
    } else {
      body.push(ln.text);
    }
  }

  const headerLine = rewriteHunkHeader(hunk.headerLine, oldCount, newCount);
  const finalHeader = normalizeWholeFileHeader(header, oldCount, newCount);
  const patch = [...finalHeader, headerLine, ...body].join('\n') + '\n';
  return encodePatchBytes(rawFileDiff, patch);
}
/* SNIPCODE-HOOK end */
