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
