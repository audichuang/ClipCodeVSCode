import { describe, it, expect } from 'vitest';
import { buildReversePatch } from '../patch-builder';
import { parseDiff } from '../git-parser';

// A replace hunk (delete + two adds) plus surrounding context, the shape the
// webview hands back line indices for.
const SAMPLE = `diff --git a/file.txt b/file.txt
index 1111111..2222222 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 line1
-line2
+line2-changed
+line2b
 line3
 line4
`;

describe('buildReversePatch', () => {
  it('reverses a whole hunk verbatim with recounted header', () => {
    const patch = buildReversePatch(SAMPLE, 0);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,5 @@',
        ' line1',
        '-line2',
        '+line2-changed',
        '+line2b',
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('demotes unselected additions to context and drops unselected deletions', () => {
    // Reverse only the second added line (index 3 in the parsed hunk).
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'line2b');
    expect(idx).toBe(3);

    const patch = buildReversePatch(SAMPLE, 0, [idx]);
    expect(patch).toBe(
      [
        'diff --git a/file.txt b/file.txt',
        'index 1111111..2222222 100644',
        '--- a/file.txt',
        '+++ b/file.txt',
        '@@ -1,4 +1,5 @@',
        ' line1',
        ' line2-changed', // unselected add → context (stays in working tree)
        '+line2b', //         selected add → reversed away
        ' line3',
        ' line4',
        '',
      ].join('\n'),
    );
  });

  it('keeps a selected deletion so reverse-apply restores it', () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'delete');
    const patch = buildReversePatch(SAMPLE, 0, [idx]);
    const body = patch.split('\n');
    expect(body).toContain('-line2'); // restored on reverse-apply
    expect(body).not.toContain('+line2-changed'); // unselected add dropped from new side
    expect(body).toContain(' line2-changed'); // ...as context instead
  });

  it('preserves a "No newline at end of file" marker', () => {
    const noEof = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const patch = buildReversePatch(noEof, 0);
    expect(patch).toContain('-old\n\\ No newline at end of file');
    expect(patch).toContain('+new\n\\ No newline at end of file');
  });

  // Scenario A: old file `a` (no EOF newline) → new `a\nP\nQ` (no EOF newline).
  // Reversing ONLY the last added line `Q`. The new side ends unterminated at the
  // kept add `+Q`. Reversing `+Q` away leaves `P` as the file's last line, which
  // must ALSO be unterminated — but `P` is a shared (demoted) line followed by
  // `+Q`, so a bare marker after it would wrongly truncate the new side too. The
  // builder splits that shared line into `-P`⟵marker / `+P`, terminating only the
  // old side while the new side continues to `+Q`. (The old buggy code emitted
  // ` P` then `+Q`⟵marker, which reverse-applied to `a\nP\n`, gaining a newline.)
  it('Scenario A: splits the shared tail when a no-newline trailing add is reversed', () => {
    const noEof = `diff --git a/f b/f
index 2e65efe..e61a8e2 100644
--- a/f
+++ b/f
@@ -1 +1,3 @@
-a
\\ No newline at end of file
+a
+P
+Q
\\ No newline at end of file
`;
    const hunk = parseDiff(noEof)[0].hunks[0];
    const idxQ = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'Q');
    const patch = buildReversePatch(noEof, 0, [idxQ]);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 2e65efe..e61a8e2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,3 @@',
        ' a',
        '-P',
        '\\ No newline at end of file', // old side ends unterminated at P,
        '+P',                            // ...while the new side continues...
        '+Q',
        '\\ No newline at end of file', // ...to the unterminated new EOF at Q.
        '',
      ].join('\n'),
    );
  });

  // Scenario B: old `X\nold` (no EOF) → new `X\nnew1\nnew2` (no EOF). Reversing
  // ONLY the deleted line `old`. The old buggy code kept `-old` WITH its inline
  // marker, so reverse-apply fused `old` onto `new1` (`X\noldnew1\nnew2`). The
  // marker actually belongs only on the genuine shared last line (`new2`), once.
  it('Scenario B: re-anchors the no-newline marker when only a delete is reversed', () => {
    const noEof = `diff --git a/f b/f
index 84951a9..3e493e2 100644
--- a/f
+++ b/f
@@ -1,2 +1,3 @@
 X
-old
\\ No newline at end of file
+new1
+new2
\\ No newline at end of file
`;
    const hunk = parseDiff(noEof)[0].hunks[0];
    const idxOld = hunk.lines.findIndex((l) => l.type === 'delete' && l.content === 'old');
    const patch = buildReversePatch(noEof, 0, [idxOld]);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 84951a9..3e493e2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,4 +1,3 @@',
        ' X',
        '-old', // restored on reverse-apply, NO inline marker
        ' new1',
        ' new2',
        '\\ No newline at end of file', // single marker on shared last context line
        '',
      ].join('\n'),
    );
  });

  // A no-EOF-newline diff whose hunk ends on a shared context line: the marker
  // must be emitted exactly once on that final context line, not duplicated.
  it('emits a single marker on a shared trailing context line', () => {
    const noEof = `diff --git a/f b/f
index 4d6e807..12db783 100644
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
-a
+A
 tail
\\ No newline at end of file
`;
    const patch = buildReversePatch(noEof, 0);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 4d6e807..12db783 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,2 +1,2 @@',
        '-a',
        '+A',
        ' tail',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
  });

  // A wholly-added file: `new file mode` + `--- /dev/null` header, all-add hunk.
  const ADDED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..83db48f
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;

  // A wholly-deleted file: `deleted file mode` + `+++ /dev/null` header, all-delete hunk.
  const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 83db48f..0000000
--- a/old.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;

  it('keeps the whole-file-add header when reversing the entire hunk (reverse-applies to a delete)', () => {
    // Every line stays an addition, so the new side is still the whole file and
    // the old side empty — the `new file mode` + `/dev/null` header is correct.
    const patch = buildReversePatch(ADDED, 0);
    expect(patch).toBe(ADDED);
  });

  it('rewrites the whole-file-add header into a modification for a partial reverse', () => {
    // Reverse only `line2`; `line1`/`line3` demote to context, so the old side is
    // no longer empty and the `/dev/null` header would be rejected by git.
    const hunk = parseDiff(ADDED)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'add' && l.content === 'line2');
    const patch = buildReversePatch(ADDED, 0, [idx]);
    expect(patch).toBe(
      [
        'diff --git a/new.txt b/new.txt',
        'index 0000000..83db48f 100644', // mode folded in from the dropped `new file mode`
        '--- a/new.txt', //                 was `--- /dev/null`
        '+++ b/new.txt',
        '@@ -0,2 +1,3 @@',
        ' line1', //  unselected add → context
        '+line2', //  selected add → reversed away
        ' line3',
        '',
      ].join('\n'),
    );
  });

  it('keeps the whole-file-delete header for both whole and partial reverses', () => {
    // Deletions never land on the new side, so it stays empty and the
    // `deleted file mode` + `/dev/null` header keeps reverse-applying to a create.
    const hunk = parseDiff(DELETED)[0].hunks[0];
    const idx = hunk.lines.findIndex((l) => l.type === 'delete' && l.content === 'line2');
    const patch = buildReversePatch(DELETED, 0, [idx]);
    expect(patch).toBe(
      [
        'diff --git a/old.txt b/old.txt',
        'deleted file mode 100644',
        'index 83db48f..0000000',
        '--- a/old.txt',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-line2', // restored on reverse-apply; the other deletions are dropped
        '',
      ].join('\n'),
    );
  });

  it('rewrites a whole-file-delete header into a modification when the new side becomes non-empty', () => {
    // Real git never emits a `+++ /dev/null` diff with surviving new-side
    // content, but the header normalizer defends against it symmetrically with
    // the add case. Craft a `deleted file` diff that carries a context line so a
    // partial reverse leaves `newCount > 0`, forcing the `+++ /dev/null` rewrite.
    const DELETED_WITH_CONTEXT = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 83db48f..0000000
--- a/old.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
 line2
-line3
`;
    // Reverse only line1 (index 0); line3's deletion is dropped, line2 stays as
    // context → the new side is non-empty, so `+++ /dev/null` must be rewritten.
    const patch = buildReversePatch(DELETED_WITH_CONTEXT, 0, [0]);
    expect(patch).toBe(
      [
        'diff --git a/old.txt b/old.txt',
        'index 83db48f..0000000 100644', // mode folded in from `deleted file mode`
        '--- a/old.txt',
        '+++ b/old.txt', //               was `+++ /dev/null`
        '@@ -1,2 +0,1 @@',
        '-line1', // restored on reverse-apply
        ' line2', // kept context — the now-non-empty new side
        '',
      ].join('\n'),
    );
  });

  it('keeps a blank (space-stripped) context line in the middle of a hunk', () => {
    // A blank context line whose leading ' ' was stripped must be preserved as a
    // single-space context line, not skipped (only the trailing split artifact is).
    const blankCtx = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,3 +1,3 @@
 top

-mid
+MID
`;
    const patch = buildReversePatch(blankCtx, 0);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'index 1..2 100644',
        '--- a/f',
        '+++ b/f',
        '@@ -1,3 +1,3 @@',
        ' top',
        ' ', // blank line preserved as a space-only context line
        '-mid',
        '+MID',
        '',
      ].join('\n'),
    );
  });

  it('passes through a hunk header it cannot parse', () => {
    // A malformed `@@` header (no line numbers) can't be recounted, so it is
    // emitted verbatim rather than mangled.
    const malformed = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ malformed @@
-a
+b
`;
    const patch = buildReversePatch(malformed, 0);
    expect(patch.split('\n')).toContain('@@ malformed @@');
    expect(patch).toContain('-a');
    expect(patch).toContain('+b');
  });

  it('throws for a diff that contains no hunks', () => {
    // Header-only diffs (e.g. a pure mode/rename change) have no hunk to reverse.
    const noHunk = 'diff --git a/f b/f\nold mode 100644\nnew mode 100755\n';
    expect(() => buildReversePatch(noHunk, 0)).toThrow(/not found/);
  });

  it('keeps the no-newline marker when reversing one line of a deleted no-EOF file', () => {
    // The deleted file ended without a trailing newline. Restoring only its last
    // line must reproduce that line, still unterminated, on the recreated file.
    const deletedNoEof = `diff --git a/f b/f
deleted file mode 100644
index 1234567..0000000 100644
--- a/f
+++ /dev/null
@@ -1,2 +0,0 @@
-p
-q
\\ No newline at end of file
`;
    const patch = buildReversePatch(deletedNoEof, 0, [1]);
    expect(patch).toBe(
      [
        'diff --git a/f b/f',
        'deleted file mode 100644',
        'index 1234567..0000000 100644',
        '--- a/f',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-q', // restored on reverse-apply...
        '\\ No newline at end of file', // ...still unterminated
        '',
      ].join('\n'),
    );
  });

  it('throws for an out-of-range hunk index', () => {
    expect(() => buildReversePatch(SAMPLE, 5)).toThrow(/not found/);
  });

  it('throws when the selection contains no changed lines', () => {
    const hunk = parseDiff(SAMPLE)[0].hunks[0];
    const ctxIdx = hunk.lines.findIndex((l) => l.type === 'context');
    expect(() => buildReversePatch(SAMPLE, 0, [ctxIdx])).toThrow(/No changed lines/);
  });
});
