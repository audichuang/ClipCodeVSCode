// Runs `git blame --porcelain --contents - <file>` feeding the (possibly
// unsaved) editor buffer via stdin so line numbers align with what the user
// sees. The spawn is injected so the orchestration is unit-testable.
import { spawn } from 'node:child_process';
import { parseBlamePorcelain, type BlameLine } from './blameParser.js';

export type SpawnBlame = (
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string,
  signal?: AbortSignal
) => Promise<string>;

export interface RunBlameOptions {
  gitPath: string;
  repoRoot: string;
  relPath: string;
  contents: string;
  spawnBlame: SpawnBlame;
  signal?: AbortSignal;
}

export async function runBlame(opts: RunBlameOptions): Promise<BlameLine[]> {
  const args = ['-C', opts.repoRoot, 'blame', '--porcelain', '--contents', '-', '--', opts.relPath];
  const stdout = await opts.spawnBlame(opts.gitPath, args, opts.repoRoot, opts.contents, opts.signal);
  return parseBlamePorcelain(stdout);
}

export function defaultSpawnBlame(
  gitPath: string,
  args: string[],
  cwd: string,
  stdin: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitPath, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(out);
    };
    const onAbort = () => {
      child.kill();
      finish(new Error('git blame cancelled'));
    };
    timer = setTimeout(() => {
      child.kill();
      finish(new Error('git blame timed out'));
    }, 10_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => { finish(err); });
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`git blame exited ${code}`));
    });
    child.stdin.on('error', () => {}); // ignore EPIPE if git exits before reading stdin
    child.stdin.end(stdin);
  });
}
