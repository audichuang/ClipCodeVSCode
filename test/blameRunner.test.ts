import assert from 'node:assert/strict';
import test from 'node:test';
import { blameRevisionFor, runBlame, type SpawnBlame } from '../src/blame/blameRunner.js';

const porcelain = [
  'a3f19c0000000000000000000000000000000000 1 1 1',
  'author Wang',
  'author-time 1700000000',
  'summary fix',
  'filename f.ts',
  '\tconst x = 1;',
  ''
].join('\n');

test('runBlame passes --contents - with stdin and parses output', async () => {
  let seenArgs: string[] = [];
  let seenStdin = '';
  const spawnBlame: SpawnBlame = async (_git, args, _cwd, stdin) => {
    seenArgs = args;
    seenStdin = stdin;
    return porcelain;
  };
  const lines = await runBlame({
    gitPath: '/usr/bin/git',
    repoRoot: '/repo',
    relPath: 'f.ts',
    contents: 'const x = 1;\n',
    spawnBlame
  });
  assert.ok(seenArgs.includes('--porcelain'));
  assert.ok(seenArgs.includes('--contents'));
  assert.ok(seenArgs.includes('-')); // read buffer from stdin
  assert.ok(seenArgs.includes('f.ts'));
  assert.equal(seenStdin, 'const x = 1;\n');
  assert.equal(lines[0].commit.author, 'Wang');
});

test('runBlame with a revision blames that commit\'s history, not HEAD against stdin', async () => {
  let seenArgs: string[] = [];
  const spawnBlame: SpawnBlame = async (_git, args) => { seenArgs = args; return porcelain; };
  await runBlame({ gitPath: 'git', repoRoot: '/repo', relPath: 'f.ts', contents: 'old text', rev: 'abc123', spawnBlame });
  assert.deepEqual(seenArgs, ['-C', '/repo', 'blame', '--porcelain', 'abc123', '--', 'f.ts']);
});

test('blameRevisionFor reads the ref of a git: document (a diff\'s left side), not file: or index views', () => {
  const git = (query: string) => ({ scheme: 'git', query });
  assert.equal(blameRevisionFor({ scheme: 'file', query: '' }), undefined);
  assert.equal(blameRevisionFor(git(JSON.stringify({ path: '/repo/f.ts', ref: 'abc123' }))), 'abc123');
  assert.equal(blameRevisionFor(git(JSON.stringify({ path: '/repo/f.ts', ref: 'HEAD~1' }))), 'HEAD~1');
  // Index / working views and anything that could read as an option keep the buffer mode.
  assert.equal(blameRevisionFor(git(JSON.stringify({ path: '/repo/f.ts', ref: '' }))), undefined);
  assert.equal(blameRevisionFor(git(JSON.stringify({ path: '/repo/f.ts', ref: '~' }))), undefined);
  assert.equal(blameRevisionFor(git(JSON.stringify({ path: '/repo/f.ts', ref: '--output=x' }))), undefined);
  assert.equal(blameRevisionFor(git('not json')), undefined);
});
