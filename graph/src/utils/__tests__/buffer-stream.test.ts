import { describe, it, expect } from 'vitest';
import { PassThrough } from 'stream';
import { bufferStream, BufferOverflowError } from '../buffer-stream';

describe('bufferStream', () => {
  it('resolves with concatenated bytes when stream ends under the limit', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 100);
    s.write(Buffer.from('hello '));
    s.write(Buffer.from('world'));
    s.end();
    expect((await p).toString()).toBe('hello world');
  });

  it('rejects with BufferOverflowError when total bytes exceed the limit', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 5);
    s.write(Buffer.from('hello'));
    s.write(Buffer.from('!')); // pushes to 6 bytes, over 5
    s.end();
    await expect(p).rejects.toBeInstanceOf(BufferOverflowError);
  });

  it('overflow includes the limit in the error message', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 3);
    s.write(Buffer.from('toolong'));
    s.end();
    await expect(p).rejects.toThrow(/exceeded.*3/);
  });

  it('rejects as soon as the limit is crossed, before stream end', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 5);
    s.write(Buffer.from('123456')); // immediate overflow
    // do not call s.end(); rejection should still happen
    await expect(p).rejects.toBeInstanceOf(BufferOverflowError);
  });

  it('handles empty stream', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 10);
    s.end();
    expect((await p).length).toBe(0);
  });

  it('propagates stream errors', async () => {
    const s = new PassThrough();
    const p = bufferStream(s, 10);
    s.destroy(new Error('boom'));
    await expect(p).rejects.toThrow(/boom/);
  });
});
