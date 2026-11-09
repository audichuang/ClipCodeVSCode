import { spawn } from 'node:child_process';
import type { ContentRepo } from './gitContent.js';
import { formatBatchRequest } from './catFile.js';

/**
 * The raw bytes of one blob, or why there are none: 'missing' (git ran and the path is not
 * a blob at that ref — final, there is nothing for a fallback to find) or 'unavailable'
 * (git could not be asked — the caller may fall back to the Git extension).
 */
export type RawBlob = { bytes: Uint8Array } | 'missing' | 'unavailable';
export type RawBlobReader = (repoRoot: string, ref: string, relativePath: string) => Promise<RawBlob>;

/**
 * Reads blobs with `git cat-file --batch`, which never applies a textconv driver. VS Code's
 * Repository.buffer() runs `git show --textconv`, so with `*.png diff=<driver>` configured
 * it returned the driver's text output instead of the image: classified as text, copied
 * under the file's name, and written over the real file on restore. `ref` '' is the index
 * (`:<path>`), as in buffer().
 */
export function makeRawBlobReader(gitPath: string, gitEnv?: Record<string, string>): RawBlobReader {
  return (repoRoot, ref, relativePath) => new Promise<RawBlob>(resolve => {
    // cat-file --batch is newline-delimited: such a path cannot be asked for.
    if (/[\r\n]/.test(relativePath)) { resolve('unavailable'); return; }
    let settled = false;
    const done = (value: RawBlob) => { if (!settled) { settled = true; resolve(value); } };
    try {
      const env = { ...process.env, ...gitEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
      const child = spawn(gitPath, ['-C', repoRoot, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'ignore'], env });
      const chunks: Buffer[] = [];
      child.on('error', () => done('unavailable'));
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stdout.on('error', () => done('unavailable'));
      child.on('close', code => done(code === 0 ? parseSingleBatch(Buffer.concat(chunks)) : 'unavailable'));
      child.stdin.on('error', () => {}); // ignore EPIPE if git exits early
      child.stdin.end(formatBatchRequest(ref, [relativePath]));
    } catch {
      done('unavailable');
    }
  });
}

/** One `git cat-file --batch` response: `<oid> <type> <size>\n<bytes>\n` or `<input> missing\n`. */
function parseSingleBatch(stdout: Buffer): RawBlob {
  const lineEnd = stdout.indexOf(0x0a);
  if (lineEnd === -1) return 'unavailable';
  const line = stdout.toString('utf8', 0, lineEnd);
  // `<input> missing` / `<input> ambiguous` echo the path, which may hold spaces.
  if (line.endsWith(' missing') || line.endsWith(' ambiguous')) return 'missing';
  const header = line.split(' ');
  // A tree or commit at that path: no blob there.
  if (header.length !== 3 || header[1] !== 'blob') return 'missing';
  const size = Number(header[2]);
  const start = lineEnd + 1;
  if (!Number.isInteger(size) || size < 0 || start + size > stdout.length) return 'unavailable';
  return { bytes: new Uint8Array(stdout.subarray(start, start + size)) };
}

/**
 * [repo] with [reader] as its raw-bytes source (readRefClassified asks it first). A new
 * object, not the Git extension's Repository: its methods are bound, not copied.
 */
export function withRawBlobs(repo: ContentRepo, reader: RawBlobReader): ContentRepo {
  return {
    rootUri: repo.rootUri,
    show: repo.show?.bind(repo),
    buffer: repo.buffer?.bind(repo),
    readRaw: (ref, relativePath) => reader(repo.rootUri.fsPath, ref, relativePath)
  };
}
