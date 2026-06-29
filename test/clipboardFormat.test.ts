import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGitPayload,
  buildPayload,
  extractLeadingLabels,
  formatHeader,
  parseClipboard,
  stripLeadingLabels
} from '../src/clipboardFormat.js';
import { DELETED_FILE_MARKER } from '../src/gitCopy.js';

test('formats default and labeled headers like IntelliJ ClipCode', () => {
  assert.equal(formatHeader('// file: $FILE_PATH', 'src/main.ts'), '// file: src/main.ts');
  assert.equal(formatHeader('// file: $FILE_PATH', 'src/main.ts', 'MODIFIED'), '// file: [MODIFIED] src/main.ts');
  assert.equal(formatHeader('$FILE_PATH -> $FILE_PATH', 'src/main.ts'), 'src/main.ts -> src/main.ts');
});

test('parses custom and generic file headers', () => {
  const custom = parseClipboard('### src/a.ts\none', '### $FILE_PATH');
  assert.deepEqual(custom, [{ path: 'src/a.ts', content: 'one', changeTypes: new Set() }]);

  const generic = parseClipboard('# file: src/b.ts\ntwo', 'missing placeholder');
  assert.deepEqual(generic, [{ path: 'src/b.ts', content: 'two', changeTypes: new Set() }]);
});

test('does not split inline source text or object properties as headers', () => {
  const parsed = parseClipboard(`// file: src/app.ts
const config = {
  file: undefined,
  note: "do not split // file: src/nope.ts here"
};
// file: src/next.ts
next();`, '// file: $FILE_PATH');

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].path, 'src/app.ts');
  assert.match(parsed[0].content, /file: undefined,/);
  assert.match(parsed[0].content, /do not split/);
  assert.equal(parsed[1].path, 'src/next.ts');
});

test('extracts and strips leading change labels only', () => {
  assert.deepEqual(extractLeadingLabels('[DELETED] [MOVED] src/a.ts'), new Set(['DELETED', 'MOVED']));
  assert.equal(stripLeadingLabels('[DELETED] src/a.ts'), 'src/a.ts');
  assert.deepEqual(extractLeadingLabels('src/[DELETED]/a.ts'), new Set());
});

test('builds payload with pre text, post text, extra lines, and skipped markers', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '<files>',
    postText: '</files>',
    addExtraLineBetweenFiles: true,
    files: [
      { path: 'src/a.ts', content: 'one' },
      { path: 'src/b.ts', skippedReason: 'size exceeds limit (999 bytes)' }
    ]
  });

  assert.equal(payload, `<files>
// file: src/a.ts
one

// file: src/b.ts
// File skipped: size exceeds limit (999 bytes)

</files>`);
});

test('regular copy payload keeps empty pre and post slots like IntelliJ', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [
      { path: 'src/a.ts', content: 'one' }
    ]
  });

  assert.equal(payload, '\n// file: src/a.ts\none\n\n');
});

test('preserves the file content own leading indentation on the first line', () => {
  const parsed = parseClipboard('// file: src/a.ts\n  indented', '// file: $FILE_PATH');
  assert.equal(parsed[0].content, '  indented');
});

test('preserves a content line that is only spaces between real lines', () => {
  // A blank line made of spaces inside the body must survive (it is content, not structure).
  const parsed = parseClipboard('// file: src/a.ts\na\n   \nb', '// file: $FILE_PATH');
  assert.equal(parsed[0].content, 'a\n   \nb');
});

test('preserves interior and trailing spaces on content lines', () => {
  const parsed = parseClipboard('// file: src/a.ts\na  \n  b', '// file: $FILE_PATH');
  assert.equal(parsed[0].content, 'a  \n  b');
});

test('removes the inter-file separator blank and does not leak pre/post wrappers', () => {
  // Exactly the bytes buildPayload emits for a regular copy of two files.
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [
      { path: 'src/a.ts', content: 'one' },
      { path: 'src/b.ts', content: 'two' }
    ]
  });
  const parsed = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].content, 'one');
  assert.equal(parsed[1].content, 'two');
});

test('round-trips a file whose content contains a header-shaped line (Scheme A)', () => {
  const evil = '// file: src/evil.ts';
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: `before\n${evil}\nafter` }]
  });
  // The collision line is visibly marked in the wire format.
  assert.match(payload, /\/\/clipcode-esc: \/\/ file: src\/evil\.ts/);
  const parsed = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'src/a.ts');
  assert.equal(parsed[0].content, `before\n${evil}\nafter`);
});

test('round-trips content that already starts with the escape marker (no false unescape)', () => {
  const literal = '//clipcode-esc: // file: src/x.ts';
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: literal }]
  });
  const parsed = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(parsed[0].content, literal);
});

test('header-shaped postText does not create a phantom file', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '// file: src/footer.ts',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: 'one' }]
  });
  const parsed = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'src/a.ts');
});

test('parses old unescaped clipboards unchanged (backward compatible read)', () => {
  // No marker present: content unescapes to itself.
  const parsed = parseClipboard('// file: src/a.ts\nplain\ncontent', '// file: $FILE_PATH');
  assert.equal(parsed[0].content, 'plain\ncontent');
});

test('a degenerate headerFormat that matches every line does not get every content line marked', () => {
  // headerFormat '$FILE_PATH' -> regex /^(.+?)$/ matches anything, so prefixing the
  // marker can't hide a line; escaping must no-op rather than mark every line.
  const payload = buildPayload({
    headerFormat: '$FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: 'line one\nline two' }]
  });
  assert.doesNotMatch(payload, /clipcode-esc/);
});

test('git payload skips empty wrappers but keeps labels and deleted marker', () => {
  const payload = buildGitPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [
      { path: 'src/old.ts', content: DELETED_FILE_MARKER, changeType: 'DELETED' }
    ]
  });

  assert.equal(payload, `// file: [DELETED] src/old.ts
${DELETED_FILE_MARKER}
`);
});
