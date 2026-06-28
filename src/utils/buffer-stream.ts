import type { Readable } from 'stream';

export class BufferOverflowError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Stream output exceeded ${limitBytes} bytes`);
    this.name = 'BufferOverflowError';
  }
}

/** Concatenate a Readable into a single Buffer, aborting with
 *  BufferOverflowError if the cumulative byte count crosses maxBytes.
 *
 *  On overflow the stream is `destroy()`ed so upstream resources release.
 *  Used to bound git output so a pathological log/diff cannot OOM the
 *  extension host. */
export function bufferStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const onData = (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        stream.destroy();
        reject(new BufferOverflowError(maxBytes));
        return;
      }
      chunks.push(chunk);
    };

    stream.on('data', onData);
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    stream.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
