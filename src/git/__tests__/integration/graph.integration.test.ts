import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { buildFullGraph } from '../../git-graph-builder';
import { TempRepo, commit, createTempRepo, runGit } from './helpers';

/**
 * End-to-end pipeline: real `git log` output → parser → graph builder.
 * Verifies layout invariants on representative repository topologies.
 */
describe('Graph pipeline integration', () => {
  let repo: TempRepo;
  let svc: GitService;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);
  });
  afterEach(() => repo.cleanup());

  it('produces one dot and zero links for a linear chain', async () => {
    commit(repo.path, 'c1');
    commit(repo.path, 'c2');
    commit(repo.path, 'c3');
    const commits = await svc.log();
    const branches = await svc.branches();
    const g = buildFullGraph(commits, branches);

    expect(g.dots.length).toBe(commits.length);
    expect(g.links.length).toBe(0); // linear chain has no merge links
    expect(g.commitLeftMargin.length).toBe(commits.length);
    // Every dot sits at the same x for a single-rail chain.
    const xs = new Set(g.dots.map(d => d.center.x));
    expect(xs.size).toBe(1);
  });

  it('renders a merge dot and at least two rails for a merge commit', async () => {
    commit(repo.path, 'base', { 'base.txt': 'b\n' });
    runGit(repo.path, ['checkout', '-b', 'feature']);
    commit(repo.path, 'feature 1', { 'f1.txt': '1\n' });
    commit(repo.path, 'feature 2', { 'f2.txt': '2\n' });
    runGit(repo.path, ['checkout', 'main']);
    commit(repo.path, 'main 2', { 'm2.txt': '2\n' });
    runGit(repo.path, ['merge', '--no-ff', '-m', 'merge', 'feature']);
    // Add a non-merge commit on top so the merge isn't HEAD — the builder
    // tags HEAD-tip dots as 'head' which would mask the merge classification.
    commit(repo.path, 'after merge', { 'after.txt': 'x\n' });

    const commits = await svc.log();
    const branches = await svc.branches();
    const g = buildFullGraph(commits, branches);

    expect(g.dots.length).toBe(commits.length);
    // The merge commit gets a dedicated 'merge' classification.
    const mergeIdx = commits.findIndex(c => c.parents.length === 2);
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(g.dots[mergeIdx].type).toBe('merge');
    // The feature branch path is created at the merge → at least one extra
    // rail beyond main exists. (Links only show up for *re-converging* rails
    // already alive in `unsolved`; a fresh merge parent gets its own path.)
    expect(g.paths.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps dot order aligned to commit order (regression for slice-based filter)', async () => {
    // The webview takes `dots.slice(startIndex, endIndex)` as the visible
    // subset, which only works if dots[i] corresponds to commits[i]. Guard
    // against any future builder change that breaks that 1:1 alignment.
    for (let i = 0; i < 8; i++) commit(repo.path, `c${i}`);
    const commits = await svc.log();
    const branches = await svc.branches();
    const g = buildFullGraph(commits, branches);

    expect(g.dots.length).toBe(commits.length);
    // dots[i].center.y === i + 0.5 by builder construction (offsetY starts
    // at -0.5 and increments by UNIT_H=1 per commit).
    for (let i = 0; i < commits.length; i++) {
      expect(g.dots[i].center.y).toBeCloseTo(i + 0.5, 5);
    }
  });

  it('marks HEAD-tip dot as head and remote-only commits accordingly', async () => {
    // No remote, so we only test the head marker here.
    commit(repo.path, 'c1');
    commit(repo.path, 'c2');
    const commits = await svc.log();
    const branches = await svc.branches();
    const g = buildFullGraph(commits, branches);

    // Newest commit should be the head.
    expect(g.dots[0].type).toBe('head');
  });

  it('handles diamond topology (two branches that re-converge)', async () => {
    commit(repo.path, 'A', { 'a.txt': 'a\n' });
    runGit(repo.path, ['checkout', '-b', 'left']);
    commit(repo.path, 'L', { 'left.txt': 'l\n' });
    runGit(repo.path, ['checkout', '-b', 'right', 'main']);
    commit(repo.path, 'R', { 'right.txt': 'r\n' });
    runGit(repo.path, ['checkout', 'main']);
    runGit(repo.path, ['merge', '--no-ff', '-m', 'M-left', 'left']);
    runGit(repo.path, ['merge', '--no-ff', '-m', 'M-right', 'right']);

    const commits = await svc.log();
    const branches = await svc.branches();
    const g = buildFullGraph(commits, branches);

    // Two merge commits expected
    const merges = commits.filter(c => c.parents.length === 2);
    expect(merges.length).toBe(2);

    // commitLeftMargin should be monotonically reasonable (no negative values)
    for (const m of g.commitLeftMargin) {
      expect(m).toBeGreaterThan(0);
    }
  });
});
