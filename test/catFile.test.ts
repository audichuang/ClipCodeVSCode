import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBatchRequest, parseCatFileBatch } from '../src/catFile.js';

// Build a realistic `git cat-file --batch` stdout for the given entries.
function batchOutput(entries: Array<{ oid: string; content: string } | { missing: string }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if ('missing' in e) {
      parts.push(Buffer.from(`${e.missing} missing\n`, 'utf8'));
    } else {
      const body = Buffer.from(e.content, 'utf8');
      parts.push(Buffer.from(`${e.oid} blob ${body.length}\n`, 'utf8'));
      parts.push(body);
      parts.push(Buffer.from('\n', 'utf8'));
    }
  }
  return Buffer.concat(parts);
}

test('formatBatchRequest writes one <hash>:<path> per line', () => {
  assert.equal(formatBatchRequest('abc', ['a.ts', 'dir/b.ts']), 'abc:a.ts\nabc:dir/b.ts\n');
});

test('parses blob contents in request order', () => {
  const out = batchOutput([
    { oid: '1111', content: 'const a = 1;\n' },
    { oid: '2222', content: 'export const b = 2;' }
  ]);
  const map = parseCatFileBatch(out, ['a.ts', 'b.ts']);
  assert.equal(map.get('a.ts'), 'const a = 1;\n');
  assert.equal(map.get('b.ts'), 'export const b = 2;');
});

test('content with embedded newlines is parsed by byte count, not by lines', () => {
  const tricky = 'line1\n0000 blob 5\nline2';
  const out = batchOutput([{ oid: 'aaaa', content: tricky }, { oid: 'bbbb', content: 'next' }]);
  const map = parseCatFileBatch(out, ['x.ts', 'y.ts']);
  assert.equal(map.get('x.ts'), tricky);
  assert.equal(map.get('y.ts'), 'next');
});

test('missing object maps to undefined and following entries still align', () => {
  const out = batchOutput([
    { missing: 'abc:gone.ts' },
    { oid: '3333', content: 'still here' }
  ]);
  const map = parseCatFileBatch(out, ['gone.ts', 'here.ts']);
  assert.equal(map.get('gone.ts'), undefined);
  assert.equal(map.get('here.ts'), 'still here');
});

test('binary content with a NUL byte maps to undefined', () => {
  const body = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x44]); // PNG<NUL>D
  const out = Buffer.concat([
    Buffer.from(`4444 blob ${body.length}\n`, 'utf8'),
    body,
    Buffer.from('\n', 'utf8')
  ]);
  const map = parseCatFileBatch(out, ['img.png']);
  assert.equal(map.get('img.png'), undefined);
});

test('empty file maps to empty string, not undefined', () => {
  const out = batchOutput([{ oid: '5555', content: '' }]);
  const map = parseCatFileBatch(out, ['empty.ts']);
  assert.equal(map.get('empty.ts'), '');
});

test('truncated output leaves remaining paths unresolved without throwing', () => {
  const out = Buffer.from('6666 blob 4\nabcd\n7777 blob 100\nshort', 'utf8');
  const map = parseCatFileBatch(out, ['ok.ts', 'truncated.ts']);
  assert.equal(map.get('ok.ts'), 'abcd');
  assert.equal(map.get('truncated.ts'), undefined);
});
