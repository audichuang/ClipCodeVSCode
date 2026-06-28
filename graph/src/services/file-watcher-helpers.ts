import * as path from 'path';
import * as fs from 'fs';

/**
 * Resolves the real gitdir for `repoPath`. For a regular repo this is just
 * `repoPath/.git`. For a worktree-linked checkout the `.git` entry is a file
 * containing `gitdir: <abs-or-rel-path>` pointing at `<main-gitdir>/worktrees/<name>`,
 * which is where per-worktree refs (HEAD, index, MERGE_HEAD, ...) actually live.
 *
 * Returns the per-worktree gitdir plus the commondir (where shared refs live).
 * Falls back to `<repoPath>/.git` for both on any error so behavior matches
 * pre-worktree code paths.
 */
export function resolveGitDirs(repoPath: string): { gitDir: string; commonDir: string } {
  const dotGit = path.join(repoPath, '.git');
  let gitDir = dotGit;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf-8').trim();
      const m = content.match(/^gitdir:\s*(.+)$/);
      if (m) {
        const target = m[1].trim();
        gitDir = path.isAbsolute(target) ? target : path.resolve(repoPath, target);
      }
    }
  } catch {
    return { gitDir: dotGit, commonDir: dotGit };
  }
  // For a linked worktree, gitDir is <main>/worktrees/<name> and a `commondir`
  // file holds the path to the main gitdir (where refs/packed-refs/config live).
  let commonDir = gitDir;
  try {
    const commonFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonFile)) {
      const target = fs.readFileSync(commonFile, 'utf-8').trim();
      commonDir = path.isAbsolute(target) ? target : path.resolve(gitDir, target);
    }
  } catch {
    // ignore — commonDir already defaulted to gitDir
  }
  return { gitDir, commonDir };
}

/**
 * Classifies a filesystem change inside a git directory. Probes against both
 * the per-worktree gitDir and the shared commonDir so the classification works
 * regardless of which dir the changed path actually lives in.
 *
 * Return values:
 *   - 'refs'      — HEAD / refs/** / packed-refs / worktrees / config
 *   - 'status'    — index
 *   - 'operation' — MERGE_HEAD / REBASE_HEAD
 *   - 'unknown'   — anything else
 */
export function classifyPath(
  changedPath: string,
  gitDir: string,
  commonDir: string,
): 'refs' | 'status' | 'operation' | 'unknown' {
  const fromGitDir = path.relative(gitDir, changedPath);
  const fromCommonDir = path.relative(commonDir, changedPath);
  const relativePath = !fromGitDir.startsWith('..') ? fromGitDir : fromCommonDir;

  // Match the directory itself or a path inside it — `startsWith('refs')`
  // alone also matched siblings like `refspec` or `worktrees-foo`, triggering
  // spurious refresh classifications.
  const isInDir = (dir: string) => relativePath === dir || relativePath.startsWith(dir + path.sep);

  if (relativePath === 'HEAD' || isInDir('refs') || relativePath === 'packed-refs' || isInDir('worktrees')) {
    return 'refs';
  }
  if (relativePath === 'index') {
    return 'status';
  }
  if (relativePath === 'MERGE_HEAD' || relativePath === 'REBASE_HEAD') {
    return 'operation';
  }
  if (relativePath === 'config') {
    return 'refs';
  }
  return 'unknown';
}

/**
 * Whether a classified change type warrants a full graph/UI refresh.
 *
 * 'refs'    — HEAD / branches / tags moved → graph changed.
 * 'status'  — index or working-tree edit → the "Uncommitted changes" summary
 *             row and staged/unstaged counts must be re-rendered. Without this
 *             the top-of-graph summary goes stale until the next refs change.
 * 'unknown' — anything we couldn't classify; refresh to stay safe.
 *
 * 'operation' (MERGE_HEAD / REBASE_HEAD appearing) is intentionally excluded:
 * it does not move HEAD and is handled separately by the conflict-state probe.
 */
export function shouldRefreshGraph(what: string): boolean {
  return what === 'refs' || what === 'status' || what === 'unknown';
}
