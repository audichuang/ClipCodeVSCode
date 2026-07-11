// Runs `git blame --porcelain --contents - <file>` feeding the (possibly
// unsaved) editor buffer via stdin so line numbers align with what the user
// sees. The spawn is injected so the orchestration is unit-testable.
import { spawn } from 'node:child_process';
import { parseBlamePorcelain, type BlameLine } from './blameParser.js';

export type SpawnBlame = (
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string
) => Promise<string>;

export interface RunBlameOptions {
  gitPath: string;
  repoRoot: string;
  relPath: string;
  contents: string;
  spawnBlame: SpawnBlame;
}

export async function runBlame(opts: RunBlameOptions): Promise<BlameLine[]> {
  const args = ['-C', opts.repoRoot, 'blame', '--porcelain', '--contents', '-', '--', opts.relPath];
  const stdout = await opts.spawnBlame(opts.gitPath, args, opts.repoRoot, opts.contents);
  return parseBlamePorcelain(stdout);
}

export function defaultSpawnBlame(
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('git blame timed out'));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`git blame exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}
