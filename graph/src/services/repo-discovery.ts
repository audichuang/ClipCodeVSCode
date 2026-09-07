import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getGitBinaryPath } from '../git/git-binary';

export type RepoType = 'root' | 'submodule' | 'nested';

export interface RepoInfo {
  path: string;
  name: string;
  type: RepoType;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'vendor', 'dist', 'build',
  '.next', '.nuxt', '__pycache__', '.venv', 'venv', '.tox',
]);

const MAX_DEPTH = 3;

/* SNIPCODE-HOOK start: share one in-flight walk per key */
interface PendingWalk {
  promise: Promise<RepoInfo[]>;
  progress: Array<(partial: RepoInfo[]) => void>;
  /** The fast-pass snapshot once emitted, replayed to callers that join later. */
  fastPass?: RepoInfo[];
}
/* SNIPCODE-HOOK end */

export class RepoDiscoveryService {
  private static cache: { repos: RepoInfo[]; cacheKey: string } | null = null;

  /**
   * Discover all git repositories within the given workspace folders.
   * Finds the workspace root repo, its submodules, and independent nested repos.
   * Results are cached until clearCache() is called.
   */
  static discoverRepos(
    folderPaths: string[],
    onProgress?: (partial: RepoInfo[]) => void,
  ): Promise<RepoInfo[]> {
    const cacheKey = [...folderPaths].sort().join(';');
    if (this.cache && this.cache.cacheKey === cacheKey) {
      return Promise.resolve(this.cache.repos);
    }
    /* SNIPCODE-HOOK start: share one in-flight walk per key
       The cache is only written when a walk ENDS, so the three identical calls
       activate() issues in the same tick (Changes tree, per-repo FileWatchers,
       Recent Commits on webview-ready) each ran the whole readdir + spawn walk —
       measured 3× the cost, 2.3s at 25 workspace roots. Later callers join the
       running walk; every caller's onProgress still fires. */
    const inflight = this.pending.get(cacheKey);
    if (inflight) {
      if (onProgress) {
        inflight.progress.push(onProgress);
        // Joined after the fast pass already fired: replay it, so this caller
        // can start on the roots too instead of waiting for the deep walk.
        if (inflight.fastPass) { onProgress(inflight.fastPass); }
      }
      return inflight.promise;
    }
    const entry: PendingWalk = { promise: Promise.resolve([]), progress: onProgress ? [onProgress] : [] };
    entry.promise = this.walk(folderPaths, cacheKey, (partial) => {
      entry.fastPass = partial;
      for (const cb of entry.progress) { cb(partial); }
    }).finally(() => { if (this.pending.get(cacheKey) === entry) { this.pending.delete(cacheKey); } });
    this.pending.set(cacheKey, entry);
    return entry.promise;
  }

  private static pending = new Map<string, PendingWalk>();

  private static async walk(
    folderPaths: string[],
    cacheKey: string,
    onProgress: (partial: RepoInfo[]) => void,
  ): Promise<RepoInfo[]> {
    /* SNIPCODE-HOOK end */
    const repos: RepoInfo[] = [];
    const seen = new Set<string>();
    const normalize = (p: string) => path.resolve(p).toLowerCase();

    // --- Fast pass: workspace-root repos + their immediate children ---------
    // These cover the common case (a folder holding N sibling repos). Emitting
    // them right away lets the repo dropdown populate in ~one readdir instead of
    // waiting for the full depth-3 walk + serial submodule scan, which on slow
    // filesystems (network mounts, WSL /mnt) can stack into minutes.
    /* SNIPCODE-HOOK start: probe the roots in parallel — a 25-folder workspace
       otherwise pays 25 serial rev-parse spawns before the first result. A folder
       that is not a repo resolves to '' and is skipped (its children still get
       scanned below). */
    const roots = await Promise.all(folderPaths.map(folderPath =>
      this.execGit(['rev-parse', '--show-toplevel'], folderPath).catch(() => '')));
    for (const repoRoot of roots) {
      if (!repoRoot) { continue; }
      const normRoot = normalize(repoRoot);
      if (!seen.has(normRoot)) {
        seen.add(normRoot);
        repos.push({
          path: repoRoot,
          name: path.basename(repoRoot),
          type: 'root',
        });
      }
    }
    /* SNIPCODE-HOOK end */
    for (const folderPath of folderPaths) {
      await this.discoverNestedRepos(folderPath, seen, repos, 0, normalize, 1);
    }
    onProgress(this.finalizeRepos(repos.map(r => ({ ...r }))));

    // --- Slow pass: deep nested repos (already-found roots are skipped) ------
    for (const folderPath of folderPaths) {
      await this.discoverNestedRepos(folderPath, seen, repos, 0, normalize, MAX_DEPTH);
    }

    // Discover submodules from each repo found — in parallel so one slow repo
    // (or one that hits the 15s timeout) no longer blocks all the others.
    const reposToScan = [...repos];
    const subLists = await Promise.all(
      reposToScan.map(repo => this.getSubmodules(repo.path).catch(() => [] as RepoInfo[])),
    );
    for (const subs of subLists) {
      for (const sub of subs) {
        const normSub = normalize(sub.path);
        if (!seen.has(normSub)) {
          seen.add(normSub);
          repos.push(sub);
        }
      }
    }

    this.finalizeRepos(repos);
    this.cache = { repos, cacheKey };
    return repos;
  }

  /** Sort by type/name and disambiguate duplicate basenames in place. */
  private static finalizeRepos(repos: RepoInfo[]): RepoInfo[] {
    const typeOrder: Record<RepoType, number> = { root: 0, nested: 1, submodule: 2 };
    repos.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || a.name.localeCompare(b.name));

    // De-duplicate names by prepending path segments until unique
    const nameToRepos = new Map<string, RepoInfo[]>();
    for (const repo of repos) {
      const list = nameToRepos.get(repo.name) || [];
      list.push(repo);
      nameToRepos.set(repo.name, list);
    }

    for (const [name, duplicates] of nameToRepos.entries()) {
      if (duplicates.length > 1) {
        // For each duplicate, try to make it unique by adding parent directories
        for (const repo of duplicates) {
          let currentPath = repo.path;
          let newName = repo.name;
          let partsAdded = 0;
          
          // Keep adding parent dirs until this specific repo name is unique among all repos
          while (partsAdded < 3) {
            const parent = path.dirname(currentPath);
            if (parent === currentPath) break; // Reached root
            const parentName = path.basename(parent);
            if (!parentName) break;

            newName = `${parentName}/${newName}`;
            currentPath = parent;
            partsAdded++;

            // Check if this newName is now unique
            const isUnique = !repos.some(r => r !== repo && r.name === newName);
            if (isUnique) {
              repo.name = newName;
              break;
            }
          }
        }
      }
    }

    return repos;
  }

  static clearCache(): void {
    this.cache = null;
    /* SNIPCODE-HOOK start: a walk started before the invalidation must not be
       joined by callers who arrive after it */
    this.pending.clear();
    /* SNIPCODE-HOOK end */
  }

  private static async discoverNestedRepos(
    dir: string, seen: Set<string>, repos: RepoInfo[], depth: number, normalize: (p: string) => string,
    maxDepth: number = MAX_DEPTH
  ): Promise<void> {
    if (depth >= maxDepth) { return; }

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const dirs = entries.filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name) && !e.name.startsWith('.'));

    // Check all children in parallel - detect repos by .git presence, then verify with git rev-parse
    const results = await Promise.all(dirs.map(async (entry) => {
      const childPath = path.join(dir, entry.name);
      // Already discovered on the fast pass — skip the redundant rev-parse spawn.
      if (seen.has(normalize(childPath))) { return { childPath, hasGit: true }; }
      const hasGit = await this.hasGitDir(childPath);
      if (hasGit) {
        try {
          // Verify it's a real git repo and get its canonical root path
          const realRoot = await this.execGit(['rev-parse', '--show-toplevel'], childPath);
          return { childPath: realRoot, hasGit: true };
        } catch {
          // False positive .git folder
          return { childPath, hasGit: false };
        }
      }
      return { childPath, hasGit: false };
    }));

    const toRecurse: string[] = [];
    for (const { childPath, hasGit } of results) {
      const normPath = normalize(childPath);
      if (hasGit && !seen.has(normPath)) {
        seen.add(normPath);
        repos.push({ path: childPath, name: path.basename(childPath), type: 'nested' });
        // Don't recurse into discovered repos
      } else if (!hasGit) {
        toRecurse.push(childPath);
      }
    }

    // Recurse into non-repo directories in parallel (carry maxDepth through so
    // the fast pass actually stops at depth 1 instead of resetting to MAX_DEPTH).
    await Promise.all(toRecurse.map(p => this.discoverNestedRepos(p, seen, repos, depth + 1, normalize, maxDepth)));
  }

  private static async hasGitDir(dir: string): Promise<boolean> {
    // fs.access accepts both directories and files, so worktree-linked checkouts
    // (where `.git` is a file pointing at the real gitdir) are detected too.
    // Bare repositories (no `.git` entry; HEAD/refs/objects at the top level) are
    // intentionally not surfaced — the rest of the extension assumes a working tree.
    return this.exists(path.join(dir, '.git'));
  }

  private static async exists(entry: string): Promise<boolean> {
    try {
      await fs.promises.access(entry);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Uses `git submodule status --recursive` to find all submodules.
   * Works for both initialized and uninitialized submodules, cross-platform.
   */
  private static async getSubmodules(repoPath: string): Promise<RepoInfo[]> {
    /* SNIPCODE-HOOK start: perf — recognise "no submodules" without spawning.
       `git submodule status` is a shell wrapper (~18 execve, 10-15ms) where the
       plumbing commands around it cost ~1ms, and the slow pass fires one per
       discovered repo. Those spawns gate the `full` promise, which since the
       commit-scope guard (changes-tree.ts `commitScopeReady`) also gates the
       Commit button — so a 25-repo workspace paid ~1s of shell wrappers before
       the primary action unlocked. Two filesystem signals stand in for the
       spawn: `.gitmodules` (a tracked working-tree file, present whenever
       submodules are configured, worktree checkouts included) and
       `.git/modules/` (present once one was ever initialised, which covers a
       `.gitmodules` deleted in the working tree but still in the index — git
       would list those gitlinks and the file alone would not). The second
       signal is main-checkout-only: in a linked worktree `.git` is a FILE, so
       that path never resolves and only `.gitmodules` speaks — which is the
       normal case there anyway, since it is a tracked file. Not worth resolving
       the real gitdir for the deleted-but-staged corner. */
    if (!(await this.exists(path.join(repoPath, '.gitmodules')))
      && !(await this.exists(path.join(repoPath, '.git', 'modules')))) {
      return [];
    }
    /* SNIPCODE-HOOK end */
    try {
      const raw = await this.execGit(['submodule', 'status', '--recursive'], repoPath);
      if (!raw.trim()) { return []; }

      // Format: " <hash> <path> (<ref>)" or "-<hash> <path>" (uninitialized) or "+<hash> <path> (<ref>)" (modified)
      const results: RepoInfo[] = [];
      for (const line of raw.trim().split('\n').filter(Boolean)) {
        const match = line.match(/^[\s+-]?[0-9a-f]+\s+(\S+)/);
        if (!match) { continue; }
        const smPath = match[1];
        results.push({
          path: path.resolve(repoPath, smPath),
          name: path.basename(smPath),
          type: 'submodule',
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  private static execGit(args: string[], cwd: string, timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(getGitBinaryPath(), args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
        reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          // Include git's stderr so a discovery failure is diagnosable rather
          // than a bare "git X failed".
          reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`));
        }
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
