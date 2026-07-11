import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getWorkbenchStatus } from '../workbench-status';
import { TempRepo, commit, createTempRepo, runGit, writeFile } from '../../git/__tests__/integration/helpers';

const BASE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\n';
const CHANGED = 'a\nb2\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn2\no\np\n'; // two far-apart edits → 2 hunks

describe('getWorkbenchStatus (integration)', () => {
  let repoA: TempRepo;
  let repoB: TempRepo;
  beforeEach(() => {
    repoA = createTempRepo();
    repoB = createTempRepo();
    commit(repoA.path, 'base', { 'f.txt': BASE });
    commit(repoB.path, 'base', { 'g.txt': 'x\n' });
  });
  afterEach(() => { repoA.cleanup(); repoB.cleanup(); });

  it('groups changes per repo with hunk counts and change types', async () => {
    writeFile(repoA.path, 'f.txt', CHANGED);       // modified, 2 hunks
    writeFile(repoA.path, 'new.txt', 'hello\n');   // untracked new file
    // repoB: no changes

    const status = await getWorkbenchStatus([repoA.path, repoB.path]);

    const a = status.repos.find(r => r.repoPath === repoA.path)!;
    expect(a.files.map(f => f.path).sort()).toEqual(['f.txt', 'new.txt']);
    const f = a.files.find(x => x.path === 'f.txt')!;
    expect(f.changeType).toBe('M');
    expect(f.hunkCount).toBe(2);
    expect(f.hunkable).toBe(true);
    const n = a.files.find(x => x.path === 'new.txt')!;
    expect(n.hunkCount).toBe(1);   // whole new file = one hunk

    const b = status.repos.find(r => r.repoPath === repoB.path)!;
    expect(b.files).toEqual([]);
  });

  it('flags a dirty index and disables commit (D1)', async () => {
    writeFile(repoA.path, 'f.txt', CHANGED);
    writeFile(repoA.path, 'staged.txt', 'pre\n');
    runGit(repoA.path, ['add', 'staged.txt']);

    const status = await getWorkbenchStatus([repoA.path]);
    const a = status.repos[0];
    expect(a.indexDirty).toBe(true);
    expect(a.commitDisabledReason).toBeTruthy();
  });

  it('flags an in-progress operation and disables commit (D4)', async () => {
    // Park a merge conflict so MERGE_HEAD exists.
    runGit(repoA.path, ['checkout', '-b', 'l']);
    writeFile(repoA.path, 'f.txt', 'left\n'); runGit(repoA.path, ['commit', '-am', 'l']);
    runGit(repoA.path, ['checkout', 'main']);
    writeFile(repoA.path, 'f.txt', 'right\n'); runGit(repoA.path, ['commit', '-am', 'r']);
    expect(() => runGit(repoA.path, ['merge', 'l'])).toThrow();

    const status = await getWorkbenchStatus([repoA.path]);
    expect(status.repos[0].operationState).toBe('merge');
    expect(status.repos[0].commitDisabledReason).toContain('merge');
  });
});
