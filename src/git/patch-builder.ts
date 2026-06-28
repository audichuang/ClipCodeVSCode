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
      const plus = header.find((l) => l.startsWith('+++ b/'));
      out.push(plus ? '--- a/' + plus.slice('+++ b/'.length) : line);
    } else if (rewriteNew && line === '+++ /dev/null') {
      const minus = header.find((l) => l.startsWith('--- a/'));
      out.push(minus ? '+++ b/' + minus.slice('--- a/'.length) : line);
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
