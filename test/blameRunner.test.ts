import assert from 'node:assert/strict';
import test from 'node:test';
import { runBlame, type SpawnBlame } from '../src/blame/blameRunner.js';

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
