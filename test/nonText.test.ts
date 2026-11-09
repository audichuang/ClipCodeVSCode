import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeStrictBase64,
  encodeWrapped,
  parseBody,
  parsePlaceholderLine,
  placeholderLine,
  sha256Hex
} from '../src/nonText.js';

const BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
const SHA = sha256Hex(BYTES);
const LINE = placeholderLine(BYTES.length, SHA);
const B64 = Buffer.from(BYTES).toString('base64');

test('placeholder line is exact and recognised only in that shape', () => {
  assert.equal(LINE, `// File skipped: non-text file, 7 bytes, sha256 ${SHA}; base64 follows`);
  assert.deepEqual(parsePlaceholderLine(LINE), { size: 7, sha256: SHA });
  assert.deepEqual(parsePlaceholderLine(`${LINE}\r`), { size: 7, sha256: SHA });
  assert.equal(parsePlaceholderLine(` ${LINE}`), undefined);
  assert.equal(parsePlaceholderLine(LINE.toUpperCase()), undefined);
  // Arabic-Indic digits are digits to \d but not to the spec.
  assert.equal(parsePlaceholderLine(LINE.replace(' 7 ', ' \u0667 ')), undefined);
  assert.equal(parsePlaceholderLine('// File skipped: size exceeds limit (9 bytes)'), undefined);
});

test('encodeWrapped wraps at 76 characters', () => {
  for (const n of [1, 2, 3, 56, 57, 58, 114, 1000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
    const lines = encodeWrapped(bytes).split('\n');
    assert.ok(lines.every(l => l.length <= 76), `n=${n}`);
    assert.ok(lines.slice(0, -1).every(l => l.length === 76), `n=${n}`);
    assert.equal(lines.join(''), Buffer.from(bytes).toString('base64'));
  }
});

test('strict decode rejects what Buffer.from(base64) silently accepts', () => {
  assert.deepEqual(decodeStrictBase64(B64), BYTES);
  // missing padding
  assert.equal(decodeStrictBase64('AA'), undefined);
  assert.equal(decodeStrictBase64('AA='), undefined);
  assert.equal(decodeStrictBase64(B64.replace(/=+$/, '')), undefined);
  // non-zero trailing bits: "AB==" decodes to the same byte as "AA==" under a lenient decoder
  assert.deepEqual(decodeStrictBase64('AA=='), Uint8Array.from([0]));
  assert.equal(decodeStrictBase64('AB=='), undefined);
  assert.equal(decodeStrictBase64('AAB='), undefined);
  // characters outside the alphabet (url-safe, noise)
  assert.equal(decodeStrictBase64('AA-A'), undefined);
  assert.equal(decodeStrictBase64('AA*A'), undefined);
  assert.equal(decodeStrictBase64('AAAA!'), undefined);
  // padding in the middle or too much of it
  assert.equal(decodeStrictBase64('AA==AAAA'), undefined);
  assert.equal(decodeStrictBase64('A==='), undefined);
});

test('strict decode ignores ASCII whitespace only (Rust is_ascii_whitespace: no VT)', () => {
  assert.deepEqual(decodeStrictBase64(` ${B64.slice(0, 3)}\r\n\t${B64.slice(3)} \f\n`), BYTES);
  // VT (0x0B) is not ASCII whitespace for OpenIDEA's nontext.rs, so the entry is corrupt there;
  // tolerating it here made the same payload restore on one side and fail on the other.
  assert.equal(decodeStrictBase64(`${B64.slice(0, 3)}\v${B64.slice(3)}`), undefined);
  assert.equal(decodeStrictBase64(`${B64.slice(0, 3)}\u00a0${B64.slice(3)}`), undefined);
});

test('parseBody verifies base64, size and sha256, and tolerates CRLF', () => {
  assert.equal(parseBody('plain text'), undefined);
  assert.equal(parseBody('// File skipped: size exceeds limit (9 bytes)'), undefined);
  assert.deepEqual(parseBody(`${LINE}\n${B64}`), { bytes: BYTES });
  assert.deepEqual(parseBody(`${LINE}\r\n${B64.slice(0, 4)}\r\n${B64.slice(4)}\r\n`), { bytes: BYTES });
  assert.deepEqual(parseBody(`${LINE}\n${B64.slice(0, -1)}`), { error: 'base64' });
  assert.deepEqual(parseBody(`${LINE}\n${B64.replace(/=+$/, '')}`), { error: 'base64' });
  assert.deepEqual(parseBody(placeholderLine(8, SHA) + `\n${B64}`), { error: 'size' });
  assert.deepEqual(parseBody(placeholderLine(7, '0'.repeat(64)) + `\n${B64}`), { error: 'sha256' });
  // a bare placeholder with no Base64 is corrupt, not text
  assert.deepEqual(parseBody(LINE), { error: 'size' });
});
