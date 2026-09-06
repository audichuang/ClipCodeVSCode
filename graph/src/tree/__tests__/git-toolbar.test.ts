// SNIPCODE-HOOK: whole-file — unit tests for the Snipcode Git toolbar's
// all-repo fetch/pull/push (continue-on-failure + aggregated report) and the
// Changes tree's `branch ↓behind ↑ahead` repo badges.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  repos: [] as Array<{ path: string; name?: string }>,
  svcs: new Map<string, unknown>(),
  /* SNIPCODE-HOOK start: Batch B command-selection routing regression */
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  /* SNIPCODE-HOOK end */
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
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  /* SNIPCODE-HOOK start: R3/S3 Merge Conflicts group icon/color */
  class ThemeColor { constructor(public id: string) {} }
  /* SNIPCODE-HOOK end */
  return {
    EventEmitter, TreeItem, ThemeIcon, ThemeColor,
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
    commands: {
      executeCommand: vi.fn(),
      /* SNIPCODE-HOOK start: Batch B command-selection routing regression */
      registerCommand: vi.fn((id: string, fn: (...args: unknown[]) => unknown) => {
        H.commands.set(id, fn);
        return { dispose() {} };
      }),
      /* SNIPCODE-HOOK end */
    },
    l10n: { t: (s: string) => s },
  };
});
vi.mock('../../services/repo-discovery', () => ({
  RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos), clearCache: vi.fn() },
}));
vi.mock('../../git/git-service', () => ({ GitService: vi.fn((p: string) => H.svcs.get(p)) }));
vi.mock('../../git/vscode-git-bridge', () => ({ triggerVSCodeGitAuth: vi.fn(async () => false) }));
vi.mock('../../utils/config', () => ({ readTimeoutMs: () => 30_000 }));

import * as vscode from 'vscode';
import { ChangesWorkbench } from '../changes-workbench';
import { ChangesTreeProvider } from '../changes-tree';
import type { FileNode, RepoStatus } from '../build-change-tree';

function mkSvc(over: Record<string, unknown> = {}) {
  return {
    getUncommittedDiff: vi.fn(async () => ({ staged: [], unstaged: [], conflict: [] })),
    branches: vi.fn(async () => [{ name: 'main', current: true }]),
    aheadBehind: vi.fn(async () => null),
    fetch: vi.fn(async () => ''),
    pull: vi.fn(async () => ''),
    pushCurrentBranch: vi.fn(async () => ({ pushed: true })),
    /* SNIPCODE-HOOK start: Batch B command-selection routing regression */
    stagePaths: vi.fn(async () => {}),
    unstagePaths: vi.fn(async () => {}),
    commitIndex: vi.fn(async () => {}),
    /* SNIPCODE-HOOK start: S4 Discard working-tree changes (file + repo layers) */
    discardPaths: vi.fn(async () => {}),
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK end */
    setExtraEnv: vi.fn(),
    setAuthRetryHandler: vi.fn(),
    setDefaultTimeout: vi.fn(),
    ...over,
  };
}

function setRepos(paths: string[], svcByPath: Record<string, ReturnType<typeof mkSvc>>) {
  H.repos = paths.map((p) => ({ path: p, name: p.split('/').pop()! }));
  H.svcs = new Map(Object.entries(svcByPath));
}

beforeEach(() => {
  vi.clearAllMocks();
  H.repos = [];
  H.svcs = new Map();
  /* SNIPCODE-HOOK start: Batch B command-selection routing regression */
  H.commands.clear();
  /* SNIPCODE-HOOK end */
});

/* SNIPCODE-HOOK start: Batch B command-selection routing regression */
describe('ChangesWorkbench stage/unstage selection routing', () => {
  const file = (repoPath: string, path: string, group: 'staged' | 'unstaged'): FileNode => ({
    kind: 'file', repoPath, path, status: 'M', group,
  });

  it('mutates only the clicked repo and side from a mixed tree selection', async () => {
    const a = mkSvc(); const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    const aUnstaged = file('/a', 'a-worktree.ts', 'unstaged');
    const aStaged = file('/a', 'a-index.ts', 'staged');
    const bStaged = file('/b', 'b-index.ts', 'staged');
    await H.commands.get('snipcode.git.stage')!(aUnstaged, [aUnstaged, aStaged, bStaged]);

    expect(a.stagePaths).toHaveBeenCalledWith([aUnstaged]);
    expect(b.stagePaths).not.toHaveBeenCalled();

    const bUnstaged = file('/b', 'b-worktree.ts', 'unstaged');
    await H.commands.get('snipcode.git.unstage')!(aStaged, [aStaged, aUnstaged, bUnstaged]);

    expect(a.unstagePaths).toHaveBeenCalledWith([aStaged]);
    expect(b.unstagePaths).not.toHaveBeenCalled();
  });

  it('warns about dropped selection items instead of silently ignoring them', async () => {
    const a = mkSvc(); const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    const aUnstaged = file('/a', 'a-worktree.ts', 'unstaged');
    const aStaged = file('/a', 'a-index.ts', 'staged');
    const bStaged = file('/b', 'b-index.ts', 'staged');
    await H.commands.get('snipcode.git.stage')!(aUnstaged, [aUnstaged, aStaged, bStaged]);

    // Two items (a-index, b-index) were outside the clicked repo+side — the
    // user must be told they were skipped, not left believing they staged.
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0])).toContain('2');

    // A homogeneous selection stays silent.
    await H.commands.get('snipcode.git.stage')!(aUnstaged, [aUnstaged]);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  /* SNIPCODE-HOOK start: R4/S7 never `git add` an unregistered nested repo dir */
  it('sameGroup drops a nested-repo (status N) node from a mixed selection', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    const nested: FileNode = { kind: 'file', repoPath: '/a', path: 'vendor-lib', status: 'N', group: 'unstaged' };
    const normal = file('/a', 'a-worktree.ts', 'unstaged');
    await H.commands.get('snipcode.git.stage')!(normal, [normal, nested]);

    expect(a.stagePaths).toHaveBeenCalledWith([normal]);
  });

  it('sameGroup drops a lone nested-repo node (single inline click) — nothing is staged', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    const nested: FileNode = { kind: 'file', repoPath: '/a', path: 'vendor-lib', status: 'N', group: 'unstaged' };
    await H.commands.get('snipcode.git.stage')!(nested, undefined);

    expect(a.stagePaths).not.toHaveBeenCalled();
  });

  it('stageAll never `git add`s a nested repo directory', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({
        staged: [], unstaged: [{ path: 'src/foo.ts', status: 'M' }, { path: 'vendor-lib', status: 'N' }], conflict: [],
      })),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    await H.commands.get('snipcode.git.stageAll')!();

    expect(a.stagePaths).toHaveBeenCalledWith([{ path: 'src/foo.ts', status: 'M' }]);
  });

  it('stageRepo (repo-node inline Stage All) never `git add`s a nested repo directory', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    const repoNode = {
      kind: 'repo', repoName: 'a', repoPath: '/a', branch: 'main', group: 'unstaged',
      files: [
        { kind: 'file', repoPath: '/a', path: 'src/foo.ts', status: 'M', group: 'unstaged' },
        { kind: 'file', repoPath: '/a', path: 'vendor-lib', status: 'N', group: 'unstaged' },
      ],
    };
    await H.commands.get('snipcode.git.stageRepo')!(repoNode);

    expect(a.stagePaths).toHaveBeenCalledWith([{ kind: 'file', repoPath: '/a', path: 'src/foo.ts', status: 'M', group: 'unstaged' }]);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S4 Discard working-tree changes (file + repo layers) */
  it('discard confirms via a modal warning before calling discardPaths', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('捨棄' as never);

    const target = file('/a', 'a-worktree.ts', 'unstaged');
    await H.commands.get('snipcode.git.discard')!(target, [target]);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('a-worktree.ts'),
      { modal: true },
      '捨棄',
    );
    expect(a.discardPaths).toHaveBeenCalledWith([target]);
  });

  it('discard does nothing when the modal warning is dismissed', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);

    const target = file('/a', 'a-worktree.ts', 'unstaged');
    await H.commands.get('snipcode.git.discard')!(target, [target]);

    expect(a.discardPaths).not.toHaveBeenCalled();
  });

  it('discardRepo confirms once for the whole repo and filters out nested repo dirs', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('捨棄' as never);

    const repoNode = {
      kind: 'repo', repoName: 'a', repoPath: '/a', branch: 'main', group: 'unstaged',
      files: [
        { kind: 'file', repoPath: '/a', path: 'src/foo.ts', status: 'M', group: 'unstaged' },
        { kind: 'file', repoPath: '/a', path: 'vendor-lib', status: 'N', group: 'unstaged' },
      ],
    };
    await H.commands.get('snipcode.git.discardRepo')!(repoNode);

    expect(a.discardPaths).toHaveBeenCalledWith([{ kind: 'file', repoPath: '/a', path: 'src/foo.ts', status: 'M', group: 'unstaged' }]);
  });
  /* SNIPCODE-HOOK end */

  it('routes staged copies through Git change copy with the index side preserved', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const modified = file('/a', 'same.ts', 'staged');
    const deleted = { ...file('/a', 'gone.ts', 'staged'), status: 'D' };
    const renamed = { ...file('/a', 'new.ts', 'staged'), status: 'R', oldPath: 'old.ts' };

    await H.commands.get('snipcode.git.copyAsClipCode')!(modified, [modified, deleted, renamed]);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('clipcode.copyGitChanges', [
      { resourceUri: expect.objectContaining({ fsPath: '/a/same.ts' }), group: 'staged' },
      { resourceUri: expect.objectContaining({ fsPath: '/a/gone.ts' }), group: 'staged' },
      { resourceUri: expect.objectContaining({ fsPath: '/a/new.ts' }), group: 'staged' },
    ]);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: Batch D commit status-read guard */
describe('ChangesWorkbench commit status guard', () => {
  it('rejects before committing when any selected repo status cannot be read', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] })),
    });
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => { throw new Error('index.lock exists'); }),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });

    await expect(new ChangesWorkbench().commit('fix', true)).rejects.toThrow('b: index.lock exists');
    expect(a.commitIndex).not.toHaveBeenCalled();
  });

  it('an unchecked repo whose status read fails does not block committing the checked repo', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] })),
    });
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => { throw new Error('index.lock exists'); }),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const wb = new ChangesWorkbench();
    // The user excluded /b from the commit; its transient read failure must
    // not veto committing /a.
    wb.handleCheckboxChange([[
      { kind: 'repo', repoPath: '/b' } as unknown as import('../changes-tree').ChangeTreeNode,
      0 as unknown as import('vscode').TreeItemCheckboxState,
    ]]);

    const results = await wb.commit('fix', false);

    expect(results).toEqual([{ repoName: 'a', ok: true }]);
    expect(a.commitIndex).toHaveBeenCalledWith('fix', { amend: false });
    expect(b.commitIndex).not.toHaveBeenCalled();
  });

  it('commit uses one checkbox snapshot — a mid-commit recheck cannot flip the outcome', async () => {
    const wb = new ChangesWorkbench();
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => {
        // The user re-checks /b while /a's status read is still in flight;
        // the commit must keep honouring the selection as of the click.
        wb.handleCheckboxChange([[
          { kind: 'repo', repoPath: '/b' } as unknown as import('../changes-tree').ChangeTreeNode,
          1 as unknown as import('vscode').TreeItemCheckboxState,
        ]]);
        return { staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] };
      }),
    });
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => { throw new Error('index.lock exists'); }),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    wb.handleCheckboxChange([[
      { kind: 'repo', repoPath: '/b' } as unknown as import('../changes-tree').ChangeTreeNode,
      0 as unknown as import('vscode').TreeItemCheckboxState,
    ]]);

    const results = await wb.commit('fix', false);

    expect(results).toEqual([{ repoName: 'a', ok: true }]);
    expect(b.commitIndex).not.toHaveBeenCalled();
  });

  it('a mid-commit recheck cannot ADD a readable staged repo to the commit (amend stays single-target)', async () => {
    const wb = new ChangesWorkbench();
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => {
        wb.handleCheckboxChange([[
          { kind: 'repo', repoPath: '/b' } as unknown as import('../changes-tree').ChangeTreeNode,
          1 as unknown as import('vscode').TreeItemCheckboxState,
        ]]);
        return { staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] };
      }),
    });
    // /b reads FINE and has staged work — only the click-time snapshot may
    // exclude it, not the synthetic-empty fallback.
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'b.ts', status: 'M' }], unstaged: [] })),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    wb.handleCheckboxChange([[
      { kind: 'repo', repoPath: '/b' } as unknown as import('../changes-tree').ChangeTreeNode,
      0 as unknown as import('vscode').TreeItemCheckboxState,
    ]]);

    // amend with two staged repos would throw — it must not, because the
    // snapshot keeps /b out of the cardinality check too.
    const results = await wb.commit('fix', true);

    expect(results).toEqual([{ repoName: 'a', ok: true }]);
    expect(a.commitIndex).toHaveBeenCalledWith('fix', { amend: true });
    expect(b.commitIndex).not.toHaveBeenCalled();
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: R3/S3 commit skips repos with unresolved conflicts */
describe('ChangesWorkbench commit skips repos with conflicts (R3/S3)', () => {
  it('skips a repo with unmerged files, warns via view.message, and still commits the rest', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({
        staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], conflict: [{ path: 'both.ts', status: '!' }],
      })),
    });
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'b.ts', status: 'M' }], unstaged: [], conflict: [] })),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const wb = new ChangesWorkbench();
    const view = { message: undefined as string | undefined };
    wb.setView(view as unknown as import('vscode').TreeView<unknown>);

    const results = await wb.commit('fix', false);

    expect(results).toEqual([{ repoName: 'b', ok: true }]);
    expect(a.commitIndex).not.toHaveBeenCalled();
    expect(b.commitIndex).toHaveBeenCalled();
    expect(view.message).toContain('a');
  });

  it('throws when every checked repo has unresolved conflicts', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({
        staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], conflict: [{ path: 'both.ts', status: '!' }],
      })),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();

    await expect(wb.commit('fix', false)).rejects.toThrow(/沒有勾選要提交/);
    expect(a.commitIndex).not.toHaveBeenCalled();
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
describe('ChangesWorkbench index document invalidation', () => {
  it('invalidates open index documents on a status refresh', async () => {
    const wb = new ChangesWorkbench();
    const invalidateIndexDocuments = vi.fn();
    wb.setDiffPanel({ invalidateIndexDocuments } as never);

    await wb.refresh();

    expect(invalidateIndexDocuments).toHaveBeenCalledTimes(1);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: S9 inline "Open in Editor" opens the plain file, not a diff */
describe('ChangesWorkbench openChange / openChangeNative (S9)', () => {
  it('the inline command opens the plain file via vscode.open, not a diff', async () => {
    setRepos([], {});
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const node = file('/a', 'src/foo.ts', 'unstaged');

    await H.commands.get('snipcode.git.openChange')!(node);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'vscode.open', expect.objectContaining({ fsPath: '/a/src/foo.ts' }),
    );
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('git.openChange', expect.anything());
  });

  it('the "Open Changes (VS Code)" command still opens the native diff', async () => {
    setRepos([], {});
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const node = file('/a', 'src/foo.ts', 'unstaged');

    await H.commands.get('snipcode.git.openChangeNative')!(node);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'git.openChange', expect.objectContaining({ fsPath: '/a/src/foo.ts' }),
    );
  });
});
/* SNIPCODE-HOOK end */

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

  it('keeps RepoDiscoveryService disambiguation in an all-repo failure', async () => {
    const first = mkSvc({ fetch: vi.fn(async () => { throw new Error('auth denied'); }) });
    const second = mkSvc();
    H.repos = [
      { path: '/clients/acme/api', name: 'acme/api' },
      { path: '/clients/beta/api', name: 'beta/api' },
    ];
    H.svcs = new Map([['/clients/acme/api', first], ['/clients/beta/api', second]]);

    await new ChangesWorkbench().fetchAll();

    const msg = vi.mocked(vscode.window.showErrorMessage).mock.calls[0][0] as string;
    expect(msg).toContain('acme/api: auth denied');
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

  it('ignores the Filter Repos scope — All Repos means all discovered repos', async () => {
    const a = mkSvc(); const b = mkSvc();
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const wb = new ChangesWorkbench();
    (wb as unknown as { repoFilter: Set<string> }).repoFilter = new Set(['/a']); // tree filtered to /a only
    await wb.fetchAll();
    expect(a.fetch).toHaveBeenCalled();
    expect(b.fetch).toHaveBeenCalled(); // filter is a display scope, not a sync scope
  });

  it('wires auth retry, timeout, and (late-arriving) askpass env onto every GitService', async () => {
    const a = mkSvc();
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    await wb.fetchAll(); // creates the service before the env arrives
    expect(a.setAuthRetryHandler).toHaveBeenCalled();
    expect(a.setDefaultTimeout).toHaveBeenCalledWith(30_000);
    wb.setGitEnv({ GIT_ASKPASS: '/x' }); // built-in git env lands on a later microtask
    expect(a.setExtraEnv).toHaveBeenCalledWith({ GIT_ASKPASS: '/x' });
  });
});

describe('Changes tree repo badges', () => {
  const status = (ahead?: number, behind?: number): RepoStatus[] => [{
    repoName: 'r', repoPath: '/r', branch: 'main', ahead, behind,
    staged: [], unstaged: [{ path: 'f.ts', status: 'M' }], conflict: [],
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

  it('keeps the newest refresh when an older status read finishes last', async () => {
    let releaseOld!: (value: RepoStatus[]) => void;
    const oldStatus = new Promise<RepoStatus[]>(resolve => { releaseOld = resolve; });
    const provider = new ChangesTreeProvider(vi.fn()
      .mockImplementationOnce(() => oldStatus)
      .mockResolvedValueOnce(status()));

    const older = provider.refresh();
    await provider.refresh();
    releaseOld([{ ...status()[0], repoName: 'stale', repoPath: '/stale' }]);
    await older;

    const unstaged = provider.getChildren()[1];
    const repo = provider.getChildren(unstaged)[0];
    expect(repo.kind).toBe('repo');
    if (repo.kind !== 'repo') throw new Error('expected repo node');
    expect(repo.repoName).toBe('r');
  });

  it('reports only checked staged repos for the amend UI guard', async () => {
    const checked = new Set(['/a']);
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], repoName: 'a', repoPath: '/a', staged: [{ path: 'a.ts', status: 'M' }], unstaged: [] },
      { ...status()[0], repoName: 'b', repoPath: '/b', staged: [{ path: 'b.ts', status: 'M' }], unstaged: [] },
    ], repoPath => checked.has(repoPath));
    await provider.refresh();

    expect(provider.getStagedRepoCount()).toBe(1);
    const counts: number[] = [];
    provider.onDidChangeTreeData(() => counts.push(provider.getStagedRepoCount()));
    checked.add('/b');
    provider.notifyCommitSelectionChanged();
    expect(counts).toEqual([2]);
  });

  /* SNIPCODE-HOOK start: R3/S3 Merge Conflicts group rendering */
  it('renders a trailing Merge Conflicts group with a warning icon, and conflict files as file-conflict', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], staged: [], unstaged: [], conflict: [{ path: 'both.ts', status: '!' }] },
    ]);
    await provider.refresh();

    const groups = provider.getChildren();
    expect(groups).toHaveLength(3);
    const conflictGroup = groups[2];
    expect(provider.getTreeItem(conflictGroup).contextValue).toBe('group-conflict');
    const icon = provider.getTreeItem(conflictGroup).iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe('warning');
    expect(icon.color?.id).toBe('gitDecoration.conflictingResourceForeground');

    const conflictRepo = provider.getChildren(conflictGroup)[0];
    const conflictFile = provider.getChildren(conflictRepo)[0];
    expect(provider.getTreeItem(conflictFile).contextValue).toBe('file-conflict');
  });

  it('omits the Merge Conflicts group when nothing is unmerged', async () => {
    const provider = new ChangesTreeProvider(async () => status());
    await provider.refresh();
    expect(provider.getChildren()).toHaveLength(2);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: R4/S7 nested repo / untracked file rendering */
  it('renders a nested repo (status N) with a repo icon and "(nested repo)" description', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], unstaged: [{ path: 'vendor-lib', status: 'N' }] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[1])[0];
    const fileNode = provider.getChildren(repoNode)[0];
    const item = provider.getTreeItem(fileNode);
    expect(item.description).toBe('(nested repo)');
    expect((item.iconPath as { id: string }).id).toBe('repo');
  });

  it('marks an untracked file description with "untracked"', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], unstaged: [{ path: 'src/new.ts', status: 'U' }] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[1])[0];
    const fileNode = provider.getChildren(repoNode)[0];
    expect(provider.getTreeItem(fileNode).description).toBe('src · untracked');
  });

  it('an untracked file at the repo root just says "untracked"', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], unstaged: [{ path: 'new.ts', status: 'U' }] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[1])[0];
    const fileNode = provider.getChildren(repoNode)[0];
    expect(provider.getTreeItem(fileNode).description).toBe('untracked');
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S5 own FileDecorationProvider */
  it('renders a file resourceUri on the snipcode-change scheme carrying status+group, and a tooltip', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], staged: [{ path: 'src/foo.ts', status: 'M' }], unstaged: [] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[0])[0]; // Staged group → repo
    const fileNode = provider.getChildren(repoNode)[0];
    const item = provider.getTreeItem(fileNode);

    const uri = item.resourceUri as unknown as { scheme: string; query: string; fsPath: string };
    expect(uri.scheme).toBe('snipcode-change');
    expect(uri.query).toBe('status=M&group=staged');
    expect(uri.fsPath).toBe('/r/src/foo.ts');
    expect(item.tooltip).toBe('src/foo.ts\nModified (staged)');
  });

  it('tooltips a conflict file as unresolved', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], staged: [], unstaged: [], conflict: [{ path: 'both.ts', status: '!' }] },
    ]);
    await provider.refresh();
    const conflictGroup = provider.getChildren()[2];
    const repoNode = provider.getChildren(conflictGroup)[0];
    const fileNode = provider.getChildren(repoNode)[0];
    expect(provider.getTreeItem(fileNode).tooltip).toBe('both.ts\nConflicting (unresolved)');
  });
  /* SNIPCODE-HOOK end */
});

function file(repoPath: string, path: string, group: 'staged' | 'unstaged'): FileNode {
  return { kind: 'file', repoPath, path, status: 'M', group };
}
