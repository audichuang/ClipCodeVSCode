import { spawn } from 'node:child_process';

export interface DiffFile { path: string; status: string; oldPath?: string }
export interface RemoteStatus {
  ahead: number; behind: number; upstream?: string;
  fetched: boolean; fetchAttempted: boolean;
}

// Parse `git diff --name-status <base> HEAD` stdout. Status letter is the
// first char (rename lines carry a numeric similarity suffix, e.g. R100).
// Rename/copy lines have two paths: old then new; path = new, oldPath = old.
export function parseNameStatus(stdout: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    if (parts.length >= 3) {
      files.push({ path: parts[2], status, oldPath: parts[1] });
    } else {
      files.push({ path: parts[1], status });
    }
  }
  return files;
}

// Parse `git rev-list --count --left-right @{u}...HEAD` stdout: "<behind>\t<ahead>".
export function parseAheadBehind(revListLine: string): { ahead: number; behind: number } | null {
  const parts = revListLine.trim().split('\t');
  if (parts.length !== 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return null;
  return { ahead, behind };
}

// Spawn `gitPath` with args in `repoRoot`, collect stdout. Resolves stdout on
// clean exit; resolves `undefined` on spawn error or non-zero exit (safe
// default is the caller's job — this just signals failure).
function runGit(gitPath: string, repoRoot: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const done = (v: string | undefined) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
      const child = spawn(gitPath, ['-C', repoRoot, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env });
      const chunks: Buffer[] = [];
      child.on('error', () => done(undefined));
      child.stdout.on('data', (d: Buffer) => chunks.push(d));
      child.stdout.on('error', () => done(undefined));
      child.on('close', code => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
    } catch {
      done(undefined);
    }
  });
}

export async function diffNameStatus(gitPath: string, repoRoot: string, baseRef: string): Promise<DiffFile[]> {
  const out = await runGit(gitPath, repoRoot, ['diff', '--name-status', baseRef, 'HEAD']);
  return out === undefined ? [] : parseNameStatus(out);
}

export async function remoteStatus(gitPath: string, repoRoot: string, doFetch: boolean): Promise<RemoteStatus> {
  let fetched = false;
  if (doFetch) {
    const fetchOut = await runGit(gitPath, repoRoot, ['fetch', '--no-tags']);
    fetched = fetchOut !== undefined;
  }
  const fetchAttempted = doFetch;

  const upstreamOut = await runGit(gitPath, repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = upstreamOut?.trim() || undefined;
  if (!upstream) {
    return { ahead: 0, behind: 0, upstream: undefined, fetched, fetchAttempted };
  }

  const revListOut = await runGit(gitPath, repoRoot, ['rev-list', '--count', '--left-right', '@{u}...HEAD']);
  const parsed = revListOut === undefined ? null : parseAheadBehind(revListOut);
  if (!parsed) {
    return { ahead: 0, behind: 0, upstream, fetched, fetchAttempted };
  }
  return { ahead: parsed.ahead, behind: parsed.behind, upstream, fetched, fetchAttempted };
}

export async function candidateBaseRefs(gitPath: string, repoRoot: string): Promise<string[]> {
  const out = await runGit(gitPath, repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  if (out === undefined) return [];
  const refs = out.split('\n').map(l => l.trim())
    .filter(l => l.startsWith('origin/') && l !== 'origin/HEAD');

  const upstreamOut = await runGit(gitPath, repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstream = upstreamOut?.trim() || undefined;

  const ordered = upstream ? [upstream, ...refs.filter(r => r !== upstream)] : refs;
  return Array.from(new Set(ordered));
}
