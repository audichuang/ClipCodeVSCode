// Intraline (word-level) diff for the diff viewer: given a removed line and the
// added line that replaced it, return the character ranges that actually changed
// on each side, so only the changed words are highlighted (matching IntelliJ)
// instead of the whole line. Pure + framework-free — unit-tested without a DOM.

/** Half-open char range [start, end) into a single line. */
export interface Range { start: number; end: number }

export interface DiffLineLite { type: 'add' | 'delete' | 'context'; content: string }

export interface WordDiffResult { delRanges: Range[]; addRanges: Range[] }

// Longest line pair we bother diffing. Beyond this an O(n*m) LCS over a
// minified/generated line is not worth the cost and the highlight is noise, so
// callers fall back to whole-line coloring.
// ponytail: fixed cap; make it configurable only if a real file needs it.
const MAX_LEN = 400;

// Split a line into tokens: runs of word chars, runs of whitespace, and single
// other chars. Keeping delimiters as their own tokens means the joined tokens
// reproduce the line exactly, so accumulated token lengths give exact offsets.
// The `u` flag makes `[^\w\s]` match a whole Unicode code point per token
// instead of a lone UTF-16 surrogate half, so an emoji (astral code point,
// stored as a surrogate pair) is one token the LCS compares as a unit — without
// it, an emoji got split into two independently-diffed halves and a changed
// range could land mid-surrogate-pair. Token lengths (and thus range offsets)
// stay UTF-16-unit-based either way, matching Shiki's own indexing.
function tokenize(line: string): string[] {
  return line.match(/\w+|\s+|[^\w\s]/gu) ?? [];
}

// Convert per-token changed flags into merged char ranges over the joined line.
function tokensToRanges(tokens: string[], changed: boolean[]): Range[] {
  const ranges: Range[] = [];
  let offset = 0;
  for (let k = 0; k < tokens.length; k++) {
    const len = tokens[k].length;
    if (changed[k]) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === offset) { last.end = offset + len; } // merge adjacent
      else { ranges.push({ start: offset, end: offset + len }); }
    }
    offset += len;
  }
  return ranges;
}

export function computeWordDiff(oldLine: string, newLine: string): WordDiffResult {
  if (oldLine.length > MAX_LEN || newLine.length > MAX_LEN) {
    return {
      delRanges: oldLine.length ? [{ start: 0, end: oldLine.length }] : [],
      addRanges: newLine.length ? [{ start: 0, end: newLine.length }] : [],
    };
  }

  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const n = a.length;
  const m = b.length;

  // LCS length DP: dp[i][j] = LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the LCS: tokens NOT on the common subsequence are "changed".
  const delChanged = new Array<boolean>(n).fill(false);
  const addChanged = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { delChanged[i] = true; i++; }
    else { addChanged[j] = true; j++; }
  }
  while (i < n) { delChanged[i] = true; i++; }
  while (j < m) { addChanged[j] = true; j++; }

  return {
    delRanges: tokensToRanges(a, delChanged),
    addRanges: tokensToRanges(b, addChanged),
  };
}

/**
 * For each line index in a hunk, the intraline ranges to highlight. Only lines
 * inside a delete-block immediately followed by an add-block (the classic
 * "replace" shape IntelliJ word-highlights) get ranges; the k-th deleted line is
 * paired with the k-th added line of that block. Pure/index-in.
 */
export function pairHunkWordDiffs(
  lines: DiffLineLite[],
): Map<number, { ranges: Range[]; kind: 'add' | 'delete' }> {
  const out = new Map<number, { ranges: Range[]; kind: 'add' | 'delete' }>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'delete') { i++; continue; }
    let d = i;
    while (d < lines.length && lines[d].type === 'delete') { d++; }
    let a = d;
    while (a < lines.length && lines[a].type === 'add') { a++; }
    const dels = d - i;      // delete lines [i, d)
    const adds = a - d;      // add lines    [d, a)
    const pairs = Math.min(dels, adds);
    for (let k = 0; k < pairs; k++) {
      const delIdx = i + k;
      const addIdx = d + k;
      const { delRanges, addRanges } = computeWordDiff(lines[delIdx].content, lines[addIdx].content);
      if (delRanges.length) { out.set(delIdx, { ranges: delRanges, kind: 'delete' }); }
      if (addRanges.length) { out.set(addIdx, { ranges: addRanges, kind: 'add' }); }
    }
    // Advance past the whole block; guarantee forward progress.
    i = a > i ? a : i + 1;
  }
  return out;
}
