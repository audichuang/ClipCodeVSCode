import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeText, isTextContent, normalizeFsPath, repoRelativePath, readRefContent } from '../src/gitContent.js';

test('decodeText decodes utf8 and rejects binary', () => {
  assert.equal(decodeText(new TextEncoder().encode('hello')), 'hello');
  assert.equal(decodeText(new Uint8Array([0x68, 0x00, 0x69])), undefined); // contains NUL
});

test('isTextContent guards undefined and NUL', () => {
  assert.equal(isTextContent('abc'), true);
  assert.equal(isTextContent(undefined), false);
  assert.equal(isTextContent('a\0b'), false);
});

test('repoRelativePath strips root and uses forward slashes', () => {
  assert.equal(repoRelativePath('/repo', '/repo/src/auth/login.ts'), 'src/auth/login.ts');
});

test('normalizeFsPath trims trailing separator so /repo/ matches /repo', () => {
  assert.equal(normalizeFsPath('/repo/'), normalizeFsPath('/repo'));
  // slice arithmetic in repoRelativePath stays correct with a trailing-slash root
  assert.equal(repoRelativePath('/repo/', '/repo/src/a.ts'), 'src/a.ts');
});

test('readRefContent checks the bytes before it trusts the Git API string', async () => {
  const bufRepo = {
    rootUri: { fsPath: '/repo' },
    show: async () => 'SHOULD_NOT_BE_USED',
    buffer: async () => new TextEncoder().encode('FROM_BUFFER'),
  };
  assert.equal(await readRefContent(bufRepo, 'abc123', '/repo/src/a.ts'), 'FROM_BUFFER');

  // The real VS Code Git API decodes leniently: these Big5 bytes come back from show() as
  // the string '\uFFFD\u991F'. Asking show() first accepted that, and Paste & Restore wrote
  // the mojibake over the real file — the disk copy path has refused it all along.
  let showCalls = 0;
  const lenient = {
    rootUri: { fsPath: '/repo' },
    show: async () => { showCalls++; return '\uFFFD\u991F'; },
    buffer: async () => new Uint8Array([0xa4, 0xe9, 0xa5, 0xbb]),
  };
  assert.equal(await readRefContent(lenient, 'abc123', '/repo/src/a.ts'), undefined);
  assert.equal(showCalls, 0, 'with bytes in hand the decoded string must not be consulted');

  // show() alone stays supported — a string carries no bytes to validate.
  const showOnly = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => (p === 'src/a.ts' ? 'CONTENT' : Promise.reject(new Error('no'))),
  };
  assert.equal(await readRefContent(showOnly, 'abc123', '/repo/src/a.ts'), 'CONTENT');
});

test('non-UTF-8 bytes are skipped, never decoded to mojibake', () => {
  // Big5 for \u65e5\u672c\u8a9e-ish bytes: invalid as UTF-8. Decoding with fatal:false used to
  // yield U+FFFD soup, which Paste & Restore then wrote back over the real file.
  const big5 = new Uint8Array([0xa4, 0xe9, 0xa5, 0xbb, 0xbb, 0x79]);
  assert.equal(decodeText(big5), undefined);
  // Valid UTF-8 still decodes, BOM included.
  assert.equal(decodeText(new TextEncoder().encode('hello \u20ac')), 'hello \u20ac');
  // A NUL byte is still treated as binary.
  assert.equal(decodeText(new Uint8Array([0x61, 0x00, 0x62])), undefined);
});

test('repo-relative paths keep their real case, not a comparison key', () => {
  // normalizeFsPath lowercases on win32 because it is a comparison key; this value goes to
  // `git show <ref>:<path>`, which matches tree entries byte-exactly whatever
  // core.ignorecase says. Slicing the folded string returned `src/myfile.ts` on Windows
  // ONLY, so every mixed-case file missed its first lookup — and no Linux or macOS run
  // could ever see it. Mixed case is asserted here so the guard holds on every platform.
  assert.equal(repoRelativePath('/repo', '/repo/src/MyFile.ts'), 'src/MyFile.ts');
  assert.equal(repoRelativePath('/repo/', '/repo/src/Deep/Path.TS'), 'src/Deep/Path.TS');
});
