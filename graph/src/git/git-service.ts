import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
/* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
import { createHash, randomUUID } from 'crypto';
/* SNIPCODE-HOOK end */
import { bufferStream, BufferOverflowError } from '../utils/buffer-stream';
import { getGitBinaryPath } from './git-binary';
import { resolveGitDirs } from '../services/file-watcher-helpers';

/** Default max bytes per stdout/stderr stream for a single git invocation.
 *  Picked to comfortably hold large log/diff output (e.g. `git log --all`
 *  over a 100k-commit repo with --format flags is ~tens of MB) while still
 *  preventing a pathological --no-pager binary blob from eating the whole
 *  extension host. Callers can override per-invocation via `maxBufferBytes`. */
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
import { parseLog, parseBranches, parseTags, parseRemotes, parseStashList, parseDiff, parseWorktreeList, parseLfsFiles, parseLfsLocks, mapSignatureStatus } from './git-parser';
import { buildReversePatch, buildForwardPatch, buildForwardPatchLines } from './patch-builder';
import type { Commit, BranchInfo, TagInfo, RemoteInfo, StashEntry, LogOptions, DiffData, WorktreeInfo, CommitSignature } from './types';

export class GitError extends Error {
  constructor(
    public stderr: string,
    public exitCode: number | null,
    public args: string[],
    public stdout: string = '',
    /* SNIPCODE-HOOK start: retain raw diff bytes on expected non-zero exits */
    public stdoutBuffer: Buffer = Buffer.alloc(0),
    /* SNIPCODE-HOOK end */
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/* SNIPCODE-HOOK start: stale fingerprint recovery */
/** The rendered diff no longer matches the working tree / index. Recoverable:
 *  the UI should re-fetch and re-render rather than just show the failure. */
export class StaleDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleDiffError';
  }
}
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: byte-preserving patch transport */
interface ExecOptions {
  stdin?: string | Buffer;
  timeout?: number;
  silent?: boolean;
  maxBufferBytes?: number;
  encoding?: 'buffer';
}
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: Batch B rename staging paths */
type ChangePath = string | { path: string; oldPath?: string };
type StatusChange = { path: string; status: string; oldPath?: string };
/* SNIPCODE-HOOK end */

/**
 * Per-hunk staging emits the file's whole diff header (everything before the
 * first `@@`) verbatim, so a recorded chmod / rename / copy would be applied
 * alongside a selected content hunk the user never opted into. Refuse per-hunk
 * staging for those files — whole-file stage/unstage in the tree still works.
 * A new/deleted whole file (its `/dev/null` header) is fine: its single hunk IS
 * the whole file. `old mode`/`new mode` mark an in-place mode change.
 */
function assertHunkStageable(rawFileDiff: string, file: string): void {
  if (/^(old mode |new mode |rename from |rename to |copy from |copy to )/m.test(rawFileDiff)) {
    throw new Error(`per-hunk staging not supported for ${file} (file mode or rename change); stage the whole file instead`);
  }
}

/**
 * Bin an ISO-8601 timestamp (`%aI` from `git log`) by the *author's* local
 * weekday and hour, not the host's. `new Date(iso).getDay()/getHours()` would
 * convert into the machine's timezone — a 10am Seoul commit would land in
 * "evening" for someone running the extension in San Francisco. The ISO string
 * already encodes the wall-clock time and offset, so the easy fix is to parse
 * the date components directly.
 */
export function binCommitTime(iso: string): { weekday: number; hour: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, day, h] = m;
  const year = parseInt(y, 10);
  const month = parseInt(mo, 10);
  const date = parseInt(day, 10);
  const hour = parseInt(h, 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(date) || Number.isNaN(hour)) return null;
  // Day-of-week is independent of timezone if we treat the components as UTC,
  // because the same calendar date (Y/M/D in the author's zone) always has the
  // same day-of-week regardless of the offset.
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  return { weekday, hour };
}

export class GitService {
  private activityLog: Array<{ command: string; timestamp: string; success: boolean; duration: number }> = [];
  private cachedRemoteNames: string[] | null = null;
  private remoteNamesCacheTime = 0;
  private pendingRemoteNames: Promise<string[]> | null = null;
  private extraEnv: Record<string, string> = {};
  // Default per-command timeout (ms). Callers can override per call via the
  // `timeout` option; this is the fallback used when they don't. Configurable
  // via the `gitGraphPlus.timeout` setting so large repos can extend it.
  private defaultTimeoutMs = 60000;
  private warningHandler: ((message: string) => void) | null = null;
  private authRetryHandler: ((remote?: string) => Promise<boolean>) | null = null;
  // In-flight read-only operations, keyed by op name. Lets two callers (e.g.
  // a tree-view sidebar refresh and the webview panel refresh kicked off in
  // the same tick during repo switch) collapse onto a single git subprocess.
  private inflight = new Map<string, Promise<unknown>>();
  private readCache = new Map<string, { expires: number; value: unknown }>();
  // Bumped on every invalidation. A read that started before a mutation must
  // not write its (pre-mutation) result into the cache after the mutation
  // cleared it, and a caller arriving after the mutation must not dedupe onto
  // that stale in-flight read — both are keyed to the generation they saw.
  private readCacheGeneration = 0;
  private static readonly READ_CACHE_TTL_MS = 1500;

  // Serializes worktree/index-mutating commands: handleMessage handlers run
  // concurrently, so two panel actions could otherwise race on .git/index.lock
  // (loser dies with "another git process seems to be running"). Network-only
  // fetch/push stay unlocked so a slow auto-fetch never queues a user action.
  // ponytail: per-command lock; a multi-command handler sequence can still
  // interleave with another — git's own locking makes that fail loudly rather
  // than corrupt. Upgrade to per-handler locking if it ever bites.
  private mutationChain: Promise<unknown> = Promise.resolve();

  private withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }

  private cachedRead<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.readCache.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);
    const generation = this.readCacheGeneration;
    return this.dedupe(`${key}@${generation}`, async () => {
      const value = await fn();
      if (generation === this.readCacheGeneration) {
        this.readCache.set(key, { value, expires: Date.now() + GitService.READ_CACHE_TTL_MS });
      }
      return value;
    });
  }

  /** Public so watcher-triggered refreshes can drop entries cached before an
   *  external change (git run in a terminal never passes through exec()). */
  clearReadCache(): void {
    this.readCache.clear();
    this.readCacheGeneration++;
    // Keep the older 30s remote-name cache consistent with the same external
    // change (e.g. `git remote add` in a terminal): stale remote names make
    // log()'s %D parsing misclassify new remotes' branches as local.
    this.cachedRemoteNames = null;
  }

  private invalidatesReadCache(args: string[]): boolean {
    const [cmd, sub] = args;
    switch (cmd) {
      case 'add':
      case 'apply':
      case 'bisect':
      case 'checkout':
      case 'cherry-pick':
      case 'clean':
      case 'commit':
      case 'fetch':
      case 'flow':
      case 'merge':
      case 'pull':
      case 'push':
      case 'rebase':
      case 'reset':
      case 'revert':
      case 'restore':
      case 'rm':
      case 'switch':
      case 'am':
        return true;
      case 'config':
        // Writes (flowInit) must invalidate; reads (--get/--list) must not.
        return !args.some(a => a === '--get' || a === '--list' || a === '-l');
      case 'branch':
        // Read-only forms carry --list or --format=<fmt> (a single token, so
        // exact includes('--format') would never match — compare by prefix).
        return !args.some(a => a === '--list' || a.startsWith('--format'));
      case 'remote':
        return !(args.length === 1 || sub === '-v' || sub === 'get-url');
      case 'stash':
        return sub !== 'list' && sub !== 'show';
      case 'tag':
        return !(sub === '-l' || sub === '--list');
      case 'worktree':
        return sub !== 'list';
      default:
        return false;
    }
  }

  constructor(private repoPath: string) {}

  private parseStatusPorcelainZ(raw: string): Array<{ x: string; y: string; path: string; oldPath?: string }> {
    if (raw && !raw.includes('\0')) {
      return raw.split('\n').filter(Boolean).map(line => {
        const x = line[0] ?? ' ';
        const y = line[1] ?? ' ';
        let path = line.slice(3);
        /* SNIPCODE-HOOK start: Batch B retain rename source path */
        let oldPath: string | undefined;
        if (path.includes(' -> ')) {
          const parts = path.split(' -> ');
          oldPath = parts[0].trim();
          path = parts[parts.length - 1];
        }
        path = path.trim();
        return { x, y, path, ...(oldPath ? { oldPath } : {}) };
        /* SNIPCODE-HOOK end */
      });
    }
    const fields = raw.split('\0');
    const entries: Array<{ x: string; y: string; path: string; oldPath?: string }> = [];
    let i = 0;
    while (i < fields.length) {
      const head = fields[i++];
      if (!head) continue;
      const x = head[0] ?? ' ';
      const y = head[1] ?? ' ';
      const path = head.slice(3);
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        entries.push({ x, y, path, oldPath: fields[i++] ?? '' });
      } else {
        entries.push({ x, y, path });
      }
    }
    return entries;
  }

  /**
   * Override the default per-command timeout (in milliseconds). Non-positive
   * or non-finite values are ignored, keeping the built-in fallback. Wired to
   * the `gitGraphPlus.timeout` setting so users with large repos can extend it.
   */
  setDefaultTimeout(ms: number): void {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      this.defaultTimeoutMs = ms;
    }
  }

  /** Register a callback for non-fatal warnings (e.g., auxiliary git command failures). */
  setWarningHandler(handler: ((message: string) => void) | null): void {
    this.warningHandler = handler;
  }

  /**
   * Register a callback invoked when a remote git command (fetch/pull/push)
   * fails for authentication reasons. The handler is expected to surface
   * VS Code's credential prompt (e.g., by routing through the built-in
   * `vscode.git` extension). Returning `true` means "auth flow ran; please
   * retry"; `false` means "no retry possible".
   */
  setAuthRetryHandler(handler: ((remote?: string) => Promise<boolean>) | null): void {
    this.authRetryHandler = handler;
  }

  private warn(message: string): void {
    console.warn(`Git Graph+: ${message}`);
    try { this.warningHandler?.(message); } catch { /* never let a handler break a git call */ }
  }

  /**
   * Heuristic match against stderr fragments git emits when credentials are
   * missing or wrong. SSH-key failures (`Permission denied (publickey)`) are
   * intentionally excluded — VS Code's askpass can't resolve those, so a
   * retry would just fail again.
   */
  private isAuthError(err: unknown): boolean {
    if (!(err instanceof GitError)) return false;
    const text = `${err.stderr ?? ''}\n${err.message ?? ''}`.toLowerCase();
    return (
      text.includes('authentication failed') ||
      text.includes('could not read username') ||
      text.includes('could not read password') ||
      text.includes('terminal prompts disabled') ||
      text.includes('invalid username or password') ||
      text.includes('authentication required') ||
      text.includes('http basic: access denied')
    );
  }

  /**
   * Runs a git command; on an authentication failure, asks the registered
   * auth retry handler to drive VS Code's credential prompt (same flow the
   * SCM panel uses), then retries the command once.
   */
  // Network operations (fetch/pull/push) run on a much longer timeout than the
  // local-command default: a first clone-sized fetch or a slow link routinely
  // exceeds 60s, and killing it with SIGTERM mid-transfer is worse than waiting.
  private static readonly NETWORK_TIMEOUT_MS = 600_000; // 10 minutes

  private async execWithAuthRetry(args: string[], remote?: string): Promise<string> {
    // Honour a user-raised default if it's larger, but never go below the
    // network floor.
    const timeout = Math.max(this.defaultTimeoutMs, GitService.NETWORK_TIMEOUT_MS);
    try {
      return await this.exec(args, { timeout });
    } catch (err) {
      if (!this.isAuthError(err) || !this.authRetryHandler) throw err;
      const retried = await this.authRetryHandler(remote).catch(() => false);
      if (!retried) throw err;
      return this.exec(args, { timeout });
    }
  }

  private assertSafeRef(ref: string, context: string): void {
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new GitError(`Invalid ref for ${context}`, null, []);
    }
    if (ref.startsWith('-')) {
      throw new GitError(`Ref must not start with '-': ${ref}`, null, []);
    }
  }

  /** Reject paths that escape the repo (absolute, parent traversal) or that git
   * could misinterpret as a flag. Paired with `--` in the actual command. */
  private assertSafePath(filePath: string, context: string): void {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new GitError(`Invalid path for ${context}`, null, []);
    }
    if (filePath.startsWith('-')) {
      throw new GitError(`Path must not start with '-': ${filePath}`, null, []);
    }
    // Reject absolute paths (POSIX `/...` and Windows `C:\...` / `C:/...`) and
    // any `..` traversal so a path can't escape the repo root.
    if (filePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.split(/[\\/]/).includes('..')) {
      throw new GitError(`Unsafe path for ${context}: ${filePath}`, null, []);
    }
  }

  setExtraEnv(env: Record<string, string>): void {
    this.extraEnv = env;
  }

  get rootPath(): string { return this.repoPath; }

  // The empty tree object, keyed by the repo's hash algorithm. Used as the diff
  // base for root commits (no parent) so the diff renders the file as fully added.
  private static readonly EMPTY_TREE: Record<string, string> = {
    sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
  };

  /**
   * Resolves the base revision a single-commit diff compares against — the
   * commit's first parent — to a full SHA. Markdown-diff tooling (mddiff and
   * similar) can't parse the `<sha>~1` shorthand and so can't tell which
   * revisions a diff compares (#51); it needs a plain object name. Root commits
   * have no parent, so we return the empty tree object instead.
   */
  async resolveDiffBaseRef(commitHash: string): Promise<string> {
    this.assertSafeRef(commitHash, 'resolveDiffBaseRef');
    try {
      const parent = (await this.exec(['rev-parse', '--verify', '--quiet', `${commitHash}~1`], { silent: true })).trim();
      if (parent) return parent;
    } catch {
      // `--quiet` exits non-zero with no output when the parent doesn't exist
      // (root commit) — fall through to the empty tree.
    }
    const format = (await this.exec(['rev-parse', '--show-object-format'], { silent: true })).trim();
    return GitService.EMPTY_TREE[format] ?? GitService.EMPTY_TREE.sha1;
  }

  /**
   * The real gitdir. In a submodule or linked worktree `.git` is a file
   * pointing at it, so build gitdir paths from here, not by joining `'.git'`.
   */
  private gitDir(): string {
    return resolveGitDirs(this.repoPath).gitDir;
  }

  getActivityLog() {
    return this.activityLog;
  }

  async getReflog(limit = 200, ref = 'HEAD'): Promise<{ entries: Array<{
    hash: string;
    shortHash: string;
    selector: string;
    message: string;
    date: string;
    dangling: boolean;
  }>; hasMore: boolean }> {
    const SEP = '\x1f';
    try {
      const out = await this.exec([
        'reflog', 'show', ref,
        `--format=%H${SEP}%h${SEP}%gd${SEP}%gs`,
        `--date=iso`,
        `-n`, String(limit + 1),
      ], { silent: true });

      const refName = ref === 'HEAD' ? 'HEAD' : ref.replace(/^refs\/(heads|remotes)\//, '');
      const allLines = out.trim().split('\n').filter(Boolean);
      const hasMore = allLines.length > limit;
      const lines = hasMore ? allLines.slice(0, limit) : allLines;

      const entries = lines.map((line, i) => {
        const parts = line.split(SEP);
        // %gd with --date=iso gives "HEAD@{2026-05-02 10:00:00 +0900}" — extract the date inside {}
        const rawSelector = parts[2] ?? '';
        const dateMatch = rawSelector.match(/\{([^}]+)\}/);
        return {
          hash:      parts[0] ?? '',
          shortHash: parts[1] ?? '',
          selector:  `${refName}@{${i}}`,
          message:   parts[3] ?? '',
          date:      dateMatch ? dateMatch[1] : '',
          dangling:  false,
        };
      });

      if (entries.length > 0) {
        // Probe the exact reflog hashes with `cat-file --batch-check` instead
        // of walking the 5000 newest reachable commits. The old cap caused
        // false-positive dangling flags on any repo larger than 5000 commits.
        // cat-file emits "<hash> missing" for objects that no longer exist
        // and "<hash> <type> <size>" for ones that do, so we treat the
        // entry as dangling only when explicitly reported missing.
        const uniqueHashes = Array.from(new Set(entries.map(e => e.hash).filter(Boolean)));
        if (uniqueHashes.length > 0) {
          try {
            const out = await this.exec(['cat-file', '--batch-check'], {
              silent: true,
              stdin: uniqueHashes.join('\n') + '\n',
            });
            const missing = new Set<string>();
            for (const line of out.split('\n')) {
              const m = line.match(/^([0-9a-f]+)\s+missing\b/);
              if (m) missing.add(m[1]);
            }
            for (const entry of entries) {
              entry.dangling = missing.has(entry.hash);
            }
          } catch (err) {
            this.warn(`reflog dangling detection failed: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      return { entries, hasMore };
    } catch (err) {
      // Surface real failures so the user sees that the reflog tab didn't load
      // for a reason (bad ref, permission, missing HEAD), not just an empty list.
      this.warn(`failed to get reflog: ${err instanceof Error ? err.message : err}`);
      return { entries: [], hasMore: false };
    }
  }

  /**
   * Verify a single commit's signature on demand (for the Commit Details
   * panel). Unlike the graph-wide setting, this only verifies one commit so it
   * is cheap regardless of repo size. Failures degrade to "no signature" rather
   * than throwing, so the panel never breaks on an unverifiable commit.
   */
  async getCommitSignature(hash: string): Promise<CommitSignature> {
    this.assertSafeRef(hash, 'getCommitSignature');
    try {
      const out = await this.exec(
        ['show', '--no-patch', '--format=%G?%x00%GS%x00%GK', hash],
        { silent: true },
      );
      const [code = '', signer = '', keyId = ''] = out.split('\x00');
      const sig: CommitSignature = { status: mapSignatureStatus(code) ?? 'none' };
      const signerTrimmed = signer.trim();
      const keyIdTrimmed = keyId.trim();
      if (signerTrimmed) sig.signer = signerTrimmed;
      if (keyIdTrimmed) sig.keyId = keyIdTrimmed;
      return sig;
    } catch (err) {
      this.warn(`failed to get commit signature: ${err instanceof Error ? err.message : err}`);
      return { status: 'none' };
    }
  }

  /* SNIPCODE-HOOK start: optional raw stdout for patch reconstruction */
  private exec(args: string[], options: ExecOptions & { encoding: 'buffer' }): Promise<Buffer>;
  private exec(args: string[], options?: ExecOptions): Promise<string>;
  private exec(args: string[], options?: ExecOptions): Promise<string | Buffer> {
  /* SNIPCODE-HOOK end */
    // Mutations go through the lock; reads (and network-only fetch/push) spawn
    // freely. See withMutationLock for why.
    if (this.invalidatesReadCache(args) && args[0] !== 'fetch' && args[0] !== 'push') {
      return this.withMutationLock(() => this.execUnlocked(args, options));
    }
    return this.execUnlocked(args, options);
  }

  /* SNIPCODE-HOOK start: optional raw stdout for patch reconstruction */
  private execUnlocked(args: string[], options: ExecOptions & { encoding: 'buffer' }): Promise<Buffer>;
  private execUnlocked(args: string[], options?: ExecOptions): Promise<string>;
  private execUnlocked(args: string[], options?: ExecOptions): Promise<string | Buffer> {
  /* SNIPCODE-HOOK end */
    const startTime = Date.now();
    const command = `git ${args.join(' ')}`;
    const timeoutMs = options?.timeout ?? this.defaultTimeoutMs;
    const maxBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    // Force literal UTF-8 pathnames in every command's output. With the
    // default core.quotePath=true, git dquote-escapes non-ASCII paths (e.g.
    // "\355\225\234.txt"), which left the file list (status/name-status/
    // ls-tree) showing escaped paths while the diff view unescaped them — so
    // clicking a non-ASCII (Korean, etc.) file opened no diff. Applied as a
    // `-c` override so it's global, but kept out of the activity-log command
    // string to avoid clutter.
    const spawnArgs = ['-c', 'core.quotePath=false', ...args];

    return new Promise((resolve, reject) => {
      const proc = spawn(getGitBinaryPath(), spawnArgs, {
        cwd: this.repoPath,
        env: { ...process.env, ...this.extraEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', EDITOR: 'true' },
      });

      const recordActivity = (success: boolean) => {
        if (options?.silent) return;
        const logCommand = command.length > 500 ? command.substring(0, 500) + '…' : command;
        this.activityLog.unshift({
          command: logCommand,
          timestamp: new Date().toISOString(),
          success,
          duration: Date.now() - startTime,
        });
        if (this.activityLog.length > 200) {
          this.activityLog.length = 200;
        }
      };

      const killHard = () => {
        try { proc.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      };

      // Several exit paths can race (timeout, buffer overflow, close, spawn
      // error). Guard so only the first settles the promise and writes one
      // activity-log entry — previously a timeout logged once, then the
      // subsequent process 'close' logged the same command a second time.
      let settled = false;

      // Timeout/overflow must NOT reject immediately: rejecting releases the
      // mutation lock while the killed child may still be exiting and holding
      // .git locks — the next queued mutation would race it. Record the
      // failure, kill, and let 'close' deliver the rejection; the force timer
      // is the backstop for a child that survives even SIGKILL.
      let pendingFailure: GitError | null = null;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const failAfterExit = (err: GitError) => {
        if (settled || pendingFailure) return;
        pendingFailure = err;
        killHard();
        forceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          recordActivity(false);
          reject(err);
        }, 10_000);
      };

      const timer = setTimeout(() => {
        failAfterExit(new GitError(`Command timed out after ${timeoutMs}ms`, null, args));
      }, timeoutMs);

      /* SNIPCODE-HOOK start: git apply accepts raw patch bytes */
      if (options?.stdin !== undefined) {
        // git may close stdin before consuming everything (e.g. it rejects a
        // patch early). The resulting EPIPE surfaces as a writable-stream
        // 'error' event; without a listener Node rethrows it as an
        // uncaughtException and takes down the extension host. The process
        // exit is handled by the 'close'/'error' handlers below, so swallow it.
        proc.stdin.on('error', () => { /* EPIPE on early git exit */ });
        proc.stdin.write(options.stdin);
        proc.stdin.end();
      }
      /* SNIPCODE-HOOK end */

      // Bound stdout/stderr to prevent a pathological git invocation from
      // exhausting the extension host's memory. Overflow kills the process
      // and fails once it has exited (see failAfterExit).
      const stdoutP = bufferStream(proc.stdout, maxBytes);
      const stderrP = bufferStream(proc.stderr, maxBytes);
      const onOverflow = (label: 'stdout' | 'stderr') => (err: unknown) => {
        if (!(err instanceof BufferOverflowError)) return;
        failAfterExit(new GitError(
          `git ${args[0] ?? ''}: ${label} exceeded ${err.limitBytes} bytes`,
          null,
          args,
        ));
      };
      stdoutP.catch(onOverflow('stdout'));
      stderrP.catch(onOverflow('stderr'));

      proc.on('close', async (code) => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        // If overflow tripped, these awaits resolve to empty buffers via the
        // swallow below; the recorded pendingFailure wins.
        const [stdoutBuf, stderrBuf] = await Promise.all([
          stdoutP.catch(() => Buffer.alloc(0)),
          stderrP.catch(() => Buffer.alloc(0)),
        ]);
        // The force timer may have already settled while we awaited the
        // buffers; if so, don't log or resolve a second time.
        if (settled) return;
        settled = true;
        if (pendingFailure) {
          recordActivity(false);
          reject(pendingFailure);
          return;
        }
        const stdout = stdoutBuf.toString();
        const stderr = stderrBuf.toString();
        recordActivity(code === 0);
        if (code === 0) {
          if (this.invalidatesReadCache(args)) this.clearReadCache();
          /* SNIPCODE-HOOK start: return and retain raw patch bytes */
          resolve(options?.encoding === 'buffer' ? stdoutBuf : stdout);
        } else {
          reject(new GitError(stderr, code, args, stdout, stdoutBuf));
          /* SNIPCODE-HOOK end */
        }
      });

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceTimer);
        recordActivity(false);
        reject(pendingFailure ?? new GitError(err.message, null, args));
      });
    });
  }

  async log(options?: LogOptions): Promise<Commit[]> {
    // %G? is appended after %b only when signature verification is requested,
    // since it forces GPG verification of every commit in the log (slow on
    // large repos). %b never contains a NUL so the trailing column is unambiguous.
    const format = '%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b'
      + (options?.includeSignature ? '%x00%G?' : '');
    const args = [
      'log',
      `--format=${format}`,
    ];

    if (options?.branches && options.branches.length > 0) {
      for (const branch of options.branches) {
        this.assertSafeRef(branch, 'log');
        args.push(branch);
      }
    } else if (!options?.remoteFilter || options.remoteFilter.length === 0) {
      args.push('--glob=refs/heads', '--glob=refs/remotes', '--glob=refs/tags');
    } else {
      for (const source of options.remoteFilter) {
        if (source === 'local') {
          args.push('--glob=refs/heads');
        } else {
          args.push(`--glob=refs/remotes/${source}`);
        }
      }
      // Omit --glob=refs/tags when filtering: tags on reachable commits still appear via %D,
      // but tag-only commits outside the selected scope are correctly excluded.
    }

    args.push(
      options?.sortOrder === 'topological' ? '--topo-order' :
      options?.sortOrder === 'date' ? '--date-order' :
      '--author-date-order'
    );

    if (options?.limit) {
      args.push(`--max-count=${options.limit}`);
    }

    if (options?.skip) {
      args.push(`--skip=${options.skip}`);
    }

    if (options?.branch) {
      this.assertSafeRef(options.branch, 'log');
      args.push(options.branch);
    }

    // Kick off the uncommitted-changes probe concurrently with the log walk
    // (it's independent of the walk) so it stops adding a serial round-trip
    // after the walk on every refresh. Only the first page carries the summary
    // row, so skip it on paginated pages. The catch is attached HERE (not at the
    // await below): a later await in this function — stashList()/the log exec —
    // could throw first and leave this an unhandled rejection. On failure it
    // warns and yields null → "no summary row".
    const porcelainPromise = !options?.skip
      ? this.exec(['status', '--porcelain', '-z', '-uall']).catch((err) => {
          this.warn(`failed to check uncommitted status: ${err instanceof Error ? err.message : err}`);
          return null;
        })
      : null;

    // Resolve stashes before running the log: their base commits may need to be
    // added as extra walk start points (below). stashList() is deduped/cached,
    // so awaiting it here doesn't add a round-trip versus the old Promise.all.
    const stashes = await this.stashList();

    // Include each stash's base commit as an extra rev-list start point so git
    // walks the stash's ancestry down to where it rejoins the main history.
    // Without this, a stash whose original branch was rebased or deleted has a
    // base commit that's unreachable from any branch/tag, so it floats orphaned
    // instead of attaching to the tree (#52). Restrict this to the unfiltered
    // first page: with branch/remote filters or pagination the extra ancestry
    // would leak commits outside the requested scope.
    if (
      !options?.skip &&
      !options?.branch &&
      (!options?.branches || options.branches.length === 0) &&
      (!options?.remoteFilter || options.remoteFilter.length === 0)
    ) {
      const seen = new Set<string>();
      for (const s of stashes) {
        const base = s.parentHash;
        if (base && /^[0-9a-f]{7,64}$/i.test(base) && !seen.has(base)) {
          seen.add(base);
          args.push(base);
        }
      }
    }

    const [raw, remoteNames] = await Promise.all([
      this.exec(args),
      this.getRemoteNames(),
    ]);
    const commits = parseLog(raw, remoteNames);

    // Insert stash commits into the graph as separate rows
    if (stashes.length > 0) {
      const stashHashes = stashes.map(s => s.hash).filter(Boolean) as string[];
      if (stashHashes.length > 0) {
        try {
          const stashRaw = await this.exec([
            'log', '--no-walk',
            '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
            ...stashHashes,
          ]);
          const stashCommits = parseLog(stashRaw, remoteNames);
          const stashMap = new Map(stashes.map(s => [s.hash, s]));
          const commitHashIndex = new Map<string, number>();
          for (let i = 0; i < commits.length; i++) commitHashIndex.set(commits[i].hash, i);

          const insertions: Array<{ idx: number; commit: Commit }> = [];
          for (let i = 0; i < stashCommits.length; i++) {
            const sc = stashCommits[i];
            const stash = stashMap.get(sc.hash);
            // Keep only first parent (base commit), drop index/untracked parents
            sc.parents = sc.parents.length > 0 ? [sc.parents[0]] : [];
            // Replace refs with stash badge
            sc.refs = [{ type: 'stash' as const, name: `stash@{${stash?.index ?? i}}` }];
            // Use stash message as subject
            if (stash?.message) sc.subject = stash.message;
            // Insert the stash row directly above its base commit (the array is
            // newest-first, so splicing at the parent's index places the stash
            // just before — i.e. visually on top of — the commit it was created
            // from). Skip if the base is outside the filtered scope.
            const parentIdx = commitHashIndex.get(sc.parents[0]);
            if (parentIdx !== undefined) {
              insertions.push({ idx: parentIdx, commit: sc });
            } else if (
              !options?.skip &&
              (!options?.remoteFilter || options.remoteFilter.length === 0) &&
              (!options?.branches || options.branches.length === 0)
            ) {
              // Only pin an out-of-scope stash to the top of the very first
              // page; on paginated (skip>0) pages this would wrongly inject it
              // into the middle of the history window.
              insertions.push({ idx: -1, commit: sc });
            }
          }
          // Sort descending so earlier splices don't shift later indices
          insertions.sort((a, b) => b.idx - a.idx);
          for (const { idx, commit } of insertions) {
            if (idx < 0) commits.unshift(commit);
            else commits.splice(idx, 0, commit);
          }
        } catch (err) { this.warn(`stash log error: ${err instanceof Error ? err.message : err}`); }
      }
    }

    // The UNCOMMITTED summary row belongs only at the very top of the graph.
    // Skip it on paginated (skip>0) pages, otherwise every page would prepend
    // a duplicate row.
    // Always consume porcelainPromise when it was started (!skip) so its result
    // is awaited (and a failure surfaces as a warn) rather than becoming a
    // floating rejection on the empty-repo path; only PREPEND the summary row
    // when there are commits to sit above.
    if (!options?.skip && porcelainPromise) {
      // `-uall` (see porcelainPromise above) lists every untracked file
      // individually so the "Uncommitted changes (N)" summary row and the
      // staged/unstaged counts match what the detail panel shows file-for-file.
      // porcelain is null when the probe failed (already warned).
      const porcelain = await porcelainPromise;
      if (porcelain !== null) {
        const entries = this.parseStatusPorcelainZ(porcelain);
        if (commits.length > 0 && entries.length > 0) {
          let staged = 0, unstaged = 0;
          for (const { x, y } of entries) {
            if (x !== ' ' && x !== '?') staged++;
            if (y !== ' ' && y !== '?') unstaged++;
            if (x === '?' && y === '?') unstaged++;
          }
          const parts: string[] = [];
          if (staged > 0) parts.push(`${staged} staged`);
          if (unstaged > 0) parts.push(`${unstaged} unstaged`);
          commits.unshift({
            hash: 'UNCOMMITTED',
            abbreviatedHash: 'UNCOMMITTED',
            parents: [],
            refs: [],
            subject: `Uncommitted changes (${entries.length})`,
            body: JSON.stringify({ staged, unstaged }),
            author: { name: '', email: '', date: '' },
            committer: { name: '', email: '', date: '' },
          });
        }
      }
    }

    return commits;
  }

  private async getRemoteNames(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedRemoteNames && now - this.remoteNamesCacheTime < 30000) {
      return this.cachedRemoteNames;
    }
    // Dedupe concurrent callers: if a request is already in flight, await it
    // instead of spawning a duplicate `git remote` process.
    if (this.pendingRemoteNames) {
      return this.pendingRemoteNames;
    }
    const inflight = (async () => {
      try {
        const raw = await this.exec(['remote']);
        const names = raw.trim().split('\n').filter(Boolean);
        this.cachedRemoteNames = names;
        this.remoteNamesCacheTime = Date.now();
        return names;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.toLowerCase().includes('not a git repository')) {
          this.warn(`failed to get remote names: ${message}`);
        }
        return [];
      } finally {
        this.pendingRemoteNames = null;
      }
    })();
    this.pendingRemoteNames = inflight;
    return inflight;
  }

  /**
   * Returns raw `git log --graph` output alongside structured commit data.
   * The graph characters are parsed to determine exact column positions.
   */
  async branches(): Promise<BranchInfo[]> {
    return this.cachedRead('branches', async () => {
      const raw = await this.exec([
        'branch', '-a', '--format=%(HEAD)%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(refname)',
      ]);
      return parseBranches(raw);
    });
  }

  async tags(): Promise<TagInfo[]> {
    return this.cachedRead('tags', async () => {
      const raw = await this.exec([
        'tag', '-l', '--sort=-creatordate', '--format=%(refname:short)%00%(if)%(*objectname:short)%(then)%(*objectname:short)%(else)%(objectname:short)%(end)%00%(objecttype)%00%(contents:subject)%00%(contents:body)%01%02%03',
      ]);
      return parseTags(raw);
    });
  }

  async remotes(): Promise<RemoteInfo[]> {
    return this.cachedRead('remotes', async () => {
      const raw = await this.exec(['remote', '-v']);
      return parseRemotes(raw);
    });
  }

  async stashList(): Promise<StashEntry[]> {
    return this.cachedRead('stashList', async () => {
      try {
        const raw = await this.exec([
          'stash', 'list', '--format=%gd%x00%gs%x00%aI%x00%P%x00%H',
        ]);
        return parseStashList(raw);
      } catch (err) {
        console.warn('Git Graph+: failed to list stashes:', err instanceof Error ? err.message : err);
        return [];
      }
    });
  }

  // --- Diff ---

  async diff(options?: { file?: string; ref1?: string; ref2?: string }): Promise<DiffData[]> {
    const args = ['diff', '--no-color'];

    if (options?.ref1) {
      this.assertSafeRef(options.ref1, 'diff');
      args.push(options.ref1);
      if (options?.ref2) {
        this.assertSafeRef(options.ref2, 'diff');
        args.push(options.ref2);
      }
    }

    if (options?.file) {
      this.assertSafePath(options.file, 'diff');
      args.push('--', options.file);
    }

    const raw = await this.exec(args);
    return parseDiff(raw, options?.file);
  }

  // --- Branch Management ---

  async isDirty(): Promise<boolean> {
    const raw = await this.exec(['status', '--porcelain', '-uno']);
    return raw.trim().length > 0;
  }

  /* SNIPCODE-HOOK start: Batch B retain rename source path */
  async getUncommittedDiff(): Promise<{ staged: StatusChange[]; unstaged: StatusChange[] }> {
    const raw = await this.exec(['status', '--porcelain', '-z', '-uall']);
    const staged: StatusChange[] = [];
    const unstaged: StatusChange[] = [];
    for (const entry of this.parseStatusPorcelainZ(raw)) {
      const { x, y } = entry;
      let { path } = entry;
      // Untracked entries with a trailing slash are nested git repositories that
      // aren't registered as submodules — git refuses to descend into them, so
      // they surface as a single directory entry. Strip the slash and mark them
      // so the UI can show a meaningful label instead of an empty diff.
      const isNestedRepo = x === '?' && y === '?' && path.endsWith('/');
      if (isNestedRepo) path = path.slice(0, -1);
      if (x !== ' ' && x !== '?') staged.push({ path, status: x, ...((x === 'R' || x === 'C') && entry.oldPath ? { oldPath: entry.oldPath } : {}) });
      if (y !== ' ' && y !== '?') unstaged.push({ path, status: y, ...((y === 'R' || y === 'C') && entry.oldPath ? { oldPath: entry.oldPath } : {}) });
      if (x === '?' && y === '?') unstaged.push({ path, status: isNestedRepo ? 'N' : 'U' });
    }
    return { staged, unstaged };
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: current-branch ahead/behind vs upstream for the Changes
   *  tree's repo badges (`main ↓3 ↑1`). Read-only; ANY failure (no upstream,
   *  detached HEAD, unborn branch) → null so the tree renders without badges. */
  async aheadBehind(): Promise<{ ahead: number; behind: number } | null> {
    try {
      const raw = await this.exec(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
      const [behindStr = '0', aheadStr = '0'] = raw.trim().split('\t');
      return { behind: parseInt(behindStr, 10) || 0, ahead: parseInt(aheadStr, 10) || 0 };
    } catch {
      return null;
    }
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: full file content at a ref for the Diff tab's
   *  open-in-editor view. ref '' = index (stage 0, `git show :<path>`); anything
   *  else is `git show <ref>:<path>`. Throws when the file is absent at the ref
   *  (e.g. a new file at HEAD) — the caller renders that side empty. */
  async getFileAtRef(ref: string, filePath: string): Promise<string> {
    if (ref !== '') { this.assertSafeRef(ref, 'show'); }
    this.assertSafePath(filePath, 'show');
    return this.exec(['show', `${ref}:${filePath}`]);
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: uncommitted per-file diff for the workbench/Diff tab.
   *  A git failure THROWS so callers can surface it — swallowing it here made the
   *  Diff tab render the affirmative "No changes" empty state on e.g. index.lock
   *  contention or a broken repo. null strictly means "this side has no diff". */
  async getUncommittedFileDiff(file: string, staged: boolean): Promise<DiffData | null> {
    this.assertSafePath(file, 'diff');
    if (staged) {
      /* SNIPCODE-HOOK start: Batch B fingerprint raw bytes */
      const raw = await this.exec(['diff', '--no-color', '--cached', '--', file], { encoding: 'buffer' });
      /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
      return this.parseFingerprintDiff(raw, file);
      /* SNIPCODE-HOOK end */
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK start: Batch B surface raw diff failures */
    const isTracked = await this.isTrackedFile(file);
    /* SNIPCODE-HOOK end */
    if (!isTracked) {
      // --no-index exits with code 1 when differences found (normal); stdout has the diff
      /* SNIPCODE-HOOK start: Batch B fingerprint raw bytes */
      const raw = await this.exec(['diff', '--no-color', '--no-index', '--', '/dev/null', file], { encoding: 'buffer' })
        .catch(err => { if (err instanceof GitError && err.exitCode === 1) { return err.stdoutBuffer; } throw err; });
      /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
      return this.parseFingerprintDiff(raw, file);
      /* SNIPCODE-HOOK end */
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK start: Batch B fingerprint raw bytes */
    const raw = await this.exec(['diff', '--no-color', '--', file], { encoding: 'buffer' });
    /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
    return this.parseFingerprintDiff(raw, file);
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  private diffFingerprint(raw: string | Buffer): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private parseFingerprintDiff(raw: string | Buffer, file: string): DiffData | null {
    const diff = parseDiff(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw, file)[0] ?? null;
    if (diff) diff.fingerprint = this.diffFingerprint(raw);
    return diff;
  }

  private assertDiffFingerprint(raw: Buffer, expected: string): void {
    if (!expected) throw new Error('missing diff fingerprint; refresh before staging');
    if (this.diffFingerprint(raw) !== expected) {
      /* SNIPCODE-HOOK start: stale fingerprint recovery */
      throw new StaleDiffError('stale diff; refresh before staging');
      /* SNIPCODE-HOOK end */
    }
  }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

  private parseNameStatus(raw: string): Array<{ path: string; status: string; oldPath?: string }> {
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      // Renames/copies: `Rxxx\told\tnew` — expose the new path and old path.
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { path: parts[parts.length - 1], status, oldPath: parts[1] };
      }
      return { path: parts.slice(1).join('\t'), status };
    });
  }

  async checkout(ref: string, options?: { force?: boolean; merge?: boolean }): Promise<void> {
    this.assertSafeRef(ref, 'checkout');
    const args = ['checkout'];
    if (options?.force) { args.push('--force'); }
    if (options?.merge) { args.push('--merge'); }
    args.push(ref);
    await this.exec(args);
  }

  async clean(directories = true, force = true): Promise<void> {
    const args = ['clean'];
    if (force) { args.push('-f'); }
    if (directories) { args.push('-d'); }
    await this.exec(args);
  }

  /**
   * Check if a ref is a remote branch.
   */
  async isRemoteBranch(ref: string): Promise<boolean> {
    const slashIndex = ref.indexOf('/');
    if (slashIndex <= 0) { return false; }
    const prefix = ref.substring(0, slashIndex);
    const remoteNames = await this.getRemoteNames();
    return remoteNames.includes(prefix);
  }

  async createBranch(name: string, startPoint?: string): Promise<void> {
    this.assertSafeRef(name, 'branch');
    const args = ['branch', name];
    if (startPoint) {
      this.assertSafeRef(startPoint, 'branch');
      args.push(startPoint);
    }
    await this.exec(args);
  }

  async createAndCheckoutBranch(name: string, startPoint?: string, options?: { merge?: boolean }): Promise<void> {
    this.assertSafeRef(name, 'checkout -b');
    const args = ['checkout'];
    if (options?.merge) { args.push('--merge'); }
    args.push('-b', name);
    if (startPoint) {
      this.assertSafeRef(startPoint, 'checkout -b');
      if (await this.isRemoteBranch(startPoint)) {
        args.push('--track');
      }
      args.push(startPoint);
    }
    await this.exec(args);
  }

  async deleteBranch(name: string, force?: boolean): Promise<void> {
    this.assertSafeRef(name, 'branch -d');
    await this.exec(['branch', force ? '-D' : '-d', name]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    this.assertSafeRef(oldName, 'branch -m');
    this.assertSafeRef(newName, 'branch -m');
    await this.exec(['branch', '-m', oldName, newName]);
  }

  /* SNIPCODE-HOOK start: whole-branch copy/restore via git format-patch / am */
  /** Serialize commits on `branch` as an mbox stream — git's own transport
   *  format, so nothing custom has to be parsed on the way back: `git am`
   *  replays the series with the original message, author and author-date
   *  intact, only the hashes are new.
   *
   *  `base` is the trade-off dial. With a base the payload holds only the
   *  commits after it and carries a `base-commit:` trailer, so it is small but
   *  restorable ONLY where that commit exists — without it `am --3way` dies on
   *  "could not build fake ancestor" for any commit that edits a pre-existing
   *  file. Pass null to export from the root commit instead: self-contained
   *  and restorable into a repo that shares no history, at full-history size. */
  async exportBranchSeries(branch: string, base: string | null): Promise<{ mbox: string; base: string | null; count: number }> {
    this.assertSafeRef(branch, 'format-patch');
    if (base) this.assertSafeRef(base, 'format-patch');
    const range = base ? `${base}..${branch}` : branch;
    const count = Number((await this.exec(['rev-list', '--count', range])).trim());
    if (count === 0) return { mbox: '', base, count: 0 };
    const args = base
      ? ['format-patch', '--stdout', `--base=${base}`, range]
      : ['format-patch', '--stdout', '--root', branch];
    const mbox = await this.exec(args);
    return { mbox, base, count };
  }

  /** Best common ancestor of two refs, or null when the histories are unrelated. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    this.assertSafeRef(a, 'merge-base');
    this.assertSafeRef(b, 'merge-base');
    try {
      return (await this.exec(['merge-base', a, b], { silent: true })).trim() || null;
    } catch {
      return null; // unrelated histories exit non-zero
    }
  }

  /** Start an empty branch with no parent and nothing checked out — the landing
   *  pad for a self-contained series in a repo that shares no history with the
   *  source. Callers must confirm the working tree is clean first: this drops
   *  every tracked file from the index and the working tree (they stay
   *  reachable on the branch that was checked out). */
  async createOrphanBranch(name: string): Promise<void> {
    this.assertSafeRef(name, 'checkout --orphan');
    await this.exec(['checkout', '--orphan', name]);
    try {
      await this.exec(['rm', '-rf', '--quiet', '.']);
    } catch {
      // Nothing tracked yet (fresh repo with no commits) — already empty.
    }
  }

  /** Replay an mbox produced by exportBranchSeries onto the current HEAD.
   *  On conflict git leaves an in-progress am session behind — the caller is
   *  responsible for surfacing abortBranchSeries(). */
  async applyBranchSeries(mbox: string): Promise<void> {
    await this.exec(['am', '--3way'], { stdin: mbox });
  }

  /** Discard a half-applied series left behind by applyBranchSeries. */
  async abortBranchSeries(): Promise<void> {
    await this.exec(['am', '--abort']);
  }

  /** True when `ref` resolves to a commit that exists in this repo. */
  async hasCommit(ref: string): Promise<boolean> {
    this.assertSafeRef(ref, 'rev-parse');
    try {
      const out = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { silent: true });
      return out.trim() !== '';
    } catch {
      // --quiet exits non-zero with no output when the ref is unknown
      return false;
    }
  }

  /** True when nothing is staged or modified. `git am` refuses to start
   *  otherwise, so the paste side checks up front to give a clearer message
   *  than git's own "cannot rewind to a clean state". Untracked files are fine. */
  async isWorkingTreeClean(): Promise<boolean> {
    const out = await this.exec(['status', '--porcelain', '--untracked-files=no'], { silent: true });
    return out.trim() === '';
  }
  /* SNIPCODE-HOOK end */

  /** Tagged result so callers can distinguish "old git doesn't accept
   *  --merge-base" (one-time capability probe, permanent fallback) from
   *  "this particular call failed with a bad ref / missing object"
   *  (transient, must not poison the capability flag). */
  private async mergeTreeCheck(ours: string, theirs: string, mergeBase?: string): Promise<
    | { kind: 'ok'; value: { hasConflict: boolean; files: string[]; tree?: string } }
    | { kind: 'unknown-option' }
    | { kind: 'error' }
  > {
    const args = mergeBase
      ? ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, ours, theirs]
      : ['merge-tree', '--write-tree', ours, theirs];

    // Run through exec() rather than a hand-rolled spawn so we inherit its
    // Buffer.concat (no UTF-8 split across chunks when reading conflicted
    // non-ASCII paths), core.quotePath=false (literal paths), extraEnv (proxy/
    // SSH), and memory cap. merge-tree exits non-zero on conflict/error, which
    // exec surfaces as a GitError carrying stdout/stderr/exitCode.
    let stdout = '';
    let stderr = '';
    let code: number | null = 0;
    try {
      stdout = await this.exec(args, { silent: true, timeout: 15000 });
    } catch (err) {
      if (!(err instanceof GitError)) return { kind: 'error' };
      stdout = err.stdout;
      stderr = err.stderr;
      code = err.exitCode;
    }

    // merge-tree --write-tree output (no -z) is:
    //   <tree OID>
    //   <conflicted file info>   (one "<mode> <oid> <stage>\t<path>" per
    //                             conflicted index entry; empty when clean)
    //   <blank line>
    //   <informational messages> ("CONFLICT (...)" prose, "Auto-merging …")
    const lines = stdout.split('\n');
    const firstLine = lines[0]?.trim();
    // The first line is the merged tree OID (present on both clean and
    // conflicted merges). Callers chain it as the `ours` of the next probe
    // to simulate a sequential rebase.
    const tree = firstLine && /^[0-9a-f]{7,64}$/.test(firstLine) ? firstLine : undefined;
    if (code === 0) {
      return { kind: 'ok', value: { hasConflict: false, files: [], tree } };
    }
    if (stderr.includes('unknown option') || stderr.includes('unrecognized argument')) {
      return { kind: 'unknown-option' };
    }
    // git merge-tree exits 1 on a real conflict (with the file-info section
    // populated) and ~128 on an error like a bad ref / missing object.
    // Treating every non-zero exit as conflict produced phantom
    // "0 conflicting files" banners; gate on real conflict output.
    //
    // Read the conflicting paths from the structured file-info section
    // rather than the prose "CONFLICT (...)" lines: the prose wording
    // varies by conflict type (content / modify-delete / rename / …), so
    // scraping it mis-parsed everything except plain content conflicts
    // (e.g. a modify/delete line yielded the commit hash, not the path).
    const files: string[] = [];
    const seen = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '') break; // blank line terminates the file-info section
      const m = lines[i].match(/^[0-7]{6} [0-9a-f]+ [1-3]\t(.+)$/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); files.push(m[1]); }
    }
    const hasConflictMsg = stdout.includes('CONFLICT');
    if (code === 1 && (files.length > 0 || hasConflictMsg)) {
      // files may be empty if a conflict was signaled but left no index
      // entries (unusual) — still surface the conflict.
      return { kind: 'ok', value: { hasConflict: true, files, tree } };
    }
    // Anything else is a transient error (invalid ref, missing object, OOM).
    return { kind: 'error' };
  }

  async predictConflicts(ours: string, theirs: string, mergeBase?: string): Promise<{ hasConflict: boolean; files: string[] }> {
    this.assertSafeRef(ours, 'merge-tree');
    this.assertSafeRef(theirs, 'merge-tree');
    if (mergeBase) this.assertSafeRef(mergeBase, 'merge-tree');

    if (mergeBase && this.mergeBaseSupported !== false) {
      const result = await this.mergeTreeCheck(ours, theirs, mergeBase);
      if (result.kind === 'ok') {
        this.mergeBaseSupported = true;
        return { hasConflict: result.value.hasConflict, files: result.value.files };
      }
      if (result.kind === 'unknown-option') {
        // Old git (<2.40) — permanently fall back to the no-mergeBase form
        // for the lifetime of this service.
        this.mergeBaseSupported = false;
      }
      // For 'error' (bad ref / missing object / timeout) leave the flag
      // alone and let the no-mergeBase fallback try; one transient failure
      // must not disable per-commit isolation forever.
    }
    const fallback = await this.mergeTreeCheck(ours, theirs);
    return fallback.kind === 'ok'
      ? { hasConflict: fallback.value.hasConflict, files: fallback.value.files }
      : { hasConflict: false, files: [] };
  }

  private mergeBaseSupported: boolean | null = null;

  async predictRebaseConflicts(branch: string, onto: string): Promise<{ hasConflict: boolean; files: string[]; truncated?: boolean }> {
    this.assertSafeRef(branch, 'merge-tree');
    this.assertSafeRef(onto, 'merge-tree');

    const noPrediction = { hasConflict: false, files: [] };

    let mergeBase: string;
    try {
      mergeBase = (await this.exec(['merge-base', onto, branch], { silent: true })).trim();
    } catch {
      const r = await this.mergeTreeCheck(onto, branch);
      return r.kind === 'ok' ? r.value : noPrediction;
    }

    let commitList: string[];
    try {
      commitList = (await this.exec(['log', '--format=%H', '--reverse', `${mergeBase}..${branch}`], { silent: true }))
        .split('\n').filter(Boolean);
    } catch {
      const r = await this.mergeTreeCheck(onto, branch);
      return r.kind === 'ok' ? r.value : noPrediction;
    }

    if (commitList.length === 0) return { hasConflict: false, files: [] };

    // Cap the per-commit conflict probe at 20 to keep the preview responsive.
    // Surface `truncated` so the UI can tell the user the prediction only
    // covers the first 20 commits instead of silently under-reporting.
    const PROBE_LIMIT = 20;
    const truncated = commitList.length > PROBE_LIMIT;
    const commits = commitList.slice(0, PROBE_LIMIT);

    // Replay each commit sequentially onto an accumulating tree, mirroring how
    // a real rebase applies commits one after another. The key is *chaining*:
    // merge-tree --write-tree prints the merged tree OID, which we feed as the
    // `ours` of the next probe. That lets a commit see the files introduced by
    // earlier commits on the same branch. Probing every commit against the
    // original `onto` (the previous implementation) produced phantom conflicts
    // for the common "add a file in one commit, edit it in the next" pattern —
    // the editing commit looked like a modify/delete against an `onto` that
    // never had the file. Like a real rebase, we stop at the first conflicting
    // commit: once a step conflicts there is no resolved tree to chain from, so
    // we report that commit's files and surface the conflict.
    let ours = onto;
    for (const commit of commits) {
      if (this.mergeBaseSupported !== false) {
        const result = await this.mergeTreeCheck(ours, commit, `${commit}^`);
        if (result.kind === 'unknown-option') {
          // Old git (<2.40): no --merge-base, so the isolation/chaining form
          // is unavailable. Switch to the cumulative fallback for good.
          this.mergeBaseSupported = false;
        } else if (result.kind === 'ok') {
          this.mergeBaseSupported = true;
          if (result.value.hasConflict) {
            return { hasConflict: true, files: result.value.files, truncated };
          }
          if (result.value.tree) {
            ours = result.value.tree;
            continue;
          }
          // No tree OID to chain (unexpected on 2.40+) — fall through to the
          // cumulative probe so we don't silently skip this commit.
        }
        // 'error': fall through to the cumulative fallback for this commit only.
      }
      // Old git / fallback: cumulative merge-base..commit diff against the
      // original `onto`. We can't chain trees here (a bare tree has no history
      // for git to derive a merge base from), so this keeps the legacy, over-
      // reporting behavior — acceptable for the rare pre-2.40 git.
      const result = await this.mergeTreeCheck(onto, commit);
      if (result.kind === 'ok' && result.value.hasConflict) {
        return { hasConflict: true, files: result.value.files, truncated };
      }
    }

    return { hasConflict: false, files: [], truncated };
  }

  async merge(branch: string, options?: { noFf?: boolean; ffOnly?: boolean; squash?: boolean }): Promise<void> {
    this.assertSafeRef(branch, 'merge');
    const args = ['merge', branch];
    if (options?.noFf) {
      args.push('--no-ff');
    }
    if (options?.ffOnly) {
      args.push('--ff-only');
    }
    if (options?.squash) {
      args.push('--squash');
    }
    await this.exec(args);
    if (options?.squash) {
      await this.exec(['commit', '--no-edit']);
    }
  }

  async abortMerge(): Promise<void> {
    await this.exec(['merge', '--abort']);
  }

  /** Fast-forward a local branch to a source ref WITHOUT checking it out, via a
   *  local refspec fetch (`git fetch . <src>:<local>`). Because no `+` is used,
   *  git rejects the update when it is not a fast-forward, so diverged local
   *  commits are never clobbered. Works offline against an already-fetched
   *  remote-tracking ref and leaves the working tree / current branch untouched. */
  async fastForwardRef(localBranch: string, sourceRef: string): Promise<void> {
    this.assertSafeRef(localBranch, 'fast-forward');
    this.assertSafeRef(sourceRef, 'fast-forward');
    await this.exec(['fetch', '.', `${sourceRef}:${localBranch}`]);
  }

  async diffCommits(ref1: string, ref2: string): Promise<DiffData[]> {
    this.assertSafeRef(ref1, 'diff');
    this.assertSafeRef(ref2, 'diff');
    const raw = await this.exec(['diff', '--no-color', ref1, ref2]);
    return parseDiff(raw);
  }

  async diffFiles(ref1: string, ref2?: string): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    this.assertSafeRef(ref1, 'diff');
    if (ref2) this.assertSafeRef(ref2, 'diff');
    const args = ['diff', '-M', '-z', '--name-status'];
    args.push(ref1);
    if (ref2) args.push(ref2);
    const raw = await this.exec(args);
    return this.parseNameStatusZ(raw);
  }

  private async commitParents(hash: string): Promise<string[]> {
    try {
      const raw = await this.exec(['log', '-1', '--format=%P', hash], { silent: true });
      return raw.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async commitParentsMany(hashes: string[]): Promise<Map<string, string[]>> {
    const parentsByHash = new Map<string, string[]>();
    if (hashes.length === 0) return parentsByHash;
    try {
      const raw = await this.exec(['log', '--no-walk', '--format=%H%x00%P', ...hashes], { silent: true });
      for (const line of raw.split('\n').filter(Boolean)) {
        const [hash = '', parents = ''] = line.split('\x00');
        if (hash) parentsByHash.set(hash, parents.trim().split(/\s+/).filter(Boolean));
      }
    } catch {
      // Fall through to per-commit lookup below.
    }
    for (const hash of hashes) {
      if (!parentsByHash.has(hash)) parentsByHash.set(hash, await this.commitParents(hash));
    }
    return parentsByHash;
  }

  private mergeNameStatus(
    lists: Array<Array<{ path: string; status: string; oldPath?: string }>>,
  ): Array<{ path: string; status: string; oldPath?: string }> {
    const priority: Record<string, number> = { R: 5, C: 4, A: 3, D: 2, M: 1 };
    const merged = new Map<string, { path: string; status: string; oldPath?: string }>();
    for (const entries of lists) {
      for (const e of entries) {
        const existing = merged.get(e.path);
        if (!existing || (priority[e.status] ?? 0) > (priority[existing.status] ?? 0)) {
          merged.set(e.path, e);
        }
      }
    }
    return Array.from(merged.values());
  }

  /**
   * If `hash` is one of the repo's stashes, returns its parent hashes
   * (parent 1 = base commit, parent 2 = index snapshot, parent 3 = untracked
   * snapshot when the stash was created with --include-untracked). Returns
   * null for ordinary commits.
   *
   * A stash is internally a merge commit, so the generic merge-diff path would
   * union the diff against every parent — including the untracked snapshot,
   * which is a parentless commit holding only the untracked files. Diffing the
   * stash against that snapshot reports nearly every tracked file as "added"
   * and the untracked files as "deleted" (issue #45). Callers special-case
   * stashes so the changes view shows only what the stash actually changed.
   */
  private isStashHash(hash: string, stashes: StashEntry[]): boolean {
    return stashes.some(s =>
      s.hash && (s.hash === hash || s.hash.startsWith(hash) || hash.startsWith(s.hash)),
    );
  }

  private async stashParents(hash: string): Promise<string[] | null> {
    const stashes = await this.stashList();
    const isStash = this.isStashHash(hash, stashes);
    if (!isStash) return null;
    return this.commitParents(hash);
  }

  async showCommitFiles(hash: string): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    this.assertSafeRef(hash, 'show');

    const stashes = await this.stashList();
    const parents = await this.commitParents(hash);
    if (this.isStashHash(hash, stashes)) return this.showStashFiles(hash, parents);
    return this.showCommitFilesWithParents(hash, parents);
  }

  private async showCommitFilesWithParents(hash: string, parents: string[]): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    if (parents.length === 0) {
      // Root commit has no parent - --root compares against empty tree
      const raw = await this.exec(['diff-tree', '-M', '-z', '--no-commit-id', '--name-status', '-r', '--root', hash]);
      return this.parseNameStatusZ(raw);
    }

    if (parents.length === 1) {
      const raw = await this.exec(['diff', '-M', '-z', '--name-status', `${hash}^..${hash}`]);
      return this.parseNameStatusZ(raw);
    }

    // Merge commit: union of files changed vs each parent. Using `hash^..hash`
    // would only show changes vs the first parent, hiding everything that
    // came in from parent 2..N (silent data loss for every octopus merge).
    const perParent = await Promise.all(parents.map(async parent => {
      this.assertSafeRef(parent, 'diff');
      const raw = await this.exec(['diff', '-M', '-z', '--name-status', `${parent}..${hash}`]);
      return this.parseNameStatusZ(raw);
    }));
    return this.mergeNameStatus(perParent);
  }

  /**
   * File list for a stash: tracked changes vs the base commit (first parent),
   * plus the untracked snapshot (third parent, when present) whose files are
   * all additions. See {@link stashParents} for why the generic path is wrong.
   */
  private async showStashFiles(
    hash: string,
    parents: string[],
  ): Promise<Array<{ path: string; status: string; oldPath?: string }>> {
    const lists: Array<Array<{ path: string; status: string; oldPath?: string }>> = [];

    this.assertSafeRef(parents[0], 'diff');
    const tracked = await this.exec(['diff', '-M', '-z', '--name-status', `${parents[0]}..${hash}`]);
    lists.push(this.parseNameStatusZ(tracked));

    if (parents.length >= 3) {
      this.assertSafeRef(parents[2], 'diff');
      const untracked = await this.exec(
        ['diff-tree', '-z', '--no-commit-id', '--name-status', '-r', '--root', parents[2]],
      );
      lists.push(this.parseNameStatusZ(untracked));
    }

    return this.mergeNameStatus(lists);
  }

  async showCommitDiff(hash: string, file?: string): Promise<DiffData[]> {
    this.assertSafeRef(hash, 'show');
    if (file) this.assertSafePath(file, 'show');

    const stashParents = await this.stashParents(hash);
    if (stashParents) {
      return this.showStashDiff(hash, stashParents, file);
    }

    if (file) {
      return (await this.commitFileDiff(hash, file)).parsed;
    }

    const parents = await this.commitParents(hash);
    return this.showCommitDiffOverviewWithParents(hash, parents);
  }

  private async showCommitDiffOverviewWithParents(hash: string, parents: string[]): Promise<DiffData[]> {
    if (parents.length === 0) {
      // Root commit: diff against empty tree.
      return parseDiff(await this.exec(['show', '--no-color', '--format=', hash]));
    }
    // Single-parent commit, or merge overview (first-parent diff).
    return parseDiff(await this.exec(['diff', '--no-color', `${hash}^..${hash}`]));
  }

  /**
   * Diff for a single file in a commit, against the appropriate parent, returned
   * as both the raw unified text and its parsed form. Centralising the parent
   * selection here guarantees the displayed diff ({@link showCommitDiff}) and the
   * patch we reverse ({@link reverseCommitChanges}) can never pick different
   * parents — see the merge-commit case below.
   */
  /* SNIPCODE-HOOK start: byte-preserving commit reverse */
  private async commitFileDiff(hash: string, file: string): Promise<{ raw: Buffer; parsed: DiffData[] }> {
    this.assertSafeRef(hash, 'diff');
    this.assertSafePath(file, 'diff');
    const parents = await this.commitParents(hash);

    // Raw bytes feed `git apply --reverse` and must stay byte-identical (a lossy
    // utf8 decode rewrites invalid sequences as U+FFFD); the parsed form is
    // display-only, so decoding it as utf8 is fine. Both decodings preserve line
    // structure, so hunk/line indices agree between them.
    if (parents.length === 0) {
      // Root commit: diff against the empty tree.
      const raw = await this.exec(['show', '--no-color', '--format=', hash, '--', file], { encoding: 'buffer' });
      return { raw, parsed: parseDiff(raw.toString('utf8')) };
    }

    if (parents.length > 1) {
      // Octopus / regular merge: find the first parent whose diff for this file
      // carries real content hunks. The first-parent-only default hides changes
      // that came in from parent 2..N. We test on parsed hunks (not raw
      // non-emptiness) so a mode-only / rename-only diff from an earlier parent
      // doesn't shadow the later parent that actually holds the content.
      for (const parent of parents) {
        this.assertSafeRef(parent, 'diff');
        const raw = await this.exec(['diff', '--no-color', `${parent}..${hash}`, '--', file], { encoding: 'buffer' });
        const parsed = parseDiff(raw.toString('utf8'));
        if (parsed.length > 0 && parsed[0].hunks.length > 0) {
          return { raw, parsed };
        }
      }
      return { raw: Buffer.alloc(0), parsed: [] };
    }

    const raw = await this.exec(['diff', '--no-color', `${hash}^..${hash}`, '--', file], { encoding: 'buffer' });
    return { raw, parsed: parseDiff(raw.toString('utf8')) };
  }
  /* SNIPCODE-HOOK end */

  /**
   * Reverse-apply (undo) a commit's change to one file in the working tree.
   * With no selection, undoes the whole file's change; with a hunk index,
   * undoes that hunk; with line indices, undoes just those changed lines.
   * The result lands in the working tree (unstaged) so the user can review it.
   *
   * `hunkIndex`/`lineIndices` index the diff the way the webview rendered it
   * (see patch-builder / git-parser). Throws if there is nothing to reverse or
   * the patch doesn't apply cleanly (e.g. the working tree has diverged).
   */
  async reverseCommitChanges(
    hash: string,
    file: string,
    selection?: { hunkIndex?: number; lineIndices?: number[] },
  ): Promise<void> {
    this.assertSafeRef(hash, 'apply');
    this.assertSafePath(file, 'apply');

    const { raw } = await this.commitFileDiff(hash, file);
    /* SNIPCODE-HOOK start: byte-preserving commit reverse */
    if (!raw.toString('latin1').trim()) {
      throw new GitError(`No changes to reverse for ${file} in ${hash.substring(0, 7)}`, null, []);
    }

    // Buffer in → Buffer out: the patch reaches git's stdin byte-identical.
    const patch = selection && selection.hunkIndex !== undefined
      ? buildReversePatch(raw, selection.hunkIndex, selection.lineIndices)
      : raw;
    /* SNIPCODE-HOOK end */

    // --recount lets git fix up the line counts of our reconstructed hunks;
    // applying without --cached touches only the working tree.
    await this.exec(['apply', '--reverse', '--recount'], { stdin: patch });
  }

  /**
   * Diff for a stash: tracked changes vs the base commit (first parent), plus
   * the untracked snapshot (third parent, when present) shown as additions.
   * See {@link stashParents} for why the generic path is wrong.
   */
  private async showStashDiff(hash: string, parents: string[], file?: string): Promise<DiffData[]> {
    this.assertSafeRef(parents[0], 'diff');
    const trackedArgs = ['diff', '--no-color', `${parents[0]}..${hash}`];
    if (file) trackedArgs.push('--', file);
    const tracked = parseDiff(await this.exec(trackedArgs));

    // A requested file that lives in the tracked diff needs no untracked lookup.
    if (file && tracked.length > 0) return tracked;

    let untracked: DiffData[] = [];
    if (parents.length >= 3) {
      this.assertSafeRef(parents[2], 'diff');
      const untrackedArgs = ['show', '--no-color', '--format=', parents[2]];
      if (file) untrackedArgs.push('--', file);
      untracked = parseDiff(await this.exec(untrackedArgs));
    }

    if (file) return untracked;
    return [...tracked, ...untracked];
  }

  // 3+ multi-select: union file list + per-commit diff sections. Every union file
  // has ≥1 section (it's in the union because some selected commit changed it),
  // so no file is left without a diff. `hashes` is newest-first; sections preserve
  // that order per file.
  async multiCommitSections(hashes: string[]): Promise<{
    files: Array<{ path: string; status: string; oldPath?: string }>;
    sections: Array<{ file: string; commit: string; diff: DiffData }>;
  }> {
    if (hashes.length === 0) throw new GitError('multiCommitSections requires at least one commit', null, []);
    for (const h of hashes) this.assertSafeRef(h, 'diff');
    const [stashes, parentsByHash] = await Promise.all([
      this.stashList(),
      this.commitParentsMany(hashes),
    ]);
    const perCommit = await Promise.all(
      hashes.map(async commit => {
        const parents = parentsByHash.get(commit) ?? [];
        const isStash = this.isStashHash(commit, stashes);
        return {
          commit,
          parents,
          isStash,
          files: isStash
            ? await this.showStashFiles(commit, parents)
            : await this.showCommitFilesWithParents(commit, parents),
        };
      }),
    );
    const files = this.mergeNameStatus(perCommit.map(p => p.files));
    const sections: Array<{ file: string; commit: string; diff: DiffData }> = [];
    for (const { commit, files: cf, parents, isStash } of perCommit) {
      const allDiffs = isStash
        ? await this.showStashDiff(commit, parents)
        : await this.showCommitDiffOverviewWithParents(commit, parents);
      const byFile = new Map(allDiffs.map(d => [d.file, d]));
      for (const f of cf) {
        let d = byFile.get(f.path);
        if (!d) {
          // Merge commits: the whole-commit (first-parent) diff omits files changed
          // only vs a non-first parent. Fall back to the merge-aware per-file diff.
          const perFile = await this.showCommitDiff(commit, f.path);
          d = perFile[0];
        }
        if (d) sections.push({ file: f.path, commit, diff: d });
      }
    }
    return { files, sections };
  }

  // --- Phase 4: Remote Management, Rebase ---

  async fetch(remote?: string, options?: { prune?: boolean }): Promise<string> {
    const args = ['fetch'];
    if (remote) {
      // Same flag-smuggling guard as pushTag/deleteRemoteBranch: a remote like
      // "--upload-pack=<cmd>" would otherwise be parsed as an option by git.
      this.assertSafeRef(remote, 'fetch');
      args.push(remote);
    } else {
      args.push('--all');
    }
    if (options?.prune) {
      args.push('--prune');
    }
    args.push('--progress');
    return this.execWithAuthRetry(args, remote);
  }

  async pull(remote?: string, branch?: string, options?: { rebase?: boolean }): Promise<string> {
    const args = ['pull'];
    if (options?.rebase) {
      args.push('--rebase');
    }
    if (remote) {
      this.assertSafeRef(remote, 'pull');
      args.push(remote);
      if (branch) {
        this.assertSafeRef(branch, 'pull');
        args.push(branch);
      }
    }
    return this.execWithAuthRetry(args, remote);
  }

  async push(remote?: string, branch?: string, options?: { force?: 'with-lease' | 'force'; setUpstream?: boolean }): Promise<string> {
    const args = ['push'];
    if (options?.force === 'force') {
      args.push('--force');
    } else if (options?.force === 'with-lease') {
      args.push('--force-with-lease');
    }
    if (options?.setUpstream) {
      args.push('-u');
    }
    if (remote) {
      this.assertSafeRef(remote, 'push');
      args.push(remote);
      if (branch) {
        this.assertSafeRef(branch, 'push');
        // Use full refspec to avoid ambiguity when tag and branch names collide
        args.push(`refs/heads/${branch}`);
      }
    }
    return this.execWithAuthRetry(args, remote);
  }

  /**
   * Pushes the current branch, used by "push after rebase/merge/…" follow-up
   * actions. Mirrors the PushModal convention: when the branch has an upstream
   * we push with no remote/refspec (git resolves it from the upstream); when it
   * doesn't, we set upstream (-u) on the default remote (origin if present, else
   * the first remote). With no remotes configured the push is skipped.
   */
  async pushCurrentBranch(options?: { force?: 'with-lease' | 'force' }): Promise<{ pushed: boolean; reason?: 'no-remote' }> {
    const current = (await this.branches()).find(b => b.current);
    if (!current || current.detached) {
      throw new GitError('No current branch to push (detached HEAD)', null, []);
    }
    if (current.upstream) {
      await this.push(undefined, undefined, { force: options?.force });
      return { pushed: true };
    }
    const remote = await this.defaultPushRemote();
    if (!remote) {
      return { pushed: false, reason: 'no-remote' };
    }
    await this.push(remote, current.name, { force: options?.force, setUpstream: true });
    return { pushed: true };
  }

  /**
   * Publishes a specific branch to the default remote with -u, used by the
   * "publish to remote" follow-up when creating a branch. Works whether or not
   * the branch is currently checked out. Skipped when no remotes are configured.
   */
  async publishBranch(name: string): Promise<{ pushed: boolean; reason?: 'no-remote' }> {
    this.assertSafeRef(name, 'push -u');
    const remote = await this.defaultPushRemote();
    if (!remote) {
      return { pushed: false, reason: 'no-remote' };
    }
    await this.push(remote, name, { setUpstream: true });
    return { pushed: true };
  }

  /** Resolves the default remote to push to: 'origin' when present, else the
   *  first configured remote, or null when none are configured. */
  private async defaultPushRemote(): Promise<string | null> {
    const remotes = await this.getRemoteNames();
    if (remotes.length === 0) {
      return null;
    }
    return remotes.includes('origin') ? 'origin' : remotes[0];
  }

  async addRemote(name: string, url: string): Promise<void> {
    this.assertSafeRef(name, 'remote add');
    this.assertSafeRemoteUrl(url);
    await this.exec(['remote', 'add', name, url]);
    this.cachedRemoteNames = null;
  }

  /** Allow only well-known git transports. file:// is rejected because a
   *  malicious value could point at arbitrary local paths; users who really
   *  need it can configure it via `git remote add` directly. */
  private assertSafeRemoteUrl(url: string): void {
    if (typeof url !== 'string' || url.length === 0) {
      throw new GitError('Invalid remote URL', null, []);
    }
    if (url.startsWith('-')) {
      throw new GitError(`Remote URL must not start with '-': ${url}`, null, []);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(url)) {
      throw new GitError('Remote URL contains control characters', null, []);
    }
    // SSH shorthand: user@host:path (no scheme). Match before scheme parsing.
    const isSshShorthand = /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(url);
    if (isSshShorthand) return;
    // Scheme-based URLs.
    const m = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (!m) {
      throw new GitError(`Unsupported remote URL: ${url}`, null, []);
    }
    const allowed = new Set(['http', 'https', 'git', 'ssh', 'git+ssh', 'git+https']);
    if (!allowed.has(m[1].toLowerCase())) {
      throw new GitError(`Unsupported remote URL scheme: ${m[1]}`, null, []);
    }
  }

  async getRemoteUrl(remote: string): Promise<string> {
    this.assertSafeRef(remote, 'remote get-url');
    const raw = await this.exec(['remote', 'get-url', remote]);
    return raw.trim();
  }

  async removeRemote(name: string): Promise<void> {
    this.assertSafeRef(name, 'remote remove');
    await this.exec(['remote', 'remove', name]);
    this.cachedRemoteNames = null;
  }

  async setUpstream(localBranch: string, remote: string, remoteBranch: string, options?: { createRemote?: boolean }): Promise<void> {
    this.assertSafeRef(localBranch, 'setUpstream');
    this.assertSafeRef(remote, 'setUpstream');
    this.assertSafeRef(remoteBranch, 'setUpstream');
    if (options?.createRemote) {
      await this.execWithAuthRetry(['push', '-u', remote, `${localBranch}:${remoteBranch}`], remote);
    } else {
      await this.exec(['branch', '--set-upstream-to', `${remote}/${remoteBranch}`, localBranch]);
    }
  }

  async rebase(onto: string, options?: { autostash?: boolean }): Promise<void> {
    this.assertSafeRef(onto, 'rebase');
    const args = ['rebase'];
    if (options?.autostash) {
      args.push('--autostash');
    }
    args.push(onto);
    await this.exec(args);
  }

  async abortRebase(): Promise<void> {
    await this.exec(['rebase', '--abort']);
  }

  async continueRebase(): Promise<void> {
    await this.exec(['rebase', '--continue']);
  }

  async skipRebase(): Promise<void> {
    await this.exec(['rebase', '--skip']);
  }

  private shellEscapeForExec(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  /** Build amend command for interactive rebase exec lines.
   *  Single-line → `git commit --amend --no-edit -m 'msg'`.
   *  Multi-line → `printf '%s\n' ... | git commit --amend -F -` (POSIX, no temp files). */
  private buildAmendCommand(message: string): string {
    return buildAmendCommandStr(message, s => this.shellEscapeForExec(s));
  }

  /**
   * Interactive rebase: takes a list of todo entries and applies them.
   * Each entry: { action: 'pick'|'squash'|'fixup'|'edit'|'reword'|'drop', hash: string }
   */
  /**
   * Change a single commit's message, IntelliJ-style. HEAD is reworded with
   * `git commit --amend --only` (fast, leaves staged/working changes untouched);
   * an older commit is reworded by a one-shot interactive rebase that picks every
   * commit from its parent to HEAD and rewords just the target. `--autostash`
   * keeps a dirty working tree from blocking it. Rewriting a non-HEAD commit
   * changes its hash and every descendant's — a pushed branch then needs force-push.
   */
  async rewordCommit(hash: string, message: string): Promise<void> {
    if (!/^[0-9a-f]+$/i.test(hash)) {
      throw new GitError(`Invalid commit hash: ${hash}`, null, ['reword']);
    }
    const msg = message.trim();
    if (!msg) {
      throw new GitError('Commit message is required to reword', null, ['reword']);
    }
    const head = (await this.exec(['rev-parse', 'HEAD'])).trim();
    if (head === hash) {
      await this.amendCommit({ message: msg, only: true });
      return;
    }
    // `<hash>^` is the rebase base; it fails for the root commit (no parent).
    let base: string;
    try {
      base = (await this.exec(['rev-parse', '--verify', `${hash}^`], { silent: true })).trim();
    } catch {
      throw new GitError('Cannot reword the root commit.', null, ['reword', hash]);
    }
    const commits = await this.getRebaseCommits(base); // oldest→newest (rebase todo order)
    if (!commits.some(c => c.hash === hash)) {
      throw new GitError('That commit is not on the current branch (not reachable from HEAD).', null, ['reword', hash]);
    }
    // `rebase -i` (without --rebase-merges) flattens merge commits. Rather than
    // silently rewrite the branch's topology, refuse when a merge sits in the
    // range that would be replayed (the target or any of its descendants).
    if (commits.some(c => c.parents.length > 1)) {
      throw new GitError(
        'Cannot reword: a merge commit lies between this commit and HEAD, and rewording would flatten the merge history. Reword from the latest commit, or rebase first.',
        null,
        ['reword', hash]
      );
    }
    const todos = commits.map(c => ({
      action: c.hash === hash ? 'reword' : 'pick',
      hash: c.hash,
      subject: c.subject,
      message: c.hash === hash ? msg : undefined,
    }));
    await this.interactiveRebase(base, todos, { autostash: true });
  }

  async interactiveRebase(
    base: string,
    todos: Array<{ action: string; hash: string; subject: string; message?: string }>,
    opts?: { autostash?: boolean }
  ): Promise<void> {
    this.assertSafeRef(base, 'rebase -i');
    // Validate inputs to prevent injection
    const validActions = ['pick', 'squash', 'fixup', 'reword', 'edit', 'drop'];
    for (const todo of todos) {
      if (!validActions.includes(todo.action)) {
        throw new GitError(`Invalid rebase action: ${todo.action}`, null, ['rebase', '-i']);
      }
      if (!/^[0-9a-f]+$/i.test(todo.hash)) {
        throw new GitError(`Invalid commit hash: ${todo.hash}`, null, ['rebase', '-i']);
      }
    }

    if (todos.length > 0 && (todos[0].action === 'squash' || todos[0].action === 'fixup')) {
      throw new GitError(
        'First rebase entry cannot be squash or fixup',
        null,
        ['rebase', '-i']
      );
    }

    const isSquashLike = (a: string) => a === 'squash' || a === 'fixup';
    const lines: string[] = [];
    let i = 0;

    while (i < todos.length) {
      const todo = todos[i];

      // Squash group: a non-squash target followed by one or more squash/fixup members.
      // Checked before the standalone reword path so that "reword + squash" honors the
      // user's typed final message instead of letting git's default-editor combine messages.
      const isGroupTarget =
        !isSquashLike(todo.action) &&
        i + 1 < todos.length &&
        isSquashLike(todos[i + 1].action);

      if (isGroupTarget) {
        // reword as a group target is equivalent to pick + amend, which we already do via exec below.
        const targetAction = todo.action === 'reword' ? 'pick' : todo.action;
        lines.push(`${targetAction} ${todo.hash}`);

        const finalMessage = (todo.message ?? todo.subject).trim();
        const messageChanged = finalMessage !== todo.subject.trim();
        const userWantsReword = todo.action === 'reword';
        i++;
        while (i < todos.length && isSquashLike(todos[i].action)) {
          lines.push(`${todos[i].action} ${todos[i].hash}`);
          i++;
        }
        // Force the final message when the user changed it OR explicitly chose reword on the target.
        // Without this, fixup-only groups would silently discard the user's edited message, and
        // squash groups would inherit git's default-editor combined message.
        if (finalMessage && (messageChanged || userWantsReword)) {
          lines.push(`exec ${this.buildAmendCommand(finalMessage)}`);
        }
        continue;
      }

      // Standalone reword (no squash/fixup following).
      if (todo.action === 'reword') {
        const msg = (todo.message ?? todo.subject).trim();
        lines.push(`pick ${todo.hash}`);
        if (msg) {
          lines.push(`exec ${this.buildAmendCommand(msg)}`);
        }
        i++;
        continue;
      }
      lines.push(`${todo.action} ${todo.hash}`);
      i++;
    }

    const todoContent = lines.join('\n') + '\n';
    const gitDir = this.gitDir();
    const todoFile = join(gitDir, `ghg-rebase-todo-${randomUUID()}`);

    try {
      await this.withMutationLock(async () => {
        // A leftover rebase (host crash, never-aborted run) makes the new
        // `rebase -i` refuse at startup — and the pause check below (dir
        // exists) would then misread that hard failure as "paused now",
        // reporting success for a rebase that never started. Refuse up front.
        if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
          throw new GitError(
            'A rebase is already in progress in this repository. Continue or abort it first.',
            null,
            ['rebase', '-i', base]
          );
        }
        try {
          await writeFile(todoFile, todoContent, 'utf-8');

          // Use cp/copy to overlay the rebase-todo with our prebuilt one. The path
          // is passed via env var rather than spliced into the command string so
          // that cmd.exe / sh expansion handles repo paths containing &, |, (, ),
          // ^, etc. safely without manual escaping.
          await new Promise<void>((resolve, reject) => {
            const rebaseArgs = ['rebase', '-i', ...(opts?.autostash ? ['--autostash'] : []), base];
            const proc = spawn(getGitBinaryPath(), rebaseArgs, {
              cwd: this.repoPath,
              env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: '0',
                LC_ALL: 'C',
                GIT_MERGE_AUTOEDIT: 'no',
                GIT_EDITOR: 'true',
                EDITOR: 'true',
                GHG_TODO_FILE: todoFile,
                GIT_SEQUENCE_EDITOR: `cp -- "$GHG_TODO_FILE"`,
              },
            });

            // exec()'s hang-stopper, with the network-op floor: a big rebase
            // (many exec-amend steps) legitimately outruns the local default,
            // but a wedged one must not hold .git/index.lock forever. On
            // timeout, kill but reject only after 'close' — rejecting earlier
            // releases the mutation lock while the dying child still holds
            // repo locks (the force timer backstops an unkillable child).
            const timeoutMs = Math.max(this.defaultTimeoutMs, GitService.NETWORK_TIMEOUT_MS);
            const timeoutError = new GitError(`rebase -i timed out after ${timeoutMs}ms`, null, ['rebase', '-i', base]);
            let timedOut = false;
            let forceTimer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            const settle = (fn: () => void) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              clearTimeout(forceTimer);
              fn();
            };
            const timer = setTimeout(() => {
              timedOut = true;
              try { proc.kill('SIGTERM'); } catch { /* already dead */ }
              setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
              forceTimer = setTimeout(() => settle(() => reject(timeoutError)), 10_000);
            }, timeoutMs);

            // Drain stdout: an unread pipe stalls git once the kernel buffer
            // fills (each exec-amend step writes commit output to stdout).
            proc.stdout.resume();
            let stderr = '';
            proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
            proc.on('close', (code) => settle(() => {
              // A killed rebase leaves rebase-merge on disk — that must read
              // as the timeout failure, never as a legitimate pause.
              if (timedOut) { reject(timeoutError); return; }
              if (code === 0) { resolve(); return; }
              // git rebase -i exits non-zero when it intentionally pauses for an `edit`
              // step or a conflict. In both cases `.git/rebase-merge` (or rebase-apply)
              // remains on disk and the UI banner will guide the user to continue / abort.
              // Treat that as a successful "paused" outcome instead of throwing, which
              // would surface a redundant error dialog on top of the banner. Safe now:
              // the up-front check proved the dir did not pre-exist.
              const paused =
                existsSync(join(gitDir, 'rebase-merge')) ||
                existsSync(join(gitDir, 'rebase-apply'));
              if (paused) { resolve(); return; }
              reject(new GitError(stderr, code, ['rebase', '-i', base]));
            }));
            proc.on('error', (err) => {
              settle(() => reject(timedOut ? timeoutError : new GitError(err.message, null, ['rebase', '-i', base])));
            });
          });
        } finally {
          await unlink(todoFile).catch(() => {});
        }
      });
    } finally {
      // This path bypasses exec(), so clear the read cache ourselves — a
      // ≤TTL-old branches()/log snapshot from before the rebase must not be
      // served to the post-op refresh.
      this.clearReadCache();
    }
  }

  /* SNIPCODE-HOOK start: PR tab — commits + merge-base + ahead/behind between
     two refs (base...head, three-dot semantics; see docs/superpowers/plans/
     2026-07-02-pr-tab-in-graph.md Task G2). log()'s options don't accept a raw
     `base..head` range, so this builds its own `log`/`merge-base`/`rev-list`
     calls directly (mirrors the `${a}..${b}` pattern already used by
     getRebaseCommits/showCommitFiles above) instead of routing through log().
     Each of the three git calls degrades independently to a safe default
     (empty commits / null mergeBase / 0,0) so e.g. a base with no common
     ancestor still returns usable commits+counts instead of failing the
     whole request. */
  async commitsBetween(base: string, head: string): Promise<{
    commits: Array<{ hash: string; subject: string; author: string; date: string }>;
    mergeBase: string | null;
    ahead: number;
    behind: number;
    files: Array<{ path: string; status: string; oldPath?: string }>;
    diffs: DiffData[];
  }> {
    this.assertSafeRef(base, 'commitsBetween');
    this.assertSafeRef(head, 'commitsBetween');

    const commitsPromise = this.exec(['log', '--pretty=%H%x00%s%x00%an%x00%aI', `${base}..${head}`], { silent: true })
      .then((raw) => raw.split('\n').filter(Boolean).map(line => {
        const [hash = '', subject = '', author = '', date = ''] = line.split('\x00');
        return { hash, subject, author, date };
      }))
      .catch((err) => {
        this.warn(`commitsBetween: log failed: ${err instanceof Error ? err.message : err}`);
        return [] as Array<{ hash: string; subject: string; author: string; date: string }>;
      });

    // No common ancestor (or an unresolvable ref) — webview falls back to
    // treating `base` itself as the two-dot compare point.
    const mergeBasePromise = this.exec(['merge-base', base, head], { silent: true })
      .then((raw) => raw.trim() || null)
      .catch(() => null);

    const countsPromise = this.exec(['rev-list', '--left-right', '--count', `${base}...${head}`], { silent: true })
      .then((raw) => {
        const [behindStr = '0', aheadStr = '0'] = raw.trim().split('\t');
        return {
          behind: parseInt(behindStr, 10) || 0,
          ahead: parseInt(aheadStr, 10) || 0,
        };
      })
      .catch((err) => {
        this.warn(`commitsBetween: rev-list failed: ${err instanceof Error ? err.message : err}`);
        return { ahead: 0, behind: 0 };
      });

    const [commits, mergeBase, counts] = await Promise.all([commitsPromise, mergeBasePromise, countsPromise]);
    const { ahead, behind } = counts;

    /* SNIPCODE-HOOK start: PR tab (Important 1) — rename/encoding-correct file list.
       The generic diffFiles()/parseNameStatus() path (`git diff --name-status`,
       no `-M`, no `-z`) turns renames into delete+add pairs and corrupts any
       path containing a tab, newline, or non-ASCII byte once core.quotePath
       kicks in. `-M -z --name-status <mergeBase ?? base> HEAD` forces rename
       detection and NUL-delimited records instead — parsed by parseNameStatusZ
       below, ported from the deleted src/branchDiff.ts parseNameStatus (the
       pre-G2 SCM PR panel already solved this exact problem). Falls back to
       `base` itself when there's no merge-base, matching the mergeBase-or-base
       fallback the webview already uses for its Files diff. */
    const diffBase = mergeBase ?? base;
    const filesPromise = this.exec(['diff', '-M', '-z', '--name-status', diffBase, head], { silent: true })
      .then((raw) => this.parseNameStatusZ(raw))
      .catch((err) => {
        this.warn(`commitsBetween: diff failed: ${err instanceof Error ? err.message : err}`);
        return [] as Array<{ path: string; status: string; oldPath?: string }>;
      });

    /* SNIPCODE-HOOK start: PR tab inline diff (Task D1) — full parsed diffs
       alongside the file list above, so the webview's PR Files sub-tab can
       render each file's diff inline (FileDiffView) instead of round-tripping
       through a separate compareCommits()/getFileDiff() call per file. Same
       `mergeBase ?? base` start as the file-list diff (three-dot-consistent),
       reuses the shared parseDiff() (git-parser) that diffCommits() already
       goes through. Independent try/catch: a diff-text parse failure must not
       take down the file list this method also returns. */
    const diffsPromise = this.exec(['diff', '-M', '--no-color', diffBase, head], { silent: true })
      .then((raw) => parseDiff(raw))
      .catch((err) => {
        this.warn(`commitsBetween: diff (parsed) failed: ${err instanceof Error ? err.message : err}`);
        return [] as DiffData[];
      });
    /* SNIPCODE-HOOK end */

    const [files, diffs] = await Promise.all([filesPromise, diffsPromise]);
    return { commits, mergeBase, ahead, behind, files, diffs };
  }

  /** NUL-delimited `--name-status -z` parser: a normal record is
   *  `<status>\0<path>\0`; rename/copy (status starts with R/C, carries a
   *  similarity suffix like `R100`) is `<status>\0<oldpath>\0<newpath>\0`.
   *  Unlike the tab/newline parseNameStatus() above, this never misreads a
   *  path that itself contains a tab or newline, and pairs correctly with
   *  `-M` rename detection. Ported from the deleted src/branchDiff.ts. */
  private parseNameStatusZ(raw: string): Array<{ path: string; status: string; oldPath?: string }> {
    if (raw && !raw.includes('\0')) return this.parseNameStatus(raw);
    const fields = raw.split('\0');
    const files: Array<{ path: string; status: string; oldPath?: string }> = [];
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
  /* SNIPCODE-HOOK end */

  /**
   * Get commits between base and HEAD for interactive rebase preview.
   */
  async getRebaseCommits(base: string): Promise<Commit[]> {
    this.assertSafeRef(base, 'log');
    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--topo-order',
      '--reverse',
      `${base}..HEAD`,
    ];
    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    return parseLog(raw, remoteNames);
  }

  // --- Reset & Discard ---

  async reset(ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    this.assertSafeRef(ref, 'reset');
    await this.exec(['reset', `--${mode}`, ref]);
  }

  /**
   * Amend the last commit (HEAD). Folds whatever is currently staged into HEAD
   * (standard `git commit --amend`); unstaged changes are left untouched.
   * - keepMessage → `--no-edit` (reuse the existing message)
   * - otherwise the (required) message replaces it via `-m`
   * - resetDate → `--date=now` (author date to now)
   * - resetAuthor → `--reset-author` (author identity + date to the current user/now)
   * - only → `--only` (amend message/metadata only; do NOT fold staged changes in)
   */
  async amendCommit(options?: { message?: string; keepMessage?: boolean; resetDate?: boolean; resetAuthor?: boolean; only?: boolean }): Promise<void> {
    const args = ['commit', '--amend'];
    if (options?.only) {
      args.push('--only');
    }
    if (options?.keepMessage) {
      args.push('--no-edit');
    } else {
      const msg = (options?.message ?? '').trim();
      if (!msg) {
        throw new GitError('Commit message is required to amend', null, ['commit', '--amend']);
      }
      // A single -m value keeps embedded newlines verbatim (subject + body),
      // and spawn passes it as one argv entry so no shell escaping is needed.
      args.push('-m', msg);
    }
    if (options?.resetDate) {
      args.push('--date=now');
    }
    if (options?.resetAuthor) {
      args.push('--reset-author');
    }
    await this.exec(args);
  }

  async stageFile(filePath: string): Promise<void> {
    this.assertSafePath(filePath, 'add');
    await this.exec(['add', '--', filePath]);
  }

  /**
   * Stage the given repo-relative paths into the index (`git add`). No-op on an
   * empty list. Routes through exec() → withMutationLock (add is a mutation).
   */
  /* SNIPCODE-HOOK start: Batch B rename staging paths */
  async stagePaths(changes: ChangePath[]): Promise<void> {
    const paths = this.expandChangePaths(changes);
    if (paths.length === 0) return;
    for (const p of paths) this.assertSafePath(p, 'add');
    await this.exec(['add', '--', ...paths]);
  }

  /**
   * Remove the given repo-relative paths from the index, keeping working-tree
   * changes. With a HEAD this is `git reset -q HEAD -- <paths>`; under an unborn
   * HEAD (no commits yet) there is no tree to reset against, so unstage by
   * dropping the index entries with `git rm --cached`.
   */
  async unstagePaths(changes: ChangePath[]): Promise<void> {
    const paths = this.expandChangePaths(changes);
    if (paths.length === 0) return;
    for (const p of paths) this.assertSafePath(p, 'reset');
    const hasHead = await this.exec(['rev-parse', '--verify', 'HEAD'], { silent: true })
      .then(() => true)
      .catch(() => false);
    if (hasHead) {
      await this.exec(['reset', '--quiet', 'HEAD', '--', ...paths]);
    } else {
      await this.exec(['rm', '--cached', '--quiet', '--', ...paths]);
    }
  }

  private expandChangePaths(changes: ChangePath[]): string[] {
    return [...new Set(changes.flatMap(change => typeof change === 'string'
      ? [change]
      : [change.path, ...(change.oldPath ? [change.oldPath] : [])]))];
  }
  /* SNIPCODE-HOOK end */

  /**
   * Commit whatever is currently staged (`git commit -m`). Throws with a clear
   * message when the index is empty (git would fail anyway). Returns the new
   * HEAD hash.
   */
  async commitIndex(message: string, opts?: { amend?: boolean }): Promise<string> {
    // amend rewrites the previous commit, so an empty index is fine (reword);
    // a normal commit requires something staged.
    if (!opts?.amend) {
      const indexEmpty = await this.exec(['diff', '--cached', '--quiet'], { silent: true })
        .then(() => true)
        .catch(err => {
          if (err instanceof GitError && err.exitCode === 1) return false;
          throw err;
        });
      if (indexEmpty) throw new Error('nothing staged to commit');
    }
    await this.exec(opts?.amend ? ['commit', '--amend', '-m', message] : ['commit', '-m', message]);
    return (await this.exec(['rev-parse', 'HEAD'])).trim();
  }

  async getConflictFiles(): Promise<string[]> {
    try {
      const raw = await this.exec(['diff', '--name-only', '-z', '--diff-filter=U']);
      return raw.split('\0').filter(Boolean);
    } catch (err) {
      console.warn('Git Graph+: failed to get conflict files:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  async getOperationState(): Promise<{ type: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'squash' | null }> {
    const [merge, cherryPick, revert] = await Promise.allSettled([
      this.exec(['rev-parse', '--verify', 'MERGE_HEAD'], { silent: true }),
      this.exec(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], { silent: true }),
      this.exec(['rev-parse', '--verify', 'REVERT_HEAD'], { silent: true }),
    ]);
    if (merge.status === 'fulfilled') return { type: 'merge' };
    // Don't rely on REBASE_HEAD: git leaves it behind after `rebase --continue`
    // succeeds, which would falsely report a rebase as still in progress. The
    // canonical marker is the rebase state directory.
    const gitDir = this.gitDir();
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) {
      return { type: 'rebase' };
    }
    if (cherryPick.status === 'fulfilled') return { type: 'cherry-pick' };
    if (revert.status === 'fulfilled') return { type: 'revert' };
    if (existsSync(join(gitDir, 'SQUASH_MSG'))) return { type: 'squash' };
    return { type: null };
  }

  /**
   * Flat operation verdict for the commit workbench's D4 gate. Reuses
   * getOperationState() for merge/rebase/cherry-pick/revert and adds the bisect
   * check it lacks. A leftover SQUASH_MSG (getOperationState → 'squash') is not
   * an active operation that blocks committing, so it maps to 'clean' here.
   */
  async getRepoOperationState(): Promise<'clean' | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'> {
    const { type } = await this.getOperationState();
    if (type === 'merge' || type === 'rebase' || type === 'cherry-pick' || type === 'revert') {
      return type;
    }
    // BISECT_LOG exists for the lifetime of a bisect session (removed by
    // `git bisect reset`); getOperationState() does not look at it.
    if (existsSync(join(this.gitDir(), 'BISECT_LOG'))) {
      return 'bisect';
    }
    return 'clean';
  }

  /* SNIPCODE-HOOK start: byte-preserving selective staging */
  /**
   * Raw HEAD→working-tree unified diff for a single file (no color), the text
   * `buildForwardPatch` parses. Mirrors getUncommittedFileDiff's command
   * selection but returns raw bytes instead of a parsed DiffData: tracked
   * files use `git diff -- file`; an untracked new file uses
   * `git diff --no-index /dev/null file` (which exits 1 when it finds the
   * additions — normal, its stdout carries the diff).
   */
  private async workingFileDiffRaw(file: string): Promise<Buffer> {
    this.assertSafePath(file, 'diff');
    /* SNIPCODE-HOOK start: Batch B surface raw diff failures */
    const isTracked = await this.isTrackedFile(file);
    if (!isTracked) {
      return this.exec(['diff', '--no-color', '--no-index', '--', '/dev/null', file], { encoding: 'buffer' })
        .catch(err => { if (err instanceof GitError && err.exitCode === 1) return err.stdoutBuffer; throw err; });
    }
    return this.exec(['diff', '--no-color', '--', file], { encoding: 'buffer' });
  }

  /**
   * Raw HEAD→index (staged) unified diff bytes for one file (no color), which
   * buildForwardPatch parses to reverse-stage selected hunks. Mirrors
   * getUncommittedFileDiff(file, true)'s command so the parsed hunk order lines
   * up with the diff the webview rendered.
   */
  private async stagedFileDiffRaw(file: string): Promise<Buffer> {
    this.assertSafePath(file, 'diff');
    return this.exec(['diff', '--no-color', '--cached', '--', file], { encoding: 'buffer' });
  }

  private async isTrackedFile(file: string): Promise<boolean> {
    return this.exec(['ls-files', '--error-unmatch', '--', file])
      .then(() => true)
      .catch(err => {
        if (err instanceof GitError && err.exitCode === 1) return false;
        throw err;
      });
  }
  /* SNIPCODE-HOOK end */

  /**
   * Stage ONLY the selected hunks of a file's unstaged (index→working) diff into
   * the index, leaving the working tree and every other hunk untouched. Reuses
   * buildForwardPatch (hunk-level, v1) on the SAME diff the Diff webview rendered
   * (workingFileDiffRaw == getUncommittedFileDiff(file, false)'s command), then
   * `git apply --cached`. `hunkIndices` index into that diff's parsed hunk list;
   * the fingerprint rejects a selection if that rendered raw diff changed.
   */
  /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
  async stageHunks(file: string, hunkIndices: number[], fingerprint: string): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.workingFileDiffRaw(file);
    // An empty raw diff under a rendered fingerprint means the shown diff is
    // obsolete (e.g. fully staged elsewhere) — recoverable, so the panel
    // re-renders instead of leaving a dead clickable body.
    if (raw.length === 0) { throw new StaleDiffError(`no unstaged changes to stage for ${file}`); }
    this.assertDiffFingerprint(raw, fingerprint);
    assertHunkStageable(raw.toString('latin1'), file);
    const patch = buildForwardPatch(raw, hunkIndices);
    // exec routes 'apply' through withMutationLock (it is a mutation); stdin
    // feeds the patch (same as reverseCommitChanges). --cached stages only.
    await this.exec(['apply', '--cached'], { stdin: patch });
  }

  /**
   * Unstage ONLY the selected hunks of a file's staged (HEAD→index) diff back to
   * the working tree, leaving other staged hunks in the index. Builds a forward
   * patch of the chosen hunks from the STAGED diff and reverse-applies it to the
   * index (`git apply --cached --reverse`) — the `git reset -p` direction.
   * `hunkIndices` index into getUncommittedFileDiff(file, true)'s hunk list.
   */
  async unstageHunks(file: string, hunkIndices: number[], fingerprint: string): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.stagedFileDiffRaw(file);
    if (raw.length === 0) { throw new StaleDiffError(`no staged changes to unstage for ${file}`); }
    this.assertDiffFingerprint(raw, fingerprint);
    assertHunkStageable(raw.toString('latin1'), file);
    const patch = buildForwardPatch(raw, hunkIndices);
    await this.exec(['apply', '--cached', '--reverse'], { stdin: patch });
  }

  /**
   * Stage ONLY the selected changed lines of ONE hunk of a file's unstaged
   * (index→working) diff into the index — the line-level counterpart of
   * stageHunks. Builds a narrowed forward patch from the SAME diff the Diff
   * webview rendered (workingFileDiffRaw) and `git apply --cached`s it.
   * `hunkIndex`/`lineIndices` index that diff's parsed hunk/DiffLine list.
   */
  async stageLines(file: string, hunkIndex: number, lineIndices: number[], fingerprint: string): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.workingFileDiffRaw(file);
    if (raw.length === 0) { throw new StaleDiffError(`no unstaged changes to stage for ${file}`); }
    this.assertDiffFingerprint(raw, fingerprint);
    assertHunkStageable(raw.toString('latin1'), file);
    const patch = buildForwardPatchLines(raw, hunkIndex, lineIndices);
    // exec routes 'apply' through withMutationLock; --cached stages into the index only.
    await this.exec(['apply', '--cached'], { stdin: patch });
  }

  /**
   * Unstage ONLY the selected changed lines of ONE hunk of a file's staged
   * (HEAD→index) diff back to the working tree — the line-level counterpart of
   * unstageHunks. Builds a narrowed forward patch from the STAGED diff and
   * reverse-applies it to the index (`git apply --cached --reverse`).
   */
  async unstageLines(file: string, hunkIndex: number, lineIndices: number[], fingerprint: string): Promise<void> {
    this.assertSafePath(file, 'apply');
    const raw = await this.stagedFileDiffRaw(file);
    if (raw.length === 0) { throw new StaleDiffError(`no staged changes to unstage for ${file}`); }
    this.assertDiffFingerprint(raw, fingerprint);
    assertHunkStageable(raw.toString('latin1'), file);
    // 'unstage': the raw diff here is HEAD→index, so the current-index baseline
    // is the ADD side, not the DELETE side — see buildForwardPatchLines's
    // `direction` doc for why this flips which unselected kind demotes vs omits.
    const patch = buildForwardPatchLines(raw, hunkIndex, lineIndices, 'unstage');
    await this.exec(['apply', '--cached', '--reverse'], { stdin: patch });
  }
  /* SNIPCODE-HOOK end */

  /**
   * Stage and commit ONLY the selected hunks of the given files, in one atomic
   * unit under the mutation lock (D1 + D4).
   *
   * Preconditions enforced here:
   *  - D4: the repo is not mid merge/rebase/cherry-pick/revert/bisect and has no
   *    unmerged index entries — else throw.
   *  - D1: the index is empty (nothing already staged) — else throw. With a
   *    clean index the flow is simply apply --cached → commit; no staged/unstaged
   *    reconciliation.
   *
   * The working tree is never modified, so unselected hunks remain as
   * uncommitted working changes and no tree reset is needed. On a mid-apply
   * failure the (partially staged) index is reset back to clean before the error
   * is rethrown, so a failed call never leaves the repo polluted.
   *
   * NOTE: runs inside withMutationLock, so all MUTATING git commands use
   * execUnlocked directly (exec would re-enter the lock and deadlock). Read-only
   * commands use exec, which does not take the lock for reads.
   *
   * WARNING: unlike stageHunks/stageLines this path has NO diff-fingerprint
   * guard — hunkIndices are trusted as-is. Its only caller today is the
   * orphaned commit-across-repos protocol (see AGENTS.md); thread a rendered
   * fingerprint through (assertDiffFingerprint) before wiring it to live UI.
   */
  async commitSelected(
    message: string,
    files: Array<{ path: string; hunkIndices: number[] }>,
    opts?: { amend?: boolean },
  ): Promise<string> {
    return this.withMutationLock(async () => {
      // D4: no in-progress operation.
      const opState = await this.getRepoOperationState();
      if (opState !== 'clean') {
        throw new Error(`repo has an in-progress ${opState}; resolve it first`);
      }
      // D4: no unmerged (conflicted) index entries.
      const unmerged = await this.exec(['ls-files', '--unmerged']).catch(() => '');
      if (unmerged.trim().length > 0) {
        throw new Error('repo has unmerged paths; resolve conflicts first');
      }

      // D1: the index must be clean. `git diff --cached --quiet` exits 0 when
      // nothing is staged, 1 when something is.
      const indexClean = await this.exec(['diff', '--cached', '--quiet'], { silent: true })
        .then(() => true)
        .catch(err => {
          if (err instanceof GitError && err.exitCode === 1) { return false; }
          throw err;
        });
      if (!indexClean) {
        throw new Error('index already has staged changes; commit or reset them first');
      }

      try {
        for (const { path, hunkIndices } of files) {
          const raw = await this.workingFileDiffRaw(path);
          if (raw.length === 0) {
            throw new Error(`no working-tree changes to stage for ${path}`);
          }
          /* SNIPCODE-HOOK start: Batch B commitSelected mode guard */
          assertHunkStageable(raw.toString('latin1'), path);
          /* SNIPCODE-HOOK end */
          const patch = buildForwardPatch(raw, hunkIndices);
          // `git apply` reads the patch from stdin when no path argument is given
          // (same as reverseCommitChanges); --cached stages into the index only.
          await this.execUnlocked(['apply', '--cached'], { stdin: patch });
        }
        // Amend folds the freshly-staged hunks into HEAD (no new commit); a plain
        // commit creates one. Both use -m with the shared workbench message.
        const commitArgs = opts?.amend
          ? ['commit', '--amend', '-m', message]
          : ['commit', '-m', message];
        await this.execUnlocked(commitArgs);
      } catch (err) {
        // Undo any partial staging so a failed commit leaves a clean index; the
        // working tree was never touched, so a mixed reset restores the
        // pre-call state exactly.
        await this.execUnlocked(['reset', '--quiet']).catch(() => { /* best-effort cleanup */ });
        throw err;
      }

      return (await this.exec(['rev-parse', 'HEAD'])).trim();
    });
  }
  /* SNIPCODE-HOOK end */

  async continueOperation(): Promise<void> {
    const conflictFiles = await this.getConflictFiles();
    if (conflictFiles.length > 0) {
      await this.exec(['add', '--', ...conflictFiles]);
    }
    const state = await this.getOperationState();
    switch (state.type) {
      case 'merge': await this.exec(['commit', '--no-edit']); break;
      case 'squash': await this.exec(['commit', '--no-edit']); break;
      case 'rebase': await this.exec(['rebase', '--continue']); break;
      case 'cherry-pick': await this.exec(['cherry-pick', '--continue']); break;
      case 'revert': await this.exec(['revert', '--continue']); break;
    }
  }

  async abortOperation(): Promise<void> {
    const state = await this.getOperationState();
    switch (state.type) {
      case 'merge': await this.abortMerge(); break;
      case 'squash': await this.exec(['reset', '--merge', 'HEAD']); break;
      case 'rebase': await this.abortRebase(); break;
      case 'cherry-pick': await this.exec(['cherry-pick', '--abort']); break;
      case 'revert': await this.exec(['revert', '--abort']); break;
    }
  }

  // --- Phase 5: Stash, Cherry-pick, Revert, Tags ---

  async stashSave(message?: string, includeUntracked?: boolean, keepIndex?: boolean): Promise<void> {
    const args = ['stash', 'push'];
    if (message) {
      args.push('-m', message);
    }
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    if (keepIndex) {
      args.push('--keep-index');
    }
    await this.exec(args);
    this.clearReadCache();
  }

  async stashApply(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'apply', `stash@{${index}}`]);
  }

  async stashPop(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'pop', `stash@{${index}}`]);
  }

  async stashDrop(index: number): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    await this.exec(['stash', 'drop', `stash@{${index}}`]);
  }

  async stashRename(index: number, newMessage: string): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    const ref = `stash@{${index}}`;
    const sha = (await this.exec(['rev-parse', ref])).trim();
    // Renaming a stash means re-storing the same commit under a new reflog
    // subject; `stash store` only prepends a fresh entry when the stored sha
    // differs from the current tip, so it must come *after* the drop (storing
    // the tip's own sha is a no-op and would leave the name unchanged).
    // Capture the original subject first so that if `store` fails after the
    // drop, we can put the stash back instead of stranding it as a dangling
    // commit (the data-loss window of an unguarded drop-then-store).
    const original = (await this.exec(['log', '-1', '--format=%s', sha])).trim();
    await this.exec(['stash', 'drop', ref]);
    try {
      await this.exec(['stash', 'store', '-m', newMessage, sha]);
    } catch (err) {
      await this.exec(['stash', 'store', '-m', original, sha]).catch(() => { /* best effort */ });
      throw err;
    }
  }

  async stashRestoreFiles(index: number, paths: string[]): Promise<void> {
    if (!Number.isInteger(index) || index < 0) throw new Error('Invalid stash index');
    if (!paths || paths.length === 0) throw new Error('No paths to restore');
    for (const p of paths) {
      this.assertSafePath(p, 'stash restore');
    }
    await this.exec(['restore', `--source=stash@{${index}}`, '--', ...paths]);
  }

  async cherryPick(hashes: string | string[], options?: { noCommit?: boolean }): Promise<void> {
    const list = Array.isArray(hashes) ? hashes : [hashes];
    for (const hash of list) {
      this.assertSafeRef(hash, 'cherry-pick');
    }
    const args = ['cherry-pick'];
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    // git applies the listed commits in order, so callers pass them oldest→newest.
    args.push(...list);
    await this.exec(args);
  }

  async revert(hash: string, options?: { noCommit?: boolean }): Promise<void> {
    this.assertSafeRef(hash, 'revert');
    const args = ['revert'];
    if (options?.noCommit) {
      args.push('--no-commit');
    }
    args.push(hash);
    await this.exec(args);
  }

  async commitFixup(hash: string): Promise<void> {
    this.assertSafeRef(hash, 'commit');
    await this.exec(['commit', '--fixup', hash]);
  }

  async commitSquash(hash: string): Promise<void> {
    this.assertSafeRef(hash, 'commit');
    await this.exec(['commit', '--squash', hash]);
  }

  async createTag(name: string, ref?: string, message?: string): Promise<void> {
    this.assertSafeRef(name, 'tag');
    if (ref) this.assertSafeRef(ref, 'tag');
    const args = ['tag'];
    if (message) {
      args.push('-a', name, '-m', message);
    } else {
      args.push(name);
    }
    if (ref) {
      args.push(ref);
    }
    await this.exec(args);
  }

  async deleteTag(name: string): Promise<void> {
    this.assertSafeRef(name, 'tag -d');
    await this.exec(['tag', '-d', name]);
  }

  // --- Phase 6: Search, Commit Template ---

  async searchCommits(query: string, options?: { author?: string; after?: string; before?: string; limit?: number }): Promise<Commit[]> {
    // Defense-in-depth: reject control characters that could inject extra git
    // arguments. spawn() with explicit argv already prevents shell injection,
    // but a newline inside --grep=... lets a single user value carry multiple
    // tokens once git's own argv parser splits on whitespace in some configs.
    const reject = (v: string) => { throw new GitError(`Invalid search input: ${v}`, null, ['log']); };
    // Reject ASCII control chars (newline, CR, NUL, etc.). Spaces and printable
    // punctuation are legitimate in user queries.
    // eslint-disable-next-line no-control-regex
    const hasControl = (v: string) => /[\x00-\x1f\x7f]/.test(v);
    if (query && hasControl(query)) reject(query);
    if (options?.author && hasControl(options.author)) reject(options.author);
    if (options?.after && hasControl(options.after)) reject(options.after);
    if (options?.before && hasControl(options.before)) reject(options.before);

    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--all',
      `--max-count=${options?.limit ?? 200}`,
    ];

    if (query) {
      args.push(`--grep=${query}`, '-i');
    }
    if (options?.author) {
      args.push(`--author=${options.author}`);
    }
    if (options?.after) {
      args.push(`--after=${options.after}`);
    }
    if (options?.before) {
      args.push(`--before=${options.before}`);
    }

    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    const commits = parseLog(raw, remoteNames);
    return commits;
  }

  async searchByFile(filePath: string, limit: number = 100): Promise<Commit[]> {
    this.assertSafePath(filePath, 'log');
    const args = [
      'log',
      '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
      '--all',
      `--max-count=${limit}`,
      '--',
      filePath,
    ];
    const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
    const commits = parseLog(raw, remoteNames);
    return commits;
  }

  async searchByHash(hash: string): Promise<Commit | null> {
    try {
      this.assertSafeRef(hash, 'log');
      const args = [
        'log',
        '--format=%x01%x02%x03%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%P%x00%D%x00%b',
        '-1',
        hash,
      ];
      const [raw, remoteNames] = await Promise.all([this.exec(args), this.getRemoteNames()]);
      const commits = parseLog(raw, remoteNames);
      return commits[0] ?? null;
    } catch (err) {
      console.warn('Git Graph+: failed to get commit by hash:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // --- Bisect ---

  async bisectStart(bad?: string, good?: string): Promise<string> {
    const args = ['bisect', 'start'];
    if (bad) { this.assertSafeRef(bad, 'bisect start'); args.push(bad); }
    if (good) { this.assertSafeRef(good, 'bisect start'); args.push(good); }
    return this.exec(args);
  }

  async bisectGood(ref?: string): Promise<string> {
    const args = ['bisect', 'good'];
    if (ref) { this.assertSafeRef(ref, 'bisect good'); args.push(ref); }
    return this.exec(args);
  }

  async bisectBad(ref?: string): Promise<string> {
    const args = ['bisect', 'bad'];
    if (ref) { this.assertSafeRef(ref, 'bisect bad'); args.push(ref); }
    return this.exec(args);
  }

  async bisectSkip(): Promise<string> {
    return this.exec(['bisect', 'skip']);
  }

  async bisectReset(): Promise<string> {
    return this.exec(['bisect', 'reset']);
  }

  async bisectLog(): Promise<string> {
    return this.exec(['bisect', 'log']);
  }

  // --- Submodules ---

  async submoduleStatus(): Promise<Array<{ hash: string; path: string; status: string }>> {
    const raw = await this.exec(['submodule', 'status']);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^([+ -U])([0-9a-f]+)\s+(\S+)/);
      if (!match) { return { hash: '', path: line.trim(), status: '?' }; }
      return { hash: match[2], path: match[3], status: match[1] === ' ' ? 'clean' : match[1] === '+' ? 'modified' : match[1] === '-' ? 'uninitialized' : 'conflict' };
    });
  }

  async submoduleUpdate(init?: boolean): Promise<string> {
    const args = ['submodule', 'update'];
    if (init) { args.push('--init', '--recursive'); }
    return this.exec(args);
  }

  // --- Git LFS ---

  /** True for LFS errors that are expected configuration limits (file:// or ssh:
   *  remote with no lock server, no remote configured, etc.) rather than real
   *  failures the user should be alerted about. */
  private isExpectedLfsFailure(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return (
      s.includes('missing protocol') ||                  // file:// / unsupported remote
      s.includes('standalone transfer agent') ||          // file:// fallback hint
      s.includes('no such remote') ||
      s.includes("'origin' does not appear to be a git repository") ||
      s.includes('lfs.url') ||                            // unconfigured lock server
      s.includes('this operation requires existing locks') ||
      s.includes('http_1_1_required') ||                  // TFS/Azure DevOps LFS locks may reject HTTP/2
      s.includes('is not a git command') ||              // git-lfs not installed
      s.includes('not a git repository')
    );
  }

  async lfsLsFiles(): Promise<Array<{ oid: string; path: string }>> {
    try {
      const raw = await this.exec(['lfs', 'ls-files']);
      return parseLfsFiles(raw);
    } catch (err) {
      // Stay silent when git-lfs is just not installed (exitCode null = spawn
      // ENOENT) or when the failure is a known configuration limit. Only
      // surface unexpected failures so the warning channel stays signal.
      if (err instanceof GitError && err.exitCode !== null && !this.isExpectedLfsFailure(err.stderr)) {
        this.warn(`LFS ls-files failed: ${err.stderr || err.message}`);
      }
      console.warn('Git Graph+: LFS ls-files failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  async lfsLock(file: string): Promise<string> {
    this.assertSafePath(file, 'lfs lock');
    return this.exec(['lfs', 'lock', '--', file]);
  }

  async lfsUnlock(file: string, force?: boolean): Promise<string> {
    this.assertSafePath(file, 'lfs unlock');
    const args = ['lfs', 'unlock'];
    if (force) { args.push('--force'); }
    args.push('--', file);
    return this.exec(args);
  }

  async lfsLocks(): Promise<Array<{ path: string; owner: string; id: string }>> {
    try {
      const raw = await this.exec(['lfs', 'locks']);
      return parseLfsLocks(raw);
    } catch (err) {
      if (err instanceof GitError && err.exitCode !== null && !this.isExpectedLfsFailure(err.stderr)) {
        this.warn(`LFS locks failed: ${err.stderr || err.message}`);
      }
      console.warn('Git Graph+: LFS locks failed:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  // --- File tree at commit ---

  async lsTree(ref: string, path?: string): Promise<Array<{ mode: string; type: 'blob' | 'tree' | 'commit'; hash: string; name: string }>> {
    this.assertSafeRef(ref, 'ls-tree');
    const args = ['ls-tree', ref];
    if (path) {
      this.assertSafePath(path, 'ls-tree');
      args.push('--', path);
    }
    const raw = await this.exec(args);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^(\d+)\s+(blob|tree|commit)\s+([0-9a-f]+)\s+(.+)$/);
      if (!match) { return { mode: '', type: 'blob' as const, hash: '', name: line }; }
      return { mode: match[1], type: match[2] as 'blob' | 'tree' | 'commit', hash: match[3], name: match[4] };
    });
  }

  // --- Statistics ---

  async statsCommitsByAuthor(): Promise<Array<{ author: string; email: string; count: number }>> {
    const raw = await this.exec(['shortlog', '-sne', '--all', '--no-merges']);
    if (!raw.trim()) { return []; }
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s+<(.+?)>$/);
      if (!match) { return { author: line.trim(), email: '', count: 0 }; }
      return { author: match[2].trim(), email: match[3].trim(), count: parseInt(match[1], 10) };
    });
  }

  async statsCommitsByWeekdayHour(): Promise<Array<{ weekday: number; hour: number; count: number }>> {
    const raw = await this.exec(['log', '--all', '--format=%aI', '--no-merges']);
    if (!raw.trim()) { return []; }
    const grid = new Map<string, number>();
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      const bin = binCommitTime(line.trim());
      if (!bin) continue;
      const key = `${bin.weekday}-${bin.hour}`;
      grid.set(key, (grid.get(key) ?? 0) + 1);
    }
    return Array.from(grid.entries()).map(([key, count]) => {
      const [weekday, hour] = key.split('-').map(Number);
      return { weekday, hour, count };
    });
  }

  // --- Patch ---

  async formatPatch(hash: string, paths?: string[]): Promise<string> {
    this.assertSafeRef(hash, 'format-patch');
    const args = ['format-patch', '-1', hash, '--stdout'];
    if (paths && paths.length > 0) {
      for (const p of paths) {
        this.assertSafePath(p, 'format-patch');
      }
      args.push('--', ...paths);
    }
    return this.exec(args);
  }

  async diffCommitToWorking(hash: string): Promise<DiffData[]> {
    this.assertSafeRef(hash, 'diff');
    const raw = await this.exec(['diff', hash]);
    return parseDiff(raw);
  }

  // --- Git Flow ---

  async flowInit(options: {
    productionBranch: string;
    developBranch: string;
    featurePrefix: string;
    releasePrefix: string;
    hotfixPrefix: string;
    versionTagPrefix: string;
  }): Promise<string> {
    // production 브랜치 존재 여부 검증
    try {
      await this.exec(['rev-parse', '--verify', options.productionBranch]);
    } catch {
      throw new GitError(
        `Branch '${options.productionBranch}' does not exist. Create the production branch first or ensure at least one commit exists.`,
        1,
        ['flow', 'init']
      );
    }

    // git flow init -d로 기본 초기화 후 커스텀 설정 덮어쓰기
    await this.exec(['flow', 'init', '-d']);
    await this.exec(['config', 'gitflow.branch.master', options.productionBranch]);
    await this.exec(['config', 'gitflow.branch.develop', options.developBranch]);
    await this.exec(['config', 'gitflow.prefix.feature', options.featurePrefix]);
    await this.exec(['config', 'gitflow.prefix.release', options.releasePrefix]);
    await this.exec(['config', 'gitflow.prefix.hotfix', options.hotfixPrefix]);
    await this.exec(['config', 'gitflow.prefix.versiontag', options.versionTagPrefix]);

    // develop 브랜치가 없으면 생성
    try {
      await this.exec(['rev-parse', '--verify', options.developBranch]);
    } catch {
      await this.exec(['branch', options.developBranch, options.productionBranch]);
    }

    return 'Git Flow initialized';
  }

  async flowFeatureStart(name: string): Promise<string> {
    this.assertSafeRef(name, 'flow feature start');
    return this.exec(['flow', 'feature', 'start', name]);
  }

  async flowFeatureFinish(name: string): Promise<string> {
    this.assertSafeRef(name, 'flow feature finish');
    return this.exec(['flow', 'feature', 'finish', name]);
  }

  async flowReleaseStart(version: string): Promise<string> {
    this.assertSafeRef(version, 'flow release start');
    return this.exec(['flow', 'release', 'start', version]);
  }

  async flowReleaseFinish(version: string): Promise<string> {
    this.assertSafeRef(version, 'flow release finish');
    return this.exec(['flow', 'release', 'finish', '-m', version, version]);
  }

  async flowHotfixStart(version: string): Promise<string> {
    this.assertSafeRef(version, 'flow hotfix start');
    return this.exec(['flow', 'hotfix', 'start', version]);
  }

  async flowHotfixFinish(version: string): Promise<string> {
    this.assertSafeRef(version, 'flow hotfix finish');
    return this.exec(['flow', 'hotfix', 'finish', '-m', version, version]);
  }

  async getFlowConfig(): Promise<{
    productionBranch: string;
    developBranch: string;
    featurePrefix: string;
    releasePrefix: string;
    hotfixPrefix: string;
    versionTagPrefix: string;
  } | null> {
    try {
      const [production, develop, feature, release, hotfix, versionTag] = await Promise.all([
        this.exec(['config', '--get', 'gitflow.branch.master']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.branch.develop']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.feature']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.release']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.hotfix']).then(s => s.trim()),
        this.exec(['config', '--get', 'gitflow.prefix.versiontag']).then(s => s.trim()).catch(() => ''),
      ]);
      return {
        productionBranch: production,
        developBranch: develop,
        featurePrefix: feature,
        releasePrefix: release,
        hotfixPrefix: hotfix,
        versionTagPrefix: versionTag,
      };
    } catch (err) { console.warn('Git Graph+: failed to get flow config:', err instanceof Error ? err.message : err); return null; }
  }

  async getFlowBranches(): Promise<{ features: string[]; releases: string[]; hotfixes: string[] }> {
    const config = await this.getFlowConfig();
    if (!config) return { features: [], releases: [], hotfixes: [] };

    const raw = await this.exec(['branch', '--list']).then(s => s.trim());
    const branches = raw.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean);

    return {
      features: branches.filter(b => b.startsWith(config.featurePrefix)),
      releases: branches.filter(b => b.startsWith(config.releasePrefix)),
      hotfixes: branches.filter(b => b.startsWith(config.hotfixPrefix)),
    };
  }

  // --- Worktree ---

  async worktreeList(): Promise<WorktreeInfo[]> {
    return this.cachedRead('worktreeList', async () => {
      const raw = await this.exec(['worktree', 'list', '--porcelain']);
      return parseWorktreeList(raw);
    });
  }

  async worktreeAdd(worktreePath: string, branch?: string, newBranch?: string): Promise<void> {
    // Worktree paths are legitimately absolute, so assertSafePath (which
    // rejects absolutes) doesn't fit; assertSafeRef's non-empty +
    // no-leading-dash check is exactly the flag-smuggling guard needed.
    this.assertSafeRef(worktreePath, 'worktree add');
    if (newBranch) { this.assertSafeRef(newBranch, 'worktree add'); }
    if (branch) { this.assertSafeRef(branch, 'worktree add'); }
    const args = ['worktree', 'add'];
    if (newBranch) {
      args.push('-b', newBranch);
    }
    args.push(worktreePath);
    if (branch) {
      args.push(branch);
    }
    await this.exec(args);
  }

  async worktreeRemove(worktreePath: string, force?: boolean): Promise<void> {
    this.assertSafeRef(worktreePath, 'worktree remove'); // flag-smuggling guard (see worktreeAdd)
    const args = ['worktree', 'remove'];
    if (force) { args.push('--force'); }
    args.push(worktreePath);
    await this.exec(args);
  }

  async worktreePrune(): Promise<void> {
    await this.exec(['worktree', 'prune']);
  }

  // --- Tag Remote Operations ---

  async pushTag(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push refs/tags');
    if (remote) { this.assertSafeRef(remote, 'push refs/tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, `refs/tags/${name}`], r);
  }

  async pushTagToAllRemotes(name: string): Promise<void> {
    this.assertSafeRef(name, 'push refs/tags');
    const remotes = await this.getRemoteNames();
    for (const r of remotes) {
      await this.execWithAuthRetry(['push', r, `refs/tags/${name}`], r);
    }
  }

  async pushAllTags(remote?: string): Promise<string> {
    if (remote) { this.assertSafeRef(remote, 'push --tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, '--tags'], r);
  }

  async deleteRemoteBranch(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push --delete');
    if (remote) { this.assertSafeRef(remote, 'push --delete'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, '--delete', name], r);
  }

  async deleteRemoteTag(name: string, remote?: string): Promise<string> {
    this.assertSafeRef(name, 'push :refs/tags');
    if (remote) { this.assertSafeRef(remote, 'push :refs/tags'); }
    const r = remote || 'origin';
    return this.execWithAuthRetry(['push', r, `:refs/tags/${name}`], r);
  }

  async deleteTagFromAllRemotes(name: string): Promise<void> {
    this.assertSafeRef(name, 'push :refs/tags');
    const remotes = await this.getRemoteNames();
    const errors: unknown[] = [];
    for (const r of remotes) {
      try {
        await this.execWithAuthRetry(['push', r, `:refs/tags/${name}`], r);
      } catch (err) {
        // A tag that was never pushed to this remote makes git fail with
        // "remote ref does not exist" — that's already the desired end state,
        // so skip it and keep deleting from the remaining remotes. Anything
        // else (auth, network) is collected and surfaced after every remote
        // has been attempted, so one bad remote can't block the others.
        if (err instanceof GitError && /remote ref does not exist/i.test(err.stderr)) {
          continue;
        }
        errors.push(err);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      // Surface every failing remote, not just the first, so one error doesn't
      // hide the others.
      throw new AggregateError(errors, `Failed to delete tag from ${errors.length} remotes`);
    }
  }

  // --- Image at ref (binary-safe) ---

  async getImageBase64(ref: string, filePath: string): Promise<string> {
    this.assertSafeRef(ref, 'show');
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new GitError('Invalid filePath for show', null, []);
    }
    // Reject absolute paths and any segment equal to '..' to keep reads within the repo tree.
    if (filePath.startsWith('/') || filePath.split(/[\\/]/).includes('..')) {
      throw new GitError(`Unsafe filePath: ${filePath}`, null, []);
    }
    const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50MB limit
    return new Promise((resolve, reject) => {
      const proc = spawn(getGitBinaryPath(), ['show', `${ref}:${filePath}`], {
        cwd: this.repoPath,
        env: { ...process.env, ...this.extraEnv, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_MERGE_AUTOEDIT: 'no', GIT_EDITOR: 'true', EDITOR: 'true' },
      });

      const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new GitError('Image load timed out', null, ['show'])); }, 30000);
      const chunks: Buffer[] = [];
      let totalSize = 0;
      proc.stdout.on('data', (data: Buffer) => {
        totalSize += data.length;
        if (totalSize > MAX_IMAGE_SIZE) { proc.kill('SIGTERM'); return; }
        chunks.push(data);
      });

      let stderr = '';
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (totalSize > MAX_IMAGE_SIZE) {
          reject(new GitError('Image file too large', null, ['show', `${ref}:${filePath}`]));
        } else if (code === 0) {
          const buffer = Buffer.concat(chunks);
          resolve(buffer.toString('base64'));
        } else {
          reject(new GitError(stderr, code, ['show', `${ref}:${filePath}`]));
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new GitError(err.message, null, ['show', `${ref}:${filePath}`]));
      });
    });
  }

  async isFlowInstalled(): Promise<boolean> {
    try {
      await this.exec(['flow', 'version']);
      return true;
    } catch (err) { console.warn('Git Graph+: flow version check failed:', err instanceof Error ? err.message : err); return false; }
  }

  async isFlowInitialized(): Promise<boolean> {
    try {
      await this.exec(['config', '--get', 'gitflow.branch.master']);
      return true;
    } catch (err) { console.warn('Git Graph+: flow init check failed:', err instanceof Error ? err.message : err); return false; }
  }

}

/**
 * Build a `git commit --amend` command for use in interactive rebase exec lines.
 * Single-line messages → `--no-edit -m 'msg'`.
 * Multi-line messages → POSIX printf pipeline to preserve newlines.
 */
export function buildAmendCommandStr(message: string, escape: (s: string) => string): string {
  if (!message.includes('\n')) {
    return `git commit --amend --no-edit -m ${escape(message)}`;
  }
  const parts = message.split('\n').map(l => escape(l));
  return `printf '%s\\n' ${parts.join(' ')} | git commit --amend -F -`;
}
