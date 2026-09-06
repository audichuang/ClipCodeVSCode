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
/* SNIPCODE-HOOK start: Batch C bound eager word-diff work. */
const MAX_TOKEN_DP_CELLS = 20_000;
const MAX_REWRITE_LINES = 400;
/* SNIPCODE-HOOK start: Batch D LCS-based rewrite-line pairing. */
const MAX_LINE_ALIGNMENT_CELLS = 4_000;
/* SNIPCODE-HOOK end */
/* SNIPCODE-HOOK start: ui/diff D12 minimum similarity to pair a delete/add as a "replace" */
// Below this, two lines share only a stray bigram or two (whitespace,
// punctuation) — pairing them produces intraline highlight noise rather than
// a meaningful "this became that". Below this score they're left unpaired
// (ordinal fallback / no word-diff at all for that line).
const MIN_REWRITE_SIMILARITY = 35;
/* SNIPCODE-HOOK end */

function lineLevelFallback(oldLine: string, newLine: string): WordDiffResult {
  return {
    delRanges: oldLine.length ? [{ start: 0, end: oldLine.length }] : [],
    addRanges: newLine.length ? [{ start: 0, end: newLine.length }] : [],
  };
}
/* SNIPCODE-HOOK end */

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
  /* SNIPCODE-HOOK start: Batch C share the bounded line-level fallback. */
  if (oldLine.length > MAX_LEN || newLine.length > MAX_LEN) {
    return lineLevelFallback(oldLine, newLine);
  }
  /* SNIPCODE-HOOK end */

  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  const n = a.length;
  const m = b.length;
  /* SNIPCODE-HOOK start: Batch C avoid pathological token LCS matrices. */
  if (n * m > MAX_TOKEN_DP_CELLS) return lineLevelFallback(oldLine, newLine);
  /* SNIPCODE-HOOK end */

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

  const delRanges = tokensToRanges(a, delChanged);
  const addRanges = tokensToRanges(b, addChanged);

  /* SNIPCODE-HOOK start: ui/diff D12 fall back to whole-line for over-fragmented diffs */
  // A near-total rewrite (few/no shared tokens) still LCS-matches on stray
  // whitespace/punctuation, producing a scatter of 2-3 char highlighted
  // fragments across the whole line — noise, not signal (IntelliJ/VS Code
  // both have an equivalent heuristic). Ratio is highlighted-chars-summed
  // over line-length-summed (not per-side) so a short "Mac"->"asdsadadMac"
  // tail-only change — where the ADD side alone is >65% changed but the
  // total edit is still small and worth showing — doesn't trip this.
  const totalRanges = delRanges.length + addRanges.length;
  if (totalRanges > 5) return lineLevelFallback(oldLine, newLine);
  const highlightedChars = (ranges: Range[]) => ranges.reduce((s, r) => s + (r.end - r.start), 0);
  const totalLen = oldLine.length + newLine.length;
  if (totalLen > 0 && (highlightedChars(delRanges) + highlightedChars(addRanges)) / totalLen > 0.65) {
    return lineLevelFallback(oldLine, newLine);
  }
  /* SNIPCODE-HOOK end */

  return { delRanges, addRanges };
}

/* SNIPCODE-HOOK start: Batch D LCS-based rewrite-line pairing. */
function lineBigrams(line: string): string[] {
  const chars = Array.from(line.toLowerCase());
  return chars.slice(1).map((char, index) => chars[index] + char);
}

function commonItemCount(left: string[], right: string[]): number {
  const remaining = new Map<string, number>();
  for (const item of right) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  let common = 0;
  for (const item of left) {
    const count = remaining.get(item) ?? 0;
    if (count > 0) {
      common++;
      remaining.set(item, count - 1);
    }
  }
  return common;
}

function lineSimilarity(left: string, right: string, leftBigrams: string[], rightBigrams: string[]): number {
  if (left === right) return 100;
  if (leftBigrams.length + rightBigrams.length > 0) {
    return Math.floor(200 * commonItemCount(leftBigrams, rightBigrams)
      / (leftBigrams.length + rightBigrams.length));
  }
  return 0;
}

function pairRewriteLines(deletes: DiffLineLite[], adds: DiffLineLite[]): Array<[number, number]> {
  const ordinal = () => Array.from({ length: Math.min(deletes.length, adds.length) }, (_, index) => [index, index] as [number, number]);
  if (deletes.length * adds.length > MAX_LINE_ALIGNMENT_CELLS
    || [...deletes, ...adds].some(line => line.content.length > MAX_LEN)) return ordinal();

  const deleteBigrams = deletes.map(line => lineBigrams(line.content));
  const addBigrams = adds.map(line => lineBigrams(line.content));
  const scores = deletes.map((left, i) => adds.map((right, j) =>
    lineSimilarity(left.content, right.content, deleteBigrams[i], addBigrams[j])));
  const dp: number[][] = Array.from({ length: deletes.length + 1 }, () => new Array<number>(adds.length + 1).fill(0));
  for (let i = deletes.length - 1; i >= 0; i--) {
    for (let j = adds.length - 1; j >= 0; j--) {
      const paired = scores[i][j] >= MIN_REWRITE_SIMILARITY ? scores[i][j] + dp[i + 1][j + 1] : -1;
      dp[i][j] = Math.max(paired, dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < deletes.length && j < adds.length) {
    const paired = scores[i][j] >= MIN_REWRITE_SIMILARITY ? scores[i][j] + dp[i + 1][j + 1] : -1;
    if (paired === dp[i][j] && paired >= dp[i + 1][j] && paired >= dp[i][j + 1]) {
      pairs.push([i++, j++]);
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: Batch D LCS-based rewrite-line pairing. */
/**
 * For each line index in a hunk, the intraline ranges to highlight. Only lines
 * inside a delete-block immediately followed by an add-block (the classic
 * "replace" shape IntelliJ word-highlights) get ranges. Pure/index-in.
 */
/* SNIPCODE-HOOK end */
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
    /* SNIPCODE-HOOK start: Batch C fall back to line-level for mass rewrites. */
    if (dels + adds > MAX_REWRITE_LINES) {
      i = a > i ? a : i + 1;
      continue;
    }
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: Batch D LCS-based rewrite-line pairing. */
    for (const [delOffset, addOffset] of pairRewriteLines(lines.slice(i, d), lines.slice(d, a))) {
      const delIdx = i + delOffset;
      const addIdx = d + addOffset;
      const { delRanges, addRanges } = computeWordDiff(lines[delIdx].content, lines[addIdx].content);
      if (delRanges.length) { out.set(delIdx, { ranges: delRanges, kind: 'delete' }); }
      if (addRanges.length) { out.set(addIdx, { ranges: addRanges, kind: 'add' }); }
    }
    /* SNIPCODE-HOOK end */
    // Advance past the whole block; guarantee forward progress.
    i = a > i ? a : i + 1;
  }
  return out;
}
