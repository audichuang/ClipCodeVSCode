import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// MainPanel hosts the webview and routes ~80 message types to GitService. We
// can't run a real WebviewPanel, but with a vscode mock (panel + webview) and a
// controllable GitService we can capture the onDidReceiveMessage handler and
// assert the routing, refresh, sequence-guard, and error-handling behaviour.
const H = vi.hoisted(() => {
  const git: Record<string, ReturnType<typeof vi.fn>> = {
    log: vi.fn(async () => []),
    branches: vi.fn(async () => []),
    tags: vi.fn(async () => []),
    remotes: vi.fn(async () => []),
    stashList: vi.fn(async () => []),
    worktreeList: vi.fn(async () => []),
    merge: vi.fn(async () => {}),
    fastForwardRef: vi.fn(async () => {}),
    stashPop: vi.fn(async () => {}),
    showCommitDiff: vi.fn(async () => []),
    showCommitFiles: vi.fn(async () => []),
    getUncommittedDiff: vi.fn(async () => ({ staged: [], unstaged: [] })),
    resolveDiffBaseRef: vi.fn(async () => 'parentsha'),
    getConflictFiles: vi.fn(async () => []),
    getOperationState: vi.fn(async () => ({ type: null })),
    getRemoteUrl: vi.fn(async () => ''),
    stashSave: vi.fn(async () => {}),
    checkout: vi.fn(async () => {}),
    pull: vi.fn(async () => {}),
    clean: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    setWarningHandler: vi.fn(),
    setAuthRetryHandler: vi.fn(),
    setExtraEnv: vi.fn(),
    setDefaultTimeout: vi.fn(),
  };
  return {
    git,
    messageHandler: null as null | ((m: unknown) => unknown),
    panel: null as null | { webview: { postMessage: ReturnType<typeof vi.fn> } },
    repos: [] as Array<{ path: string; name: string; type: string }>,
  };
});

/* SNIPCODE-HOOK start: shared vscode mock (see vscode-mock.ts) */
vi.mock('vscode', async () => (await import('./vscode-mock')).makeVscodeModule(H, {
  workspaceFolders: [{ uri: { fsPath: '/repo' } }],
}));
/* SNIPCODE-HOOK end */

vi.mock('../../git/git-service', async (orig) => {
  const actual = await orig<typeof import('../../git/git-service')>();
  return { ...actual, GitService: vi.fn(() => H.git) };
});
vi.mock('../../services/file-watcher', () => ({ FileWatcher: class { enabled = true; suppress() {} dispose() {} } }));
vi.mock('../../services/repo-discovery', () => ({ RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos), clearCache: vi.fn() } }));
vi.mock('../../git/vscode-git-bridge', () => ({ triggerVSCodeGitAuth: vi.fn(async () => false) }));

import { MainPanel } from '../MainPanel';
import { GitError } from '../../git/git-service';

const extUri = { fsPath: '/ext' } as unknown as import('vscode').Uri;

function posted() {
  return (H.panel!.webview.postMessage.mock.calls.map(c => c[0])) as Array<{ type: string; payload?: Record<string, unknown> }>;
}
function postedOfType(type: string) {
  return posted().filter(m => m.type === type);
}
async function dispatch(msg: unknown) {
  await H.messageHandler!(msg);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default git behaviour after clearAllMocks wiped implementations.
  for (const k of Object.keys(H.git)) H.git[k].mockReset();
  H.git.log.mockResolvedValue([]);
  H.git.branches.mockResolvedValue([]);
  H.git.tags.mockResolvedValue([]);
  H.git.remotes.mockResolvedValue([]);
  H.git.stashList.mockResolvedValue([]);
  H.git.worktreeList.mockResolvedValue([]);
  H.git.getOperationState.mockResolvedValue({ type: null });
  H.git.getConflictFiles.mockResolvedValue([]);
  H.git.getRemoteUrl.mockResolvedValue('');
  H.git.showCommitDiff.mockResolvedValue([]);
  H.git.getUncommittedDiff.mockResolvedValue({ staged: [], unstaged: [] });
  H.repos = [{ path: '/repo', name: 'repo', type: 'root' }];
  (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
  MainPanel.createOrShow(extUri, '/repo');
});

afterEach(() => {
  (MainPanel.currentPanel as unknown as { dispose?: () => void } | undefined)?.dispose?.();
  (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
});

const commit = (hash: string) => ({
  hash, abbreviatedHash: hash.slice(0, 7), subject: 's', body: '', parents: [], refs: [],
  author: { name: '', email: '', date: '' }, committer: { name: '', email: '', date: '' },
});

describe('MainPanel construction', () => {
  it('creates a webview panel, sets its html, and posts the locale', () => {
    expect(H.panel).not.toBeNull();
    expect(H.panel!.webview).toBeDefined();
    expect(postedOfType('setLocale').length).toBeGreaterThan(0);
  });
});

describe('MainPanel message routing', () => {
  it('getLog fetches log + branches and posts logData', async () => {
    H.git.log.mockResolvedValue([commit('aaaaaaa1'), commit('bbbbbbb2')]);
    await dispatch({ type: 'getLog', payload: {} });
    expect(H.git.log).toHaveBeenCalled();
    expect(H.git.branches).toHaveBeenCalled();
    const data = postedOfType('logData').at(-1)!;
    expect((data.payload!.commits as unknown[]).length).toBe(2);
    expect(data.payload!.hasMore).toBe(false);
  });

  it('getLog reports hasMore and trims to the requested limit', async () => {
    // Requesting limit 1 fetches limit+1; returning 2 means "there is more".
    H.git.log.mockResolvedValue([commit('a1'), commit('b2')]);
    await dispatch({ type: 'getLog', payload: { limit: 1 } });
    const data = postedOfType('logData').at(-1)!;
    expect(data.payload!.hasMore).toBe(true);
    expect((data.payload!.commits as unknown[]).length).toBe(1);
  });

  it('getLog does not count uncommitted or stash rows toward the page boundary', async () => {
    const stash = { ...commit('stash123'), refs: [{ type: 'stash' as const, name: 'stash@{0}' }] };
    H.git.log.mockResolvedValue([
      { ...commit('UNCOMMITTED'), subject: 'Uncommitted changes (1)' },
      stash,
      commit('aaaaaaa1'),
      commit('bbbbbbb2'),
    ]);

    await dispatch({ type: 'getLog', payload: { limit: 2 } });

    const data = postedOfType('logData').at(-1)!;
    expect(data.payload!.hasMore).toBe(false);
    expect((data.payload!.commits as Array<{ hash: string }>).map(c => c.hash)).toEqual([
      'UNCOMMITTED',
      'stash123',
      'aaaaaaa1',
      'bbbbbbb2',
    ]);
  });

  it('openDiff for a commit builds the left URI from the resolved parent SHA, not the ~1 shorthand', async () => {
    const vscode = await import('vscode');
    H.git.resolveDiffBaseRef.mockResolvedValue('1111111111111111111111111111111111111111');

    await dispatch({ type: 'openDiff', payload: { file: 'doc.md', commitHash: '2222222' } });

    expect(H.git.resolveDiffBaseRef).toHaveBeenCalledWith('2222222');
    const diffCall = (vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls
      .find(c => c[0] === 'vscode.diff')!;
    expect(diffCall).toBeDefined();
    const leftUri = diffCall[1] as { query: string };
    const leftRef = JSON.parse(leftUri.query).ref;
    expect(leftRef).toBe('1111111111111111111111111111111111111111');
    expect(leftRef).not.toContain('~1');
  });

  /* SNIPCODE-HOOK start: ui/diff D3/X3 rename-aware pathspec */
  it('openDiff for a renamed file resolves the LEFT (parent) URI from oldPath, not the new path', async () => {
    const vscode = await import('vscode');
    H.git.resolveDiffBaseRef.mockResolvedValue('1111111111111111111111111111111111111111');

    await dispatch({ type: 'openDiff', payload: { file: 'new.ts', commitHash: '2222222', oldPath: 'old.ts' } });

    const diffCall = (vscode.commands.executeCommand as ReturnType<typeof vi.fn>).mock.calls
      .find(c => c[0] === 'vscode.diff')!;
    const leftUri = diffCall[1] as { query: string };
    expect(JSON.parse(leftUri.query).path).toMatch(/old\.ts$/);
    const rightUri = diffCall[2] as { query: string };
    expect(JSON.parse(rightUri.query).path).toMatch(/new\.ts$/);
  });
  /* SNIPCODE-HOOK end */

  it('getBranches posts branchData with all the sidebar collections', async () => {
    await dispatch({ type: 'getBranches' });
    const data = postedOfType('branchData').at(-1)!;
    expect(data.payload).toHaveProperty('branches');
    expect(data.payload).toHaveProperty('tags');
    expect(data.payload).toHaveProperty('worktrees');
  });

  it('getCommitDiff posts the file list for the commit', async () => {
    H.git.showCommitFiles.mockResolvedValue([{ path: 'a.ts', status: 'M' }]);
    await dispatch({ type: 'getCommitDiff', payload: { hash: 'h1' } });
    expect(H.git.showCommitFiles).toHaveBeenCalledWith('h1');
    const data = postedOfType('commitDiffData').at(-1)!;
    expect(data.payload!.hash).toBe('h1');
  });

  it('getCommitFilesForCopy posts commitFilesForCopy echoing the requestId, off the commit-details channel', async () => {
    H.git.showCommitFiles.mockResolvedValue([{ path: 'a.ts', status: 'M', oldPath: 'b.ts' }]);
    await dispatch({ type: 'getCommitFilesForCopy', payload: { hash: 'h7', requestId: 'gcopy-1' } });
    expect(H.git.showCommitFiles).toHaveBeenCalledWith('h7');
    // dedicated channel: responds with commitFilesForCopy, not commitDiffData
    expect(postedOfType('commitDiffData')).toHaveLength(0);
    const data = postedOfType('commitFilesForCopy').at(-1)!;
    expect(data.payload).toMatchObject({
      hash: 'h7',
      requestId: 'gcopy-1',
      files: [{ path: 'a.ts', status: 'M', oldPath: 'b.ts' }],
    });
  });

  it('merge calls GitService.merge then refreshes the whole view', async () => {
    await dispatch({ type: 'merge', payload: { branch: 'feature' } });
    expect(H.git.merge).toHaveBeenCalledWith('feature', expect.anything());
    expect(postedOfType('operationComplete').length).toBeGreaterThan(0);
    expect(postedOfType('fullRefresh').length).toBeGreaterThan(0);
  });

  it('checkout with stash stashes before checking out', async () => {
    await dispatch({ type: 'checkout', payload: { ref: 'main', stash: true } });
    expect(H.git.stashSave).toHaveBeenCalled();
    expect(H.git.checkout).toHaveBeenCalledWith('main', expect.anything());
  });

  it('rejects switchRepo to a path outside the discovered repo list', async () => {
    await new Promise(r => setTimeout(r, 0)); // let sendRepoList populate cachedRepos
    await dispatch({ type: 'switchRepo', payload: { path: '/somewhere/else' } });
    expect(postedOfType('error').length).toBeGreaterThan(0);
  });
});

describe('MainPanel error handling', () => {
  it('posts notGitRepo when git reports "not a git repository"', async () => {
    H.git.log.mockRejectedValue(new GitError('fatal: not a git repository', 128, ['log']));
    await dispatch({ type: 'getLog', payload: {} });
    expect(postedOfType('notGitRepo').length).toBeGreaterThan(0);
  });

  it('surfaces a plain error when a mutation fails without a conflict', async () => {
    H.git.merge.mockRejectedValue(new GitError('fatal: some failure', 1, ['merge']));
    H.git.getConflictFiles.mockResolvedValue([]);
    await dispatch({ type: 'merge', payload: { branch: 'x' } });
    expect(postedOfType('error').length).toBeGreaterThan(0);
  });

  it('posts conflictData when a failing mutation leaves conflicted files', async () => {
    H.git.merge.mockRejectedValue(new GitError('CONFLICT', 1, ['merge']));
    H.git.getConflictFiles.mockResolvedValue(['a.ts']);
    H.git.getOperationState.mockResolvedValue({ type: 'merge' });
    await dispatch({ type: 'merge', payload: { branch: 'x' } });
    const data = postedOfType('conflictData').at(-1)!;
    expect(data.payload!.operation).toBe('merge');
    expect((data.payload!.files as unknown[]).length).toBe(1);
  });

  it('posts an error when the post-operation refresh fails', async () => {
    H.git.log.mockRejectedValue(new GitError('fatal: refresh blew up', 1, ['log']));
    await dispatch({ type: 'merge', payload: { branch: 'feature' } });

    expect(postedOfType('operationComplete').length).toBeGreaterThan(0);
    const err = postedOfType('error').at(-1)!;
    expect(err.payload!.message).toContain('refresh blew up');
  });

  // Reads are NOT in MUTATION_TRANSACTION_TYPES, so a repo switch can still
  // land while one is in flight — the catch's isCurrentRepoSnapshot guard is
  // what protects that path from probing the new repo's conflict state.
  it('does not probe the new repo for conflicts when an ungated read fails after a repo switch', async () => {
    H.repos = [
      { path: '/repo', name: 'repo', type: 'root' },
      { path: '/repo-b', name: 'repo-b', type: 'nested' },
    ];
    await dispatch({ type: 'getRepoList' });

    let rejectLog!: (e: unknown) => void;
    H.git.log.mockImplementationOnce(() => new Promise((_, rej) => { rejectLog = rej; }));
    H.git.getConflictFiles.mockClear();

    const logRequest = dispatch({ type: 'getLog', payload: {} });
    await dispatch({ type: 'switchRepo', payload: { path: '/repo-b' } });
    rejectLog(new GitError('CONFLICT', 1, ['log']));
    await logRequest;

    // The conflict probe would run against repo-b's service — it must be
    // skipped, and no conflictData for the wrong repo may reach the webview.
    expect(postedOfType('conflictData')).toHaveLength(0);
    expect(H.git.getConflictFiles).not.toHaveBeenCalled();
    const err = postedOfType('error').at(-1)!;
    expect(err.payload!.message).toBeTruthy();
  });

  // Transaction-gated ops (audit P1-7): the switch must DEFER instead — the
  // whole handler, conflict probing included, runs against the original repo.
  it('defers a repo switch until a failing gated op finishes conflict handling', async () => {
    H.repos = [
      { path: '/repo', name: 'repo', type: 'root' },
      { path: '/repo-b', name: 'repo-b', type: 'nested' },
    ];
    await dispatch({ type: 'getRepoList' });

    let rejectMerge!: (e: unknown) => void;
    H.git.merge.mockImplementationOnce(() => new Promise((_, rej) => { rejectMerge = rej; }));
    H.git.getConflictFiles.mockResolvedValue(['a.ts']);
    H.git.getOperationState.mockResolvedValue({ type: 'merge' });

    const mergeRequest = dispatch({ type: 'merge', payload: { branch: 'feature' } });
    const switchRequest = dispatch({ type: 'switchRepo', payload: { path: '/repo-b' } });
    await new Promise(r => setTimeout(r, 0));
    // Gate held: the switch has not landed while the merge is in flight.
    expect(postedOfType('repoList').some(m => m.payload!.active === '/repo-b')).toBe(false);

    rejectMerge(new GitError('CONFLICT', 1, ['merge']));
    await mergeRequest;
    await switchRequest;

    // Conflict handling ran (against the original repo — the switch was
    // deferred), and the switch landed only after the handler finished.
    expect(H.git.getConflictFiles).toHaveBeenCalled();
    const posts = posted();
    const conflictIdx = posts.findIndex(m => m.type === 'conflictData');
    const switchIdx = posts.findIndex(m => m.type === 'repoList' && m.payload?.active === '/repo-b');
    expect(conflictIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeGreaterThan(conflictIdx);
  });
});

// These cover the non-trivial orchestration the simpler route+post+refresh
// cases don't: stash/pop recovery, no-op detection, and the stale-response
// sequence guard. The rest of the ~80 message cases mirror `merge` and aren't
// worth duplicating.
describe('MainPanel orchestration logic', () => {
  it('fastForward (checkout path) stashes, checks out, ff-merges, then pops', async () => {
    await dispatch({ type: 'fastForward', payload: { local: 'main', remote: 'origin/main', stash: true } });
    expect(H.git.stashSave).toHaveBeenCalled();
    expect(H.git.checkout).toHaveBeenCalledWith('main', {});
    expect(H.git.merge).toHaveBeenCalledWith('origin/main', { ffOnly: true });
    expect(H.git.stashPop).toHaveBeenCalledWith(0);
    expect(postedOfType('operationComplete').length).toBeGreaterThan(0);
  });

  it('fastForward surfaces an error when the post-merge stash pop fails', async () => {
    H.git.stashPop.mockRejectedValueOnce(new Error('pop conflict'));
    await dispatch({ type: 'fastForward', payload: { local: 'main', remote: 'origin/main', stash: true } });
    const err = postedOfType('error').at(-1)!;
    expect(err.payload!.message).toBe('stashPopAfterFastForwardFailed');
  });

  it('pull with stash pops afterwards and surfaces a failed pop', async () => {
    H.git.pull = vi.fn(async () => '');
    H.git.stashPop.mockRejectedValueOnce(new Error('pop conflict'));
    await dispatch({ type: 'pull', payload: { stash: true } });
    expect(H.git.stashSave).toHaveBeenCalled();
    expect(H.git.pull).toHaveBeenCalled();
    expect(postedOfType('error').at(-1)!.payload!.message).toBe('stashPopAfterPullFailed');
  });

  it('stashSave reports "no changes" when the stash count does not grow', async () => {
    H.git.stashList.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // before == after
    await dispatch({ type: 'stashSave', payload: {} });
    expect(postedOfType('error').at(-1)!.payload!.message).toBe('noChangesToStash');
  });

  it('stashSave confirms success when a new stash entry appears', async () => {
    H.git.stashList
      .mockResolvedValueOnce([])                    // before
      .mockResolvedValueOnce([{ index: 0 }] as never); // after
    await dispatch({ type: 'stashSave', payload: { message: 'wip' } });
    expect(H.git.stashSave).toHaveBeenCalled();
    expect(postedOfType('operationComplete').some(m => m.payload!.operation === 'stashSave')).toBe(true);
  });

  it('drops a stale file-diff response so a slower earlier request cannot clobber a newer one', async () => {
    let resolveFirst!: (v: unknown) => void;
    H.git.showCommitDiff
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r as (v: unknown) => void; }))
      .mockResolvedValueOnce([{ file: 'b.ts', hunks: [] }] as never);

    const p1 = dispatch({ type: 'getFileDiff', payload: { hash: 'h', file: 'a.ts' } });
    const p2 = dispatch({ type: 'getFileDiff', payload: { hash: 'h', file: 'b.ts' } });
    await p2; // newest request resolves and is delivered
    resolveFirst([{ file: 'a.ts', hunks: [] }]); // older request resolves late
    await p1;

    const diffs = postedOfType('fileDiffData');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].payload!.file).toBe('b.ts');
  });

  /* SNIPCODE-HOOK start: ui/diff D3/X3 rename-aware pathspec */
  it('getFileDiff forwards oldPath to showCommitDiff so a rename can be paired', async () => {
    H.git.showCommitDiff.mockResolvedValueOnce([{ file: 'new.ts', hunks: [], oldPath: 'old.ts' }] as never);
    await dispatch({ type: 'getFileDiff', payload: { hash: 'h', file: 'new.ts', oldPath: 'old.ts' } });
    expect(H.git.showCommitDiff).toHaveBeenCalledWith('h', 'new.ts', 'old.ts');
  });
  /* SNIPCODE-HOOK end */

  it('discards a stale getLog from the previous repo after switching repos', async () => {
    // Two repos so the switchRepo allow-list check passes.
    H.repos = [
      { path: '/repo', name: 'repo', type: 'root' },
      { path: '/repo-b', name: 'repo-b', type: 'nested' },
    ];
    await dispatch({ type: 'getRepoList' }); // populate cachedRepos

    // First getLog (against the old repo) is held in-flight; later log() calls
    // (the switch's refreshAll + the new repo's getLog) return the new commits.
    let resolveOld!: (v: unknown) => void;
    H.git.log
      .mockImplementationOnce(() => new Promise(r => { resolveOld = r as (v: unknown) => void; }))
      .mockResolvedValue([commit('bbbbbbb2')] as never);

    const pOld = dispatch({ type: 'getLog', payload: {} }); // old repo, in-flight

    // Switching must not reset the sequence counter, or the next getLog reuses
    // the same seq number and the stale in-flight response sneaks past the guard.
    await dispatch({ type: 'switchRepo', payload: { path: '/repo-b' } });
    await dispatch({ type: 'getLog', payload: {} }); // new repo

    // The old repo's log resolves late with its (foreign) commits.
    resolveOld([commit('aaaaaaa1')]);
    await pOld;

    const logs = postedOfType('logData');
    const lastCommits = logs.at(-1)!.payload!.commits as Array<{ hash: string }>;
    expect(lastCommits.map(c => c.hash)).toEqual(['bbbbbbb2']);
    // The foreign commit from the old repo must never reach the webview.
    expect(logs.some(l => (l.payload!.commits as Array<{ hash: string }>).some(c => c.hash === 'aaaaaaa1'))).toBe(false);
  });

  it('discards stale branch sidebar data from the previous repo after switching repos', async () => {
    H.repos = [
      { path: '/repo', name: 'repo', type: 'root' },
      { path: '/repo-b', name: 'repo-b', type: 'nested' },
    ];
    await dispatch({ type: 'getRepoList' });
    H.panel!.webview.postMessage.mockClear();

    let resolveOldBranches!: (v: unknown) => void;
    H.git.branches
      .mockImplementationOnce(() => new Promise(r => { resolveOldBranches = r as (v: unknown) => void; }))
      .mockResolvedValue([{ name: 'new-main', current: true, ahead: 0, behind: 0, hash: 'b' }] as never);

    const oldRequest = dispatch({ type: 'getBranches' });
    await dispatch({ type: 'switchRepo', payload: { path: '/repo-b' } });

    resolveOldBranches([{ name: 'old-main', current: true, ahead: 0, behind: 0, hash: 'a' }]);
    await oldRequest;

    expect(postedOfType('branchData')).toHaveLength(0);
    const full = postedOfType('fullRefresh').at(-1)!;
    const branches = (full.payload!.branchData as { branches: Array<{ name: string }> }).branches;
    expect(branches.map(b => b.name)).toEqual(['new-main']);
  });

  it('refreshAll applies the saved filter before the first getLog so it does not flash the full unfiltered graph', async () => {
    const M = MainPanel as unknown as { savedRemoteFilter?: string[]; savedBranchFilter?: string[] };
    const prevRemote = M.savedRemoteFilter;
    const prevBranch = M.savedBranchFilter;
    M.savedRemoteFilter = ['origin'];
    M.savedBranchFilter = ['main'];
    try {
      H.git.log.mockResolvedValue([commit('aaaaaaa1')] as never);

      // An early refresh (file watcher / repo auto-switch / config change) can
      // fire before the webview's first getLog establishes the session filter.
      await (MainPanel.currentPanel as unknown as { refreshAll(): Promise<void> }).refreshAll();

      const logArgs = H.git.log.mock.calls.at(-1)![0] as { remoteFilter?: unknown; branches?: unknown };
      expect(logArgs.remoteFilter).toEqual(['origin']);
      expect(logArgs.branches).toEqual(['main']);

      // The graph payload must carry the same filter the webview will keep.
      const refresh = postedOfType('fullRefresh').at(-1)!;
      const logData = (refresh.payload as { logData: { remoteFilter?: unknown; branches?: unknown } }).logData;
      expect(logData.remoteFilter).toEqual(['origin']);
      expect(logData.branches).toEqual(['main']);
    } finally {
      M.savedRemoteFilter = prevRemote;
      M.savedBranchFilter = prevBranch;
    }
  });

  it('initial refresh uses the configured initial count before any getLog request', async () => {
    H.git.log.mockResolvedValue([commit('aaaaaaa1')] as never);

    await (MainPanel.currentPanel as unknown as { refreshAll(): Promise<void> }).refreshAll();

    const logArgs = H.git.log.mock.calls.at(-1)![0] as { limit?: number };
    expect(logArgs.limit).toBe(201);
    const refresh = postedOfType('fullRefresh').at(-1)!;
    const logData = (refresh.payload as { logData: { currentLimit?: number } }).logData;
    expect(logData.currentLimit).toBe(200);
  });

  it('status refresh reuses the cached graph instead of re-running a large paged log', async () => {
    H.git.log.mockResolvedValue([commit('aaaaaaa1'), commit('bbbbbbb2')] as never);
    await dispatch({ type: 'getLog', payload: { limit: 5000 } });
    H.panel!.webview.postMessage.mockClear();
    H.git.log.mockClear();
    H.git.branches.mockClear();
    H.git.getUncommittedDiff.mockResolvedValue({
      staged: [{ path: 'staged.ts', status: 'M' }],
      unstaged: [{ path: 'unstaged.ts', status: 'M' }],
    });

    await (MainPanel.currentPanel as unknown as { refreshAll(scope: 'status'): Promise<void> }).refreshAll('status');

    expect(H.git.log).not.toHaveBeenCalled();
    expect(H.git.branches).not.toHaveBeenCalled();
    const data = postedOfType('logData').at(-1)!;
    expect((data.payload!.commits as Array<{ hash: string; subject: string }>).map(c => c.hash)).toEqual([
      'UNCOMMITTED',
      'aaaaaaa1',
      'bbbbbbb2',
    ]);
    expect((data.payload!.commits as Array<{ hash: string; subject: string }>)[0].subject).toBe('Uncommitted changes (2)');
  });

  /* SNIPCODE-HOOK start: X4 — status refresh must thread UNCOMMITTED onto HEAD */
  it('status refresh links UNCOMMITTED to the HEAD commit\'s full hash (X4), not a dangling root', async () => {
    H.git.log.mockResolvedValue([
      { ...commit('aaaaaaa1'), refs: [{ type: 'head' as const, name: 'main' }] },
      commit('bbbbbbb2'),
    ] as never);
    await dispatch({ type: 'getLog', payload: { limit: 5000 } });
    H.panel!.webview.postMessage.mockClear();
    H.git.getUncommittedDiff.mockResolvedValue({
      staged: [{ path: 'staged.ts', status: 'M' }],
      unstaged: [],
    });

    await (MainPanel.currentPanel as unknown as { refreshAll(scope: 'status'): Promise<void> }).refreshAll('status');

    const data = postedOfType('logData').at(-1)!;
    const uncommitted = (data.payload!.commits as Array<{ hash: string; parents: string[] }>)[0];
    expect(uncommitted.hash).toBe('UNCOMMITTED');
    expect(uncommitted.parents).toEqual(['aaaaaaa1']);
  });

  it('status refresh falls back to a dangling root when HEAD is not in the cached log', async () => {
    // Neither cached commit carries a `head` ref (e.g. HEAD fell outside a
    // branch-filtered window) — pointing UNCOMMITTED at a hash the builder
    // cannot resolve would be worse than the previous dangling-root shape.
    H.git.log.mockResolvedValue([commit('aaaaaaa1'), commit('bbbbbbb2')] as never);
    await dispatch({ type: 'getLog', payload: { limit: 5000 } });
    H.panel!.webview.postMessage.mockClear();
    H.git.getUncommittedDiff.mockResolvedValue({
      staged: [{ path: 'staged.ts', status: 'M' }],
      unstaged: [],
    });

    await (MainPanel.currentPanel as unknown as { refreshAll(scope: 'status'): Promise<void> }).refreshAll('status');

    const data = postedOfType('logData').at(-1)!;
    const uncommitted = (data.payload!.commits as Array<{ hash: string; parents: string[] }>)[0];
    expect(uncommitted.hash).toBe('UNCOMMITTED');
    expect(uncommitted.parents).toEqual([]);
  });
  /* SNIPCODE-HOOK end */
});
