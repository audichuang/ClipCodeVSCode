// SNIPCODE-HOOK: whole-file — unit tests for the Snipcode Git toolbar's
// all-repo fetch/pull/push (continue-on-failure + aggregated report) and the
// Changes tree's `branch ↓behind ↑ahead` repo badges.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  repos: [] as Array<{ path: string }>,
  svcs: new Map<string, unknown>(),
}));

vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Array<(v: unknown) => void> = [];
    event = (l: (v: unknown) => void) => { this.listeners.push(l); return { dispose() {} }; };
    fire(v?: unknown) { this.listeners.forEach((l) => l(v)); }
  }
  class TreeItem {
    description?: string;
    constructor(public label: unknown, public collapsibleState?: unknown) {}
  }
  class ThemeIcon { constructor(public id: string) {} }
  return {
    EventEmitter, TreeItem, ThemeIcon,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (p: string) => ({ fsPath: p, with(o: object) { return { ...this, ...o }; } }) },
    window: {
      withProgress: vi.fn(async (_o: unknown, task: (p: { report: () => void }) => Promise<void>) =>
        task({ report: () => {} })),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      setStatusBarMessage: vi.fn(),
      showTextDocument: vi.fn(),
    },
    workspace: { workspaceFolders: [{ uri: { fsPath: '/ws' } }] },
    commands: { executeCommand: vi.fn(), registerCommand: vi.fn(() => ({ dispose() {} })) },
    l10n: { t: (s: string) => s },
  };
});
vi.mock('../../services/repo-discovery', () => ({
  RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos), clearCache: vi.fn() },
}));
vi.mock('../../git/git-service', () => ({ GitService: vi.fn((p: string) => H.svcs.get(p)) }));

import * as vscode from 'vscode';
import { ChangesWorkbench } from '../changes-workbench';
import { ChangesTreeProvider } from '../changes-tree';
import type { RepoStatus } from '../build-change-tree';

function mkSvc(over: Record<string, unknown> = {}) {
  return {
    getUncommittedDiff: vi.fn(async () => ({ staged: [], unstaged: [] })),
    branches: vi.fn(async () => [{ name: 'main', current: true }]),
    aheadBehind: vi.fn(async () => null),
    fetch: vi.fn(async () => ''),
    pull: vi.fn(async () => ''),
    pushCurrentBranch: vi.fn(async () => ({ pushed: true })),
    ...over,
  };
}

function setRepos(paths: string[], svcByPath: Record<string, ReturnType<typeof mkSvc>>) {
  H.repos = paths.map((p) => ({ path: p }));
  H.svcs = new Map(Object.entries(svcByPath));
}

beforeEach(() => {
  vi.clearAllMocks();
  H.repos = [];
  H.svcs = new Map();
});

describe('ChangesWorkbench fetchAll/pullAll/pushAll', () => {
  it('fetchAll fetches every repo with prune and reports success in the status bar', async () => {
    const a = mkSvc(); const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    await new ChangesWorkbench().fetchAll();
    expect(a.fetch).toHaveBeenCalledWith(undefined, { prune: true });
    expect(b.fetch).toHaveBeenCalledWith(undefined, { prune: true });
    expect(vscode.window.setStatusBarMessage).toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('one failing repo does not stop the rest, and the failure is aggregated', async () => {
    const a = mkSvc({ fetch: vi.fn(async () => { throw new Error('auth denied'); }) });
    const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    await new ChangesWorkbench().fetchAll();
    expect(b.fetch).toHaveBeenCalled(); // kept going past /a's failure
    const msg = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string;
    expect(msg).toContain('1/2 成功');
    expect(msg).toContain('a: auth denied');
  });

  it('pullAll pulls with no args so each repo keeps its own pull.rebase config', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    await new ChangesWorkbench().pullAll();
    expect(a.pull).toHaveBeenCalledWith();
  });

  it('pushAll reports a no-remote repo as skipped, not failed', async () => {
    const a = mkSvc({ pushCurrentBranch: vi.fn(async () => ({ pushed: false, reason: 'no-remote' })) });
    const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    await new ChangesWorkbench().pushAll();
    expect(b.pushCurrentBranch).toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    const msg = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(msg).toContain('略過');
  });

  it('says so when the workspace has no repos', async () => {
    await new ChangesWorkbench().fetchAll();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No git repositories in workspace');
  });
});

describe('Changes tree repo badges', () => {
  const status = (ahead?: number, behind?: number): RepoStatus[] => [{
    repoName: 'r', repoPath: '/r', branch: 'main', ahead, behind,
    staged: [], unstaged: [{ path: 'f.ts', status: 'M' }],
  }];

  async function repoDescription(ahead?: number, behind?: number): Promise<string | undefined> {
    const provider = new ChangesTreeProvider(async () => status(ahead, behind));
    await provider.refresh();
    const groups = provider.getChildren();
    const repoNode = provider.getChildren(groups[1])[0]; // Unstaged group → repo
    return provider.getTreeItem(repoNode).description as string | undefined;
  }

  it('renders branch ↓behind ↑ahead, dropping zero/absent sides', async () => {
    await expect(repoDescription(1, 3)).resolves.toBe('main ↓3 ↑1');
    await expect(repoDescription(0, 3)).resolves.toBe('main ↓3');
    await expect(repoDescription(1, 0)).resolves.toBe('main ↑1');
    await expect(repoDescription(0, 0)).resolves.toBe('main');
    await expect(repoDescription(undefined, undefined)).resolves.toBe('main'); // no upstream
  });
});
