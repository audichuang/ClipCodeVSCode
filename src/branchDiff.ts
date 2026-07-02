import { spawn } from 'node:child_process';

export interface DiffFile { path: string; status: string; oldPath?: string }
export interface RemoteStatus {
  ahead: number; behind: number; upstream?: string;
  fetched: boolean; fetchAttempted: boolean;
}

// Parse `git diff -z --name-status <base>...HEAD` stdout: NUL-delimited
// fields, no quoting (paired with core.quotePath=false), so non-ASCII/tab/
// newline paths survive intact. A normal entry is `<status>\0<path>\0`; a
// rename/copy entry (status starts with R/C, carries a similarity suffix
// like R100) is `<status>\0<oldpath>\0<newpath>\0`. Status letter is the
// first char; rename/copy: path = new, oldPath = old.
export function parseNameStatus(stdout: string): DiffFile[] {
  const fields = stdout.split('\0');
  const files: DiffFile[] = [];
  let i = 0;
  while (i < fields.length) {
    const statusToken = fields[i++];
    if (!statusToken) continue; // trailing empty field from the final \0
    const status = statusToken[0];
    if (status === 'R' || status === 'C') {
      const oldPath = fields[i++];
      const path = fields[i++];
      files.push({ path, status, oldPath });
    } else {
      const path = fields[i++];
      files.push({ path, status });
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
  // Three dots = diff against merge-base(baseRef, HEAD), i.e. "what this PR
  // changed" — base moving forward after the branch forked no longer shows
  // up as bogus reverse edits/deletions. -M forces rename detection.
  const out = await runGit(gitPath, repoRoot,
    ['-c', 'core.quotePath=false', 'diff', '-M', '-z', '--name-status', `${baseRef}...HEAD`]);
  return out === undefined ? [] : parseNameStatus(out);
}

// Remote a ref belongs to, e.g. 'origin/main' -> 'origin'. undefined when
// baseRef has no remote prefix (local branch, or a bare ref like 'HEAD').
function remoteFromBaseRef(baseRef: string): string | undefined {
  const slash = baseRef.indexOf('/');
  return slash > 0 ? baseRef.slice(0, slash) : undefined;
}

export async function remoteStatus(
  gitPath: string, repoRoot: string, doFetch: boolean, baseRef: string
): Promise<RemoteStatus> {
  let fetched = false;
  if (doFetch) {
    // Fetch the remote baseRef actually belongs to, so the three-dot diff
    // and the ahead/behind count below read a freshly-updated ref. Fall
    // back to fetching everything if we can't tell which remote that is.
    const remote = remoteFromBaseRef(baseRef);
    const fetchOut = await runGit(gitPath, repoRoot,
      remote ? ['fetch', '--no-tags', remote] : ['fetch', '--no-tags', '--all']);
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
