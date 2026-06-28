import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitService } from '../../git-service';
import { TempRepo, commit, createTempRepo, head, runGit } from './helpers';

describe('GitService integration — bisect', () => {
  let repo: TempRepo;
  let svc: GitService;
  // A linear history where commit #3 is the "first bad". Each test rebuilds
  // it; bisect mutates HEAD heavily so we want strict isolation.
  let goodSha: string;
  let badSha: string;
  let culpritSha: string;

  beforeEach(() => {
    repo = createTempRepo();
    svc = new GitService(repo.path);

    // Build: g0 (good) → g1 → bad-introduced → g3 → g4 (bad)
    goodSha = commit(repo.path, 'g0', { 'f.txt': 'ok\n' });
    commit(repo.path, 'g1', { 'f.txt': 'ok\nline1\n' });
    culpritSha = commit(repo.path, 'introduce bug', { 'f.txt': 'BUG\nline1\n' });
    commit(repo.path, 'g3', { 'f.txt': 'BUG\nline1\nline2\n' });
    badSha = commit(repo.path, 'g4', { 'f.txt': 'BUG\nline1\nline2\nline3\n' });
  });
  afterEach(() => repo.cleanup());

  it('start + good + bad walks to the first-bad commit and bisectLog records it', async () => {
    await svc.bisectStart(badSha, goodSha);
    // After start with bad+good, git checks out the midpoint; we mark it good
    // because the bug isn't there yet (commits 'g1' = midpoint of 5).
    // To keep this deterministic regardless of git's midpoint pick, walk by
    // querying HEAD's subject and answering accordingly.
    for (let i = 0; i < 10; i++) {
      const subject = runGit(repo.path, ['log', '-1', '--format=%s']).trim();
      const hash = head(repo.path);
      if (hash === culpritSha || subject === 'introduce bug' || subject.startsWith('g3') || subject.startsWith('g4')) {
        // This commit (or anything after it) is bad.
        const out = await svc.bisectBad();
        if (/is the first bad commit/.test(out)) break;
      } else {
        const out = await svc.bisectGood();
        if (/is the first bad commit/.test(out)) break;
      }
    }

    // bisectLog should now mention the culprit.
    const log = await svc.bisectLog();
    expect(log).toContain(culpritSha.substring(0, 7));

    await svc.bisectReset();
  });

  it('bisectReset returns HEAD to the pre-bisect ref', async () => {
    const beforeHead = head(repo.path);
    await svc.bisectStart(badSha, goodSha);
    // Even mid-bisect, reset should restore.
    await svc.bisectReset();
    expect(head(repo.path)).toBe(beforeHead);
  });

  it('bisectSkip advances past the currently-checked-out commit', async () => {
    await svc.bisectStart(badSha, goodSha);
    const midHead = head(repo.path);
    await svc.bisectSkip();
    // After skip, HEAD should be on a different commit (git picked another
    // midpoint to test). The exact commit depends on git's internal walk.
    expect(head(repo.path)).not.toBe(midHead);
    await svc.bisectReset();
  });

  it('rejects refs starting with -', async () => {
    await expect(svc.bisectStart('-bad')).rejects.toThrow("must not start with '-'");
    await expect(svc.bisectGood('-good')).rejects.toThrow("must not start with '-'");
    await expect(svc.bisectBad('-bad')).rejects.toThrow("must not start with '-'");
  });
});
