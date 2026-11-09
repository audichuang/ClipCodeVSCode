import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readRefClassified, readRefContent, type ContentRepo } from '../src/gitContent.js';
import { makeRawBlobReader, withRawBlobs } from '../src/gitRawBlob.js';

// VS Code's Repository.buffer() runs `git show --textconv <ref>:<path>`, so with a textconv
// driver configured it hands back the driver's TEXT OUTPUT, not the blob. Classified as text,
// that output went on the clipboard under the file's name and restore wrote it over the image.

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR')
]);

function git(root: string, ...args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  });
}

/** What VS Code's buffer() does: `git show --textconv`; '' is the index. */
function vscodeLikeRepo(root: string): ContentRepo {
  return {
    rootUri: { fsPath: root },
    buffer: async (ref, filePath) =>
      new Uint8Array(git(root, 'show', '--textconv', `${ref}:${path.relative(root, filePath).split(path.sep).join('/')}`))
  };
}

async function withTextconvRepo(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'clipcode-textconv-')));
  try {
    git(root, 'init', '-q');
    const script = path.join(root, '.textconv.sh');
    await writeFile(script, '#!/bin/sh\necho "TEXTCONV OUTPUT"\n');
    await chmod(script, 0o755);
    git(root, 'config', 'diff.fake.textconv', script);
    await writeFile(path.join(root, '.gitattributes'), '*.png diff=fake\n');
    await writeFile(path.join(root, 'a.png'), PNG);
    await writeFile(path.join(root, 'notes.png'), 'plain text in a png\n');
    git(root, 'add', '.gitattributes', 'a.png', 'notes.png');
    git(root, 'commit', '-q', '-m', 'init');
    // Sanity: the textconv driver really is in effect for the buffer-like path.
    assert.equal(git(root, 'show', '--textconv', 'HEAD:a.png').toString(), 'TEXTCONV OUTPUT\n');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('committed and staged blobs are read raw, never through textconv', async () => {
  await withTextconvRepo(async root => {
    const repo = withRawBlobs(vscodeLikeRepo(root), makeRawBlobReader('git'));
    for (const ref of ['HEAD', '']) {
      const read = await readRefClassified(repo, ref, path.join(root, 'a.png'));
      assert.ok(read && 'nonText' in read, `${ref || 'index'}: ${JSON.stringify(read)}`);
      assert.deepEqual(Buffer.from(read.nonText), PNG);
      // A text blob under the same driver is its own text, not the driver's output.
      assert.equal(await readRefContent(repo, ref, path.join(root, 'notes.png')), 'plain text in a png\n');
    }
  });
});

test('a path missing at the ref is undefined without falling back to buffer()', async () => {
  await withTextconvRepo(async root => {
    let bufferCalls = 0;
    const repo = withRawBlobs({ ...vscodeLikeRepo(root), buffer: async () => { bufferCalls++; return new Uint8Array(PNG); } },
      makeRawBlobReader('git'));
    assert.equal(await readRefClassified(repo, 'HEAD', path.join(root, 'nope.png')), undefined);
    assert.equal(bufferCalls, 0);
  });
});

test('a git that cannot be spawned falls back to buffer()', async () => {
  await withTextconvRepo(async root => {
    const repo = withRawBlobs({ rootUri: { fsPath: root }, buffer: async () => new Uint8Array(PNG) },
      makeRawBlobReader(path.join(root, 'no-such-git')));
    const read = await readRefClassified(repo, 'HEAD', path.join(root, 'a.png'));
    assert.ok(read && 'nonText' in read);
  });
});
