import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveGitDirs, classifyPath, shouldRefreshGraph } from '../file-watcher-helpers';

describe('resolveGitDirs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fwh-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns <repo>/.git for a regular repo where .git is a directory', () => {
    const repo = join(root, 'regular');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const out = resolveGitDirs(repo);
    expect(out.gitDir).toBe(join(repo, '.git'));
    expect(out.commonDir).toBe(join(repo, '.git'));
  });

  it('resolves the per-worktree gitdir when .git is a file', () => {
    // Layout:
    //   <root>/main/.git/   (the main gitdir)
    //   <root>/main/.git/worktrees/feat/   (per-worktree gitdir)
    //   <root>/wt/.git                     (the file: "gitdir: <abs path>")
    const mainGit = join(root, 'main', '.git');
    const wtGitDir = join(mainGit, 'worktrees', 'feat');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, 'commondir'), mainGit + '\n');

    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ${wtGitDir}\n`);

    const out = resolveGitDirs(wt);
    expect(out.gitDir).toBe(wtGitDir);
    expect(out.commonDir).toBe(mainGit);
  });

  it('resolves a relative gitdir target in the .git file', () => {
    const mainGit = join(root, 'main', '.git');
    const wtGitDir = join(mainGit, 'worktrees', 'feat');
    mkdirSync(wtGitDir, { recursive: true });
    writeFileSync(join(wtGitDir, 'commondir'), '../..\n');

    const wt = join(root, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), `gitdir: ../main/.git/worktrees/feat\n`);

    const out = resolveGitDirs(wt);
    expect(out.gitDir).toBe(wtGitDir);
    expect(out.commonDir).toBe(mainGit);
  });

  it('falls back to <repo>/.git when nothing exists', () => {
    const missing = join(root, 'missing');
    const out = resolveGitDirs(missing);
    expect(out.gitDir).toBe(join(missing, '.git'));
    expect(out.commonDir).toBe(join(missing, '.git'));
  });
});

describe('classifyPath', () => {
  const gitDir = '/repo/.git';
  const commonDir = '/repo/.git';

  it('classifies HEAD as refs', () => {
    expect(classifyPath('/repo/.git/HEAD', gitDir, commonDir)).toBe('refs');
  });

  it('classifies refs/** as refs', () => {
    expect(classifyPath('/repo/.git/refs/heads/main', gitDir, commonDir)).toBe('refs');
    expect(classifyPath('/repo/.git/refs/tags/v1.0', gitDir, commonDir)).toBe('refs');
  });

  it('classifies packed-refs as refs', () => {
    expect(classifyPath('/repo/.git/packed-refs', gitDir, commonDir)).toBe('refs');
  });

  it('classifies config as refs (remote add/remove affects ref-display)', () => {
    expect(classifyPath('/repo/.git/config', gitDir, commonDir)).toBe('refs');
  });

  it('classifies worktrees/** as refs', () => {
    expect(classifyPath('/repo/.git/worktrees/feat/HEAD', gitDir, commonDir)).toBe('refs');
  });

  it('classifies index as status', () => {
    expect(classifyPath('/repo/.git/index', gitDir, commonDir)).toBe('status');
  });

  it('classifies MERGE_HEAD / REBASE_HEAD as operation', () => {
    expect(classifyPath('/repo/.git/MERGE_HEAD', gitDir, commonDir)).toBe('operation');
    expect(classifyPath('/repo/.git/REBASE_HEAD', gitDir, commonDir)).toBe('operation');
  });

  it('classifies anything else as unknown', () => {
    expect(classifyPath('/repo/.git/objects/aa/bb', gitDir, commonDir)).toBe('unknown');
    expect(classifyPath('/repo/.git/hooks/pre-commit', gitDir, commonDir)).toBe('unknown');
  });

  it('does not match siblings that merely share a prefix with refs/worktrees', () => {
    // `startsWith('refs')` used to also catch these.
    expect(classifyPath('/repo/.git/refspec', gitDir, commonDir)).toBe('unknown');
    expect(classifyPath('/repo/.git/worktrees-backup', gitDir, commonDir)).toBe('unknown');
  });

  it('uses commonDir when a path is outside gitDir (linked worktree case)', () => {
    // For a linked worktree: HEAD/index live in the worktree gitdir,
    // refs/config live in the main gitdir. classify should route both.
    const wtGit = '/main/.git/worktrees/feat';
    const main = '/main/.git';
    expect(classifyPath('/main/.git/worktrees/feat/HEAD', wtGit, main)).toBe('refs');
    expect(classifyPath('/main/.git/worktrees/feat/index', wtGit, main)).toBe('status');
    expect(classifyPath('/main/.git/refs/heads/main', wtGit, main)).toBe('refs');
    expect(classifyPath('/main/.git/config', wtGit, main)).toBe('refs');
  });
});

describe('shouldRefreshGraph', () => {
  it('refreshes on refs changes (HEAD / branches / tags moved)', () => {
    expect(shouldRefreshGraph('refs')).toBe(true);
  });

  it('refreshes on status changes so the uncommitted summary stays current', () => {
    // Regression guard: index / working-tree edits used to be ignored, leaving
    // the "Uncommitted changes (N)" row stale until the next refs change.
    expect(shouldRefreshGraph('status')).toBe(true);
  });

  it('refreshes on unknown changes to stay safe', () => {
    expect(shouldRefreshGraph('unknown')).toBe(true);
  });

  it('does NOT refresh on operation changes (handled by the conflict probe)', () => {
    expect(shouldRefreshGraph('operation')).toBe(false);
  });
});
