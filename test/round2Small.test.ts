import assert from 'node:assert/strict';
import test from 'node:test';
import { copyNoticeDetails, gitNothingToCopyNotice, nonTextDialog, nothingToCopyNotice } from '../src/nonTextDialog.js';
import { formatSize, skipReasonText } from '../src/restoreSummary.js';

// Round-2 small decided items: X6 (collision reason), X9 (no "0+"), X21 (zero-count lines), X28 (one size format).

const base = {
  nonTextFiles: [] as { path: string; size: number }[],
  excludedNonTextCount: 0,
  limitLeftOut: 0,
  skippedUnreadableCount: 0,
  unreadablePaths: [] as string[]
};

test('X6: the collision reason reads exactly "Another entry writes the same file"', () => {
  assert.equal(skipReasonText('TARGET_COLLISION'), 'Another entry writes the same file');
});

test('X28: one size format (N B, 4.0 KB, 12 KB, 1.5 MB)', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(83), '83 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(4096), '4.0 KB');
  assert.equal(formatSize(12 * 1024), '12 KB');
  assert.equal(formatSize(10 * 1024 - 1), '10 KB', 'rounds up to 10: no decimal from there');
  assert.equal(formatSize(1024 * 1024), '1.0 MB');
  assert.equal(formatSize(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatSize(40 * 1024 * 1024), '40 MB');
});

test('X9: a left-out number of 0 says "File limit N reached." and never "0+"', () => {
  for (const capped of [false, true]) {
    const notice = copyNoticeDetails({ ...base, limitLeftOutCapped: capped, fileLimitReached: true, fileCountLimit: 30 }).join(' ');
    assert.equal(notice, 'File limit 30 reached.');
    assert.ok(!notice.includes('0+') && !notice.includes('Left out'));
  }
  // Counting stopped early before it counted anything.
  assert.deepEqual(copyNoticeDetails({ ...base, limitLeftOutCapped: true, fileCountLimit: 30 }), ['File limit 30 reached.']);
  // A counted number keeps its clause and the limit sentence is not repeated.
  assert.deepEqual(
    copyNoticeDetails({ ...base, limitLeftOut: 4, fileLimitReached: true, fileCountLimit: 30 }),
    ['Left out by the file-count limit: 4.']);
  // Limit not reached: nothing.
  assert.deepEqual(copyNoticeDetails({ ...base, fileLimitReached: false, fileCountLimit: 30 }), []);
  // "Nothing to copy." carries it too.
  assert.equal(
    nothingToCopyNotice({ ...base, files: [], fileLimitReached: true, fileCountLimit: 30 }),
    'Nothing to copy. File limit 30 reached.');
});

// Spec case 29 → case 30: a Git copy left with nothing to copy names what was skipped after
// "Nothing to copy." (SCM and Graph said "No Git changes copied." / "No source copied.");
// with nothing skipped either, each surface keeps its plain "no changes" message.
test('case 30: Git surfaces with nothing left say "Nothing to copy." and the skipped categories', () => {
  const details = copyNoticeDetails({ ...base, nonPortableCount: 1, nonPortablePaths: ['q"uote.txt'] });
  assert.equal(gitNothingToCopyNotice(details, 'No Git changes found to copy.'), 'Nothing to copy. Name not portable: 1 (q"uote.txt).');
  assert.equal(gitNothingToCopyNotice([], 'No Git changes found to copy.'), 'No Git changes found to copy.');
  assert.equal(gitNothingToCopyNotice([], 'No source copied.'), 'No source copied.');
});

test('X21: dialog lines whose count is 0 are omitted', () => {
  const dialog = nonTextDialog({
    ...base,
    nonTextFiles: [{ path: 'a.png', size: 83 }],
    nonTextTotalBytes: 83,
    nonTextOverLimitCount: 0,
    unreadOverLimitCount: 0,
    limitLeftOut: 0,
    estimatedBytes: 200
  }, { headerFormat: '// file: $FILE_PATH' });
  assert.deepEqual(dialog.detail.split('\n'), [
    'Non-text files: 1 (83 B)',
    'Estimated payload with them: 200 B',
    'a.png  83 B'
  ]);
});
