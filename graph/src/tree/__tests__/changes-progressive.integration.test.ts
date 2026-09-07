// SNIPCODE-HOOK: whole-file — deterministic race test for the Changes tree's
// progressive first paint: with one repo's `git status` blocked (git-shim), the
// repos that answered must reach the tree before the blocked one is released,
// and the final paint must list every repo in discovery order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const H = vi.hoisted(() => ({ root: '' }));

vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Array<(v: unknown) => void> = [];
    event = (l: (v: unknown) => void) => { this.listeners.push(l); return { dispose() {} }; };
    fire(v?: unknown) { this.listeners.forEach((l) => l(v)); }
  }
  class TreeItem { description?: string; constructor(public label: unknown, public collapsibleState?: unknown) {} }
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (p: string) => ({ fsPath: p, with(o: object) { return { ...this, ...o }; } }) },
    window: { withProgress: vi.fn(async (_o: unknown, task: () => Promise<void>) => task()) },
    workspace: { get workspaceFolders() { return [{ uri: { fsPath: H.root } }]; } },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose() {} })) },
    l10n: { t: (s: string) => s },
  };
});
vi.mock('../../git/vscode-git-bridge', () => ({ triggerVSCodeGitAuth: vi.fn(async () => false) }));
vi.mock('../../utils/config', () => ({ readTimeoutMs: () => 30_000 }));

import { ChangesTreeProvider } from '../changes-tree';
import { ChangesWorkbench } from '../changes-workbench';
import type { RepoNode } from '../build-change-tree';
import { RepoDiscoveryService } from '../../services/repo-discovery';
import { setGitBinaryPath } from '../../git/git-binary';
import { createGitShim, type GitShim } from '../../git/__tests__/integration/git-shim';

const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LC_ALL: 'C',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
};
/* SNIPCODE-HOOK start: perf — panel-before-tree ordering fixture */
/** Repo with ONE committed file and one unstaged edit to it, i.e. a real
 *  stageable hunk (initDirtyRepo's untracked file has no diff to stage). */
function initRepoWithHunk(path: string, file = 'f.txt'): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, file), 'one\ntwo\nthree\n');
  for (const args of [['init', '--initial-branch=main'], ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-m', 'init']]) {
    execSync(`git ${args.map(a => `'${a}'`).join(' ')}`, { cwd: path, env: { ...process.env, ...ENV }, stdio: 'pipe' });
  }
  writeFileSync(join(path, file), 'one\nTWO\nthree\n');
}
/* SNIPCODE-HOOK end */

function initDirtyRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  for (const args of [['init', '--initial-branch=main'], ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '--allow-empty', '-m', 'init']]) {
    execSync(`git ${args.map(a => `'${a}'`).join(' ')}`, { cwd: path, env: { ...process.env, ...ENV }, stdio: 'pipe' });
  }
  writeFileSync(join(path, 'dirty.txt'), 'x\n'); // untracked → shows under Unstaged
}
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}
const unstagedRepoPaths = (wb: ChangesWorkbench): string[] =>
  wb.tree.getChildren(wb.tree.getChildren()[1]).map(node => (node as RepoNode).repoPath);

const d = process.platform !== 'win32' ? describe : describe.skip;

d('Changes tree progressive paint (real git, one repo blocked)', () => {
  let shim: GitShim | undefined;

  beforeEach(() => {
    H.root = realpathSync(mkdtempSync(join(tmpdir(), 'ggp-progressive-')));
    RepoDiscoveryService.clearCache();
  });
  afterEach(() => {
    setGitBinaryPath(undefined);
    shim?.release();
    shim?.cleanup();
    shim = undefined;
    rmSync(H.root, { recursive: true, force: true });
    RepoDiscoveryService.clearCache();
  });

  it('paints the repos that answered while one repo\'s `git status` is still blocked, then all of them', async () => {
    const repos = ['a', 'b', 'c'].map(name => { const p = join(H.root, name); initDirtyRepo(p); return p; });
    shim = createGitShim({ subcommand: 'status', cwd: repos[1] });
    setGitBinaryPath(shim.path);

    const wb = new ChangesWorkbench();
    const paints: string[][] = [];
    wb.tree.onDidChangeTreeData(() => paints.push(unstagedRepoPaths(wb)));
    const refreshing = wb.tree.refresh();

    await shim.waitForIntercept();
    await waitFor(() => paints.some(p => p.length > 0));
    // b's status is still held by the shim — a and c did not wait for it.
    expect(paints.find(p => p.length > 0)).toEqual([repos[0], repos[2]]);

    shim.release();
    await refreshing;
    expect(paints.at(-1)).toEqual(repos); // discovery order, blocked repo included
    expect(paints.length).toBeGreaterThanOrEqual(2);
  });
  it('blocks commit and amend while a staged repo is still loading', async () => {
    const repos = ['a', 'b'].map(name => {
      const p = join(H.root, name); initDirtyRepo(p);
      execSync('git add dirty.txt', { cwd: p }); return p;
    });
    const heads = repos.map(p => execSync('git rev-parse HEAD', { cwd: p }).toString());
    shim = createGitShim({ subcommand: 'status', cwd: repos[1] });
    setGitBinaryPath(shim.path);
    const wb = new ChangesWorkbench();
    await expect(wb.commit('too early', false)).rejects.toThrow('still loading');
    const refreshing = wb.tree.refresh();
    await shim.waitForIntercept();
    await waitFor(() => wb.tree.getStagedRepoCount() === 1);
    expect(wb.isCommitScopeReady()).toBe(false);
    await expect(wb.commit('too early', false)).rejects.toThrow('still loading');
    await expect(wb.commit('too early', true)).rejects.toThrow('still loading');
    expect(repos.map(p => execSync('git rev-parse HEAD', { cwd: p }).toString())).toEqual(heads);
    shim.release(); await refreshing;
    expect(wb.isCommitScopeReady()).toBe(true);
    expect(wb.tree.getStagedRepoCount()).toBe(2);
    expect((await wb.commit('complete displayed scope', false)).map(r => r.ok)).toEqual([true, true]);
  });

});

/* SNIPCODE-HOOK start: perf — the Diff panel is re-rendered before the tree
   refresh, not after it. Ordering is the whole point of the change: waiting for
   a 25-repo status pool kept the Diff tab's busy gate locked on every click. */
d('Stage/unstage re-renders the Diff panel before the tree refresh', () => {
  beforeEach(() => {
    H.root = realpathSync(mkdtempSync(join(tmpdir(), 'ggp-stage-order-')));
    RepoDiscoveryService.clearCache();
  });
  afterEach(() => {
    rmSync(H.root, { recursive: true, force: true });
    RepoDiscoveryService.clearCache();
  });

  it('calls refreshIfCurrent before the tree starts re-reading status', async () => {
    const repo = join(H.root, 'r');
    initRepoWithHunk(repo);
    const wb = new ChangesWorkbench();
    const diff = await wb.fileDiffData(repo, 'f.txt', 'unstaged');
    expect(diff?.hunks.length).toBe(1);

    const order: string[] = [];
    wb.tree.onDidChangeTreeData(() => order.push('tree'));
    wb.setDiffPanel({
      refreshIfCurrent: () => order.push('panel'),
      invalidateIndexDocuments: () => {},
    } as unknown as Parameters<typeof wb.setDiffPanel>[0]);

    await wb.stageHunks(repo, 'f.txt', [0], String(diff?.fingerprint));
    expect(order[0]).toBe('panel');
    expect(order).toContain('tree');
  });
});
/* SNIPCODE-HOOK end */

// No workbench mocks: readiness belongs to the final, latest tree snapshot.
describe('Commit scope readiness', () => {
  it.each([true, false])('tracks the latest refresh regardless of completion order: %s', async (oldFirst) => {
    const finish: Array<() => void> = [];
    const tree = new ChangesTreeProvider(() => new Promise(resolve => finish.push(() => resolve([]))));
    expect(tree.isCommitScopeReady()).toBe(false);
    const old = tree.refresh(); const latest = tree.refresh();
    if (oldFirst) {
      finish[0](); await old;
      expect(tree.isCommitScopeReady()).toBe(false);
      finish[1](); await latest;
    } else {
      finish[1](); await latest;
      expect(tree.isCommitScopeReady()).toBe(true);
      finish[0](); await old;
    }
    expect(tree.isCommitScopeReady()).toBe(true);
  });

  it('keeps a failed refresh locked even after a previously successful snapshot', async () => {
    const load = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('read failed'));
    const tree = new ChangesTreeProvider(load);
    await tree.refresh();
    expect(tree.isCommitScopeReady()).toBe(true);
    await expect(tree.refresh()).rejects.toThrow('read failed');
    expect(tree.isCommitScopeReady()).toBe(false);
  });

  /* SNIPCODE-HOOK start: a failed read must not render as "Loading…" forever */
  it('reports a failed read as failed, and clears that on the next attempt', async () => {
    let fail = true;
    const tree = new ChangesTreeProvider(async () => {
      if (fail) throw new Error('read failed');
      return [];
    });
    expect(tree.isCommitScopeFailed()).toBe(false);
    await expect(tree.refresh()).rejects.toThrow('read failed');
    expect(tree.isCommitScopeFailed()).toBe(true);
    expect(tree.isCommitScopeReady()).toBe(false);
    fail = false;
    await tree.refresh();
    expect(tree.isCommitScopeFailed()).toBe(false);
    expect(tree.isCommitScopeReady()).toBe(true);
  });

  it('does not mark failure from a superseded refresh', async () => {
    const finish: Array<() => void> = [];
    const fail: Array<() => void> = [];
    const tree = new ChangesTreeProvider(() => new Promise((resolve, reject) => {
      finish.push(() => resolve([]));
      fail.push(() => reject(new Error('stale failure')));
    }));
    const old = tree.refresh();
    const latest = tree.refresh();
    fail[0]();
    await expect(old).rejects.toThrow('stale failure');
    expect(tree.isCommitScopeFailed()).toBe(false);
    finish[1]();
    await latest;
    expect(tree.isCommitScopeReady()).toBe(true);
  });
  /* SNIPCODE-HOOK end */
});
