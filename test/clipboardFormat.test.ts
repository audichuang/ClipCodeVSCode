import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGitPayload,
  buildPayload,
  extractLeadingLabels,
  extractSourceRoot,
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

test('escapes a CRLF content line that would parse as a custom header', () => {
  const format = '### $FILE_PATH';
  // buildPayload escapes via split('\n'), so the line still carries its \r; the parser
  // splits on /\r?\n/ and would see it as a header unless it is escaped.
  const payload = buildPayload({
    headerFormat: format,
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: false,
    files: [{ path: 'src/main.kt', content: '### src/a.kt\r\nreal body line' }]
  });
  assert.ok(payload.includes('//clipcode-esc: ### src/a.kt'), `CRLF header-looking line must be escaped: ${payload}`);

  const entries = parseClipboard(payload, format);
  assert.equal(entries.length, 1, `a phantom file must not appear: ${entries.map(e => e.path).join(',')}`);
  assert.equal(entries[0].path, 'src/main.kt');
  assert.ok(entries[0].content.includes('### src/a.kt'));
  assert.ok(entries[0].content.includes('real body line'));
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

  // `// clipcode-end` terminates the last file's body on the wire. Without it the parser
  // has nothing to tell file content from the footer, so `</files>` was accumulated into
  // src/b.ts — which also made that placeholder body multi-line and disarmed the guard
  // that stops a stub overwriting the real file.
  assert.equal(payload, `<files>
// file: src/a.ts
one

// file: src/b.ts
// File skipped: size exceeds limit (999 bytes)

// clipcode-end
</files>`);

  // Round-trips: the footer is not content, and the marker is not a file.
  const entries = parseClipboard(payload, '// file: $FILE_PATH');
  assert.deepEqual(entries.map(e => e.path), ['src/a.ts', 'src/b.ts']);
  assert.equal(entries[1].content, '// File skipped: size exceeds limit (999 bytes)');
});

test('a content line that IS the end marker round-trips as content', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: 'FOOTER',
    addExtraLineBetweenFiles: false,
    files: [{ path: 'doc.md', content: 'before\n// clipcode-end\nafter' }]
  });
  assert.ok(payload.includes('//clipcode-esc: // clipcode-end'), 'the literal marker must be escaped');
  const entries = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, 'before\n// clipcode-end\nafter', 'a real marker line must survive');
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

test('sourceRoot metadata round-trips and is ignored by the file parser', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: 'x' }],
    sourceRoot: 'inv-svc-console'
  });
  assert.ok(payload.startsWith('// clipcode-root: inv-svc-console\n'));
  assert.equal(extractSourceRoot(payload), 'inv-svc-console');
  // The metadata line must not become a phantom file or alter parsed content.
  const parsed = parseClipboard(payload, '// file: $FILE_PATH');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'src/a.ts');
  assert.equal(parsed[0].content, 'x');
});

test('a permissive headerFormat does not turn the metadata line into a phantom file', () => {
  // "// $FILE_PATH" matches almost any "// ..." line, including the metadata line.
  const payload = buildPayload({
    headerFormat: '// $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: 'x' }],
    sourceRoot: 'repo'
  });
  // Build side must NOT emit a metadata line it can't safely hide.
  assert.doesNotMatch(payload, /clipcode-root/);
  const parsed = parseClipboard(payload, '// $FILE_PATH');
  assert.equal(parsed.filter(e => e.path.includes('clipcode-root')).length, 0);
});

test('parser drops a leading metadata line even under a permissive header', () => {
  const text = '// clipcode-root: repo\n// $FILE_PATH-shaped? no\n// file: src/a.ts\nx';
  const parsed = parseClipboard(text, '// file: $FILE_PATH');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'src/a.ts');
});

test('extractSourceRoot returns undefined when no metadata line is present', () => {
  const payload = buildPayload({
    headerFormat: '// file: $FILE_PATH',
    preText: '',
    postText: '',
    addExtraLineBetweenFiles: true,
    files: [{ path: 'src/a.ts', content: 'x' }]
  });
  assert.equal(extractSourceRoot(payload), undefined);
  // A header-shaped first line must not be mistaken for metadata.
  assert.equal(extractSourceRoot('// file: src/a.ts\nx'), undefined);
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

test('the Turkish dotless i is not a header on either side', () => {
  // Kotlin IGNORE_CASE == CASE_INSENSITIVE|UNICODE_CASE folds U+0131 onto `i`; JS /i does
  // not. This exact line used to be content here and a header in ClipCode, so a Snipcode
  // payload pasted into ClipCode lost everything after it into a phantom file.
  const line = '// f\u0131le: phantom.ts';
  assert.deepEqual(parseClipboard(line, '// file: $FILE_PATH'), [], 'must not parse as a header');
  // ASCII case-insensitivity is preserved.
  assert.equal(parseClipboard('// FILE: a.ts\nbody', '// file: $FILE_PATH')[0]?.path, 'a.ts');
  assert.equal(parseClipboard('// File: b.ts\nbody', '// file: $FILE_PATH')[0]?.path, 'b.ts');
});
