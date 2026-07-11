// SNIPCODE-HOOK: whole-file — Snipcode-added ground-truth test (e2e strategy
// #18, audit P1-7): a multi-step mutation handler must keep acting on the
// repository it started on even when the user switches repos mid-flight, and
// the switch itself must be deferred until the transaction completes.
//
// Real GitService + real temp repos; only the VS Code panel/message transport
// is mocked. Deterministic timing comes from the git-shim: it blocks repo A's
// `stash push` until the test has injected a switchRepo(B) message.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const H = vi.hoisted(() => ({
  messageHandler: null as null | ((m: unknown) => unknown),
  repos: [] as Array<{ path: string; name: string; type: string }>,
  panel: null as null | { webview: { postMessage: ReturnType<typeof vi.fn> } },
}));

vi.mock('vscode', async () => (await import('./vscode-mock')).makeVscodeModule(H));

vi.mock('../../services/file-watcher', () => ({
  FileWatcher: class { enabled = true; suppress() {} dispose() {} },
}));
vi.mock('../../services/repo-discovery', () => ({
  RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos), clearCache: vi.fn() },
}));
vi.mock('../../git/vscode-git-bridge', () => ({ triggerVSCodeGitAuth: vi.fn(async () => false) }));

import { MainPanel } from '../MainPanel';
import { setGitBinaryPath } from '../../git/git-binary';
import { createGitShim, type GitShim } from '../../git/__tests__/integration/git-shim';
import {
  createTempRepo, commit, runGit, writeFile, type TempRepo,
} from '../../git/__tests__/integration/helpers';

const extUri = { fsPath: '/ext' } as unknown as import('vscode').Uri;

const isPosix = process.platform !== 'win32';
const d = isPosix ? describe : describe.skip; // shim is POSIX-only (strategy §2.2)

d('cross-repo mutation transaction (P1-7 ground truth)', () => {
  let bare: TempRepo;
  let repoA: TempRepo;
  let repoB: TempRepo;
  let shim: GitShim;

  beforeEach(() => {
    // repo A: one pushed commit + a dirty tracked file (auto-stash target).
    bare = createTempRepo({ bare: true });
    repoA = createTempRepo();
    commit(repoA.path, 'init A', { 'a.txt': 'base\n' });
    runGit(repoA.path, ['remote', 'add', 'origin', bare.path]);
    runGit(repoA.path, ['push', 'origin', 'main']);
    writeFile(repoA.path, 'a.txt', 'dirty working change\n');

    // repo B: one commit + one pre-existing user stash that must survive.
    repoB = createTempRepo();
    commit(repoB.path, 'init B', { 'b.txt': 'base\n' });
    writeFile(repoB.path, 'b.txt', 'user stashed change\n');
    runGit(repoB.path, ['stash', 'push', '-m', 'user stash']);

    shim = createGitShim({ subcommand: 'stash push', cwd: repoA.path });
    setGitBinaryPath(shim.path);

    H.repos = [
      { path: repoA.path, name: 'A', type: 'root' },
      { path: repoB.path, name: 'B', type: 'root' },
    ];
    (MainPanel as unknown as { currentPanel: unknown }).currentPanel = undefined;
    MainPanel.createOrShow(extUri, repoA.path);
  });

  afterEach(() => {
    setGitBinaryPath(null);
    shim?.cleanup();
    bare?.cleanup();
    repoA?.cleanup();
    repoB?.cleanup();
  });

  it('pull auto-stash keeps acting on repo A when the user switches to B mid-stash', async () => {
    const panel = MainPanel.currentPanel! as unknown as { repoPath: string; sendRepoList(): Promise<void> };
    await panel.sendRepoList(); // populate cachedRepos so switchRepo(B) passes the allow-list

    const stashOidB = runGit(repoB.path, ['rev-parse', 'stash@{0}']).trim();

    // Start the multi-step mutation: stash push (A) → pull (origin) → stash pop.
    const pullDone = H.messageHandler!({
      type: 'pull',
      payload: { remote: 'origin', branch: 'main', rebase: false, stash: true },
    }) as Promise<unknown>;

    // While A's `stash push` is blocked inside the shim, the user switches to B.
    await shim.waitForIntercept();
    const switchDone = H.messageHandler!({
      type: 'switchRepo',
      payload: { path: repoB.path },
    }) as Promise<unknown>;
    // Give the switch handler a chance to run before the stash completes —
    // without the transaction guard it swaps this.gitService immediately.
    await new Promise(r => setTimeout(r, 100));
    shim.release();

    await pullDone;
    await switchDone;

    // B's pre-existing stash is untouched: same single entry, same OID.
    const stashListB = runGit(repoB.path, ['stash', 'list']).trim().split('\n').filter(Boolean);
    expect(stashListB).toHaveLength(1);
    expect(runGit(repoB.path, ['rev-parse', 'stash@{0}']).trim()).toBe(stashOidB);
    // B's working tree was never mutated by the stray pop.
    expect(runGit(repoB.path, ['status', '--porcelain']).trim()).toBe('');

    // A completed its whole transaction: auto-stash was popped back, so the
    // dirty change is in the working tree again and A's stash list is empty.
    expect(runGit(repoA.path, ['stash', 'list']).trim()).toBe('');
    expect(runGit(repoA.path, ['status', '--porcelain'])).toMatch(/^ M a\.txt/m);

    // The requested switch still happened — after the transaction finished.
    expect(panel.repoPath).toBe(repoB.path);

    // And it happened AFTER the pull handler's terminal messages: the switch's
    // repoList(active=B) must not interleave before pull's operationComplete —
    // the transaction gate spans the whole handler, not just the git steps.
    const posts = H.panel!.webview.postMessage.mock.calls.map(c => c[0]) as Array<{
      type: string; payload?: { operation?: string; active?: string };
    }>;
    const pullCompleteIdx = posts.findIndex(m => m.type === 'operationComplete' && m.payload?.operation === 'pull');
    const switchIdx = posts.findIndex(m => m.type === 'repoList' && m.payload?.active === repoB.path);
    expect(pullCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(switchIdx).toBeGreaterThan(pullCompleteIdx);

    // Drain the queued follow-up refresh so no git spawn outlives the shim's
    // temp dir (cleanup would otherwise race it into a noisy ENOENT).
    const internals = panel as unknown as { refreshing: boolean; queuedRefreshDone: Promise<void> | null };
    const deadline = Date.now() + 5_000;
    while ((internals.refreshing || internals.queuedRefreshDone) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
  });
});
