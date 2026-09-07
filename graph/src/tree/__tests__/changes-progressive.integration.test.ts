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
});
