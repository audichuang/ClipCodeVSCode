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

test('readRefContent tries show then buffer and skips binary', async () => {
  const repo = {
    rootUri: { fsPath: '/repo' },
    show: async (_ref: string, p: string) => (p === 'src/a.ts' ? 'CONTENT' : Promise.reject(new Error('no'))),
  };
  assert.equal(await readRefContent(repo, 'abc123', '/repo/src/a.ts'), 'CONTENT');

  const bufRepo = {
    rootUri: { fsPath: '/repo' },
    show: async () => { throw new Error('no show'); },
    buffer: async () => new TextEncoder().encode('FROM_BUFFER'),
  };
  assert.equal(await readRefContent(bufRepo, 'abc123', '/repo/src/a.ts'), 'FROM_BUFFER');
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
