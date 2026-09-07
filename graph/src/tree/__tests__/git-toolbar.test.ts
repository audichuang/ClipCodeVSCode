// SNIPCODE-HOOK: whole-file — unit tests for the Snipcode Git toolbar's
// all-repo fetch/pull/push (continue-on-failure + aggregated report) and the
// Changes tree's `branch ↓behind ↑ahead` repo badges.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
      showQuickPick: vi.fn(),
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
    /* SNIPCODE-HOOK start: X1-4 l10n mock substitutes {0}/{1}/… like the real API */
    l10n: { t: (s: string, ...args: unknown[]) => s.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)])) },
    /* SNIPCODE-HOOK end */
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
import type { FileNode, RepoNode, RepoStatus } from '../build-change-tree';

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
  // Command tests assume a loaded tree; real loading guards have their own integration test.
  vi.spyOn(ChangesTreeProvider.prototype, 'isCommitScopeReady').mockReturnValue(true);
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
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Discard' as never);

    const target = file('/a', 'a-worktree.ts', 'unstaged');
    await H.commands.get('snipcode.git.discard')!(target, [target]);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('a-worktree.ts'),
      { modal: true },
      'Discard',
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
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Discard' as never);

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

  /* SNIPCODE-HOOK start: refresh an open Diff tab after commit */
  it('refreshes only successfully committed files in the existing Diff tab', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], conflict: [] })),
    });
    const b = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'b.ts', status: 'M' }], unstaged: [], conflict: [] })),
      commitIndex: vi.fn(async () => { throw new Error('hook failed'); }),
    });
    setRepos(['/a', '/b'], { '/a': a, '/b': b });
    const refreshIfCurrent = vi.fn();
    const wb = new ChangesWorkbench();
    wb.setDiffPanel({ refreshIfCurrent, invalidateIndexDocuments: vi.fn() } as never);

    const results = await wb.commit('fix', false);

    expect(results).toEqual([
      { repoName: 'a', ok: true },
      { repoName: 'b', ok: false, error: 'hook failed' },
    ]);
    expect(refreshIfCurrent).toHaveBeenCalledWith('/a', 'a.ts');
    expect(refreshIfCurrent).not.toHaveBeenCalledWith('/b', 'b.ts');
  });
  /* SNIPCODE-HOOK end */
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

  /* SNIPCODE-HOOK start: live-QA-3 this used to assert the generic "nothing
     staged" text, which is what a real-VS Code pass reported as misleading: the
     repo WAS checked and DID have staged files, conflicts were the reason.
     Inverted with the fix — the error now names the blocked repos. */
  it('throws naming the conflicted repos when every checked repo is blocked by conflicts', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({
        staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], conflict: [{ path: 'both.ts', status: '!' }],
      })),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();

    await expect(wb.commit('fix', false)).rejects.toThrow(/unresolved conflicts in a\b/);
    await expect(wb.commit('fix', false)).rejects.not.toThrow(/nothing staged/);
    expect(a.commitIndex).not.toHaveBeenCalled();
  });

  it('still throws the generic message when the block is genuinely nothing staged', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [], unstaged: [{ path: 'a.ts', status: 'M' }], conflict: [] })),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();

    await expect(wb.commit('fix', false)).rejects.toThrow(/No repo checked to commit/);
  });
  /* SNIPCODE-HOOK end */
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

  /* SNIPCODE-HOOK start: S12 show progress in the Changes view while refreshing */
  it('shows progress scoped to the Changes view while refreshing (S12)', async () => {
    const wb = new ChangesWorkbench();

    await wb.refresh();

    expect(vscode.window.withProgress).toHaveBeenCalledWith(
      { location: { viewId: 'snipcode.changes' } },
      expect.any(Function),
    );
  });

  it('a repo whose status read fails ends up in the Repository Errors group, not silently dropped', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => { throw new Error('index.lock exists'); }),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();

    await wb.refresh();

    const groups = wb.tree.getChildren();
    const errorGroup = groups.find((g) => g.kind === 'group' && g.group === 'error');
    expect(errorGroup).toBeDefined();
    if (errorGroup?.kind !== 'group') throw new Error('expected group node');
    expect(errorGroup.repos[0]).toMatchObject({ repoName: 'a', error: 'index.lock exists' });
  });
  /* SNIPCODE-HOOK end */
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: S P2 activity-bar badge = staged repo count */
describe('ChangesWorkbench activity-bar badge (S P2)', () => {
  it('sets the view badge to the staged repo count', async () => {
    const a = mkSvc({
      getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a.ts', status: 'M' }], unstaged: [], conflict: [] })),
    });
    setRepos(['/a'], { '/a': a });
    const wb = new ChangesWorkbench();
    const view = { badge: undefined as unknown };
    wb.setView(view as unknown as import('vscode').TreeView<unknown>);

    await wb.refresh();

    expect(view.badge).toEqual({ value: 1, tooltip: '1 repo(s) awaiting commit' });
  });

  it('clears the badge when nothing is staged', async () => {
    setRepos([], {});
    const wb = new ChangesWorkbench();
    const view = { badge: { value: 3, tooltip: 'x' } as unknown };
    wb.setView(view as unknown as import('vscode').TreeView<unknown>);

    await wb.refresh();

    expect(view.badge).toBeUndefined();
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: S P2 filter enabled state drives the title-bar icon */
describe('ChangesWorkbench filterRepos sets snipcode.changes.filtered (S P2)', () => {
  it('sets the context key true for a partial selection, false when cleared back to all', async () => {
    setRepos(['/a', '/b'], { '/a': mkSvc(), '/b': mkSvc() });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce([
      { label: 'a', description: '/a', repoPath: '/a', picked: true },
    ] as never);
    await H.commands.get('snipcode.git.filterRepos')!();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'snipcode.changes.filtered', true);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce([
      { label: 'a', description: '/a', repoPath: '/a', picked: true },
      { label: 'b', description: '/b', repoPath: '/b', picked: true },
    ] as never);
    await H.commands.get('snipcode.git.filterRepos')!();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'snipcode.changes.filtered', false);
  });

  it('filterReposActive (the "active" icon variant) runs the same flow', async () => {
    setRepos(['/a', '/b'], { '/a': mkSvc(), '/b': mkSvc() });
    const wb = new ChangesWorkbench();
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce([
      { label: 'a', description: '/a', repoPath: '/a', picked: true },
    ] as never);

    await H.commands.get('snipcode.git.filterReposActive')!();

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'snipcode.changes.filtered', true);
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

  it('the "Open Changes (VS Code)" command routes to openNativeDiff', async () => {
    const wb = new ChangesWorkbench();
    const openNativeDiff = vi.fn();
    wb.setDiffPanel({ openNativeDiff } as never);
    wb.registerCommands({ subscriptions: [] } as unknown as import('vscode').ExtensionContext);
    const node = file('/a', 'src/foo.ts', 'unstaged');

    await H.commands.get('snipcode.git.openChangeNative')!(node);

    expect(openNativeDiff).toHaveBeenCalledWith('/a', 'src/foo.ts', 'unstaged', undefined);
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
    expect(msg).toContain('1/2 succeeded');
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
    expect(msg).toContain('skipped');
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
    await expect(repoDescription(1, 3)).resolves.toBe('1 · main ↓3 ↑1');
    await expect(repoDescription(0, 3)).resolves.toBe('1 · main ↓3');
    await expect(repoDescription(1, 0)).resolves.toBe('1 · main ↑1');
    await expect(repoDescription(0, 0)).resolves.toBe('1 · main');
    await expect(repoDescription(undefined, undefined)).resolves.toBe('1 · main'); // no upstream
  });

  // A single-repo workspace has nothing to be crowded out by, so collapsing it
  // would cost that user an extra click on every refresh for no gain; only a
  // group with siblings starts collapsed.
  it('collapses repo rows only when the group has more than one repo', async () => {
    const collapsibleStates = async (repoPaths: string[]): Promise<number[]> => {
      const provider = new ChangesTreeProvider(async () => repoPaths.map(repoPath => ({
        repoName: repoPath.slice(1), repoPath, branch: 'main',
        staged: [], unstaged: [{ path: 'f.ts', status: 'M' }], conflict: [],
      })) as RepoStatus[]);
      await provider.refresh();
      const groups = provider.getChildren();
      const unstaged = groups.find(g => provider.getTreeItem(g).contextValue === 'group-unstaged')!;
      return provider.getChildren(unstaged)
        .map(repo => provider.getTreeItem(repo).collapsibleState as number);
    };

    await expect(collapsibleStates(['/r'])).resolves.toEqual([2]);            // Expanded
    await expect(collapsibleStates(['/a', '/b'])).resolves.toEqual([1, 1]);   // Collapsed
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

  /* SNIPCODE-HOOK start: compact multi-repo commit scope */
  it('tracks checked staged repo/file scope through filtering and clean state', async () => {
    const checked = new Set(['/a', '/b']);
    const visible = new Set(['/a', '/b']);
    const repos: RepoStatus[] = [
      { ...status()[0], repoName: 'a', repoPath: '/a', staged: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }], unstaged: [] },
      { ...status()[0], repoName: 'b', repoPath: '/b', staged: [{ path: 'c.ts', status: 'M' }], unstaged: [] },
    ];
    const provider = new ChangesTreeProvider(
      async () => repos.filter(repo => visible.has(repo.repoPath)),
      repoPath => checked.has(repoPath),
    );

    await provider.refresh();
    expect(provider.getStagedRepoCount()).toBe(2);
    expect(provider.getStagedFileCount()).toBe(3);

    checked.delete('/b');
    provider.notifyCommitSelectionChanged();
    expect(provider.getStagedRepoCount()).toBe(1);
    expect(provider.getStagedFileCount()).toBe(2);

    visible.delete('/b');
    await provider.refresh();
    expect(provider.getStagedRepoCount()).toBe(1);
    expect(provider.getStagedFileCount()).toBe(2);

    visible.clear();
    await provider.refresh();
    expect(provider.getStagedRepoCount()).toBe(0);
    expect(provider.getStagedFileCount()).toBe(0);
    expect(provider.getChildren()).toHaveLength(0);
  });
  /* SNIPCODE-HOOK end */

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

  /* SNIPCODE-HOOK start: S P2 rename description shows the old path */
  it('shows the old path in a renamed file\'s description', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], staged: [{ path: 'src/new-name.ts', status: 'R', oldPath: 'src/old-name.ts' }], unstaged: [] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[0])[0];
    const fileNode = provider.getChildren(repoNode)[0];
    expect(provider.getTreeItem(fileNode).description).toBe('src ← src/old-name.ts');
  });

  it('a root-level rename shows just the old path (no leading dir)', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { ...status()[0], staged: [{ path: 'new-name.ts', status: 'R', oldPath: 'old-name.ts' }], unstaged: [] },
    ]);
    await provider.refresh();
    const repoNode = provider.getChildren(provider.getChildren()[0])[0];
    const fileNode = provider.getChildren(repoNode)[0];
    expect(provider.getTreeItem(fileNode).description).toBe('← old-name.ts');
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S12 empty/error state */
  it('collapses to an empty root (for viewsWelcome) when every group is empty', async () => {
    const provider = new ChangesTreeProvider(async () => [repo({})]);
    await provider.refresh();
    expect(provider.getChildren()).toEqual([]);
  });

  it('sets snipcode.changes.hasRepos so viewsWelcome can tell "no repo" from "clean repo" apart', async () => {
    const provider = new ChangesTreeProvider(async () => [repo({})]);
    await provider.refresh();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'snipcode.changes.hasRepos', true);

    const emptyProvider = new ChangesTreeProvider(async () => []);
    await emptyProvider.refresh();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'snipcode.changes.hasRepos', false);
  });

  it('does not collapse the root when there is real content', async () => {
    const provider = new ChangesTreeProvider(async () => status());
    await provider.refresh();
    expect(provider.getChildren()).toHaveLength(2);
  });

  it('renders a repo whose status failed to read as a warning node, not a silent drop', async () => {
    const provider = new ChangesTreeProvider(async () => [
      { repoName: 'broken', repoPath: '/broken', branch: 'main', staged: [], unstaged: [], conflict: [], error: 'index.lock exists' },
    ]);
    await provider.refresh();
    const groups = provider.getChildren();
    // Staged/Unstaged stay in the tree (count 0, but the root isn't "every
    // group empty" once the error group is non-zero) alongside Repository Errors.
    const errorGroup = groups.find((g) => provider.getTreeItem(g).contextValue === 'group-error');
    expect(errorGroup).toBeDefined();
    const repoNode = provider.getChildren(errorGroup!)[0];
    const item = provider.getTreeItem(repoNode);
    expect(item.contextValue).toBe('repo-error');
    expect(item.description).toBe('index.lock exists');
    expect(item.collapsibleState).toBe(0); // None
  });
  /* SNIPCODE-HOOK end */
});

function repo(over: Partial<RepoStatus>): RepoStatus {
  return { repoName: 'r', repoPath: '/r', branch: 'main', staged: [], unstaged: [], conflict: [], ...over };
}

function file(repoPath: string, path: string, group: 'staged' | 'unstaged'): FileNode {
  return { kind: 'file', repoPath, path, status: 'M', group };
}

/* SNIPCODE-HOOK start: startup — bounded concurrent status read + progressive tree paint */
describe('ChangesWorkbench loadStatus fan-out', () => {
  const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const unstagedRepoPaths = (wb: ChangesWorkbench): string[] =>
    wb.tree.getChildren(wb.tree.getChildren()[1]).map(node => (node as RepoNode).repoPath);

  it('reads at most 8 repos at once and keeps discovery order whatever the completion order', async () => {
    const N = 12;
    let inflight = 0;
    let maxInflight = 0;
    const release: Array<() => void> = [];
    const svcs: Record<string, ReturnType<typeof mkSvc>> = {};
    for (let i = 0; i < N; i++) {
      svcs[`/r${String(i).padStart(2, '0')}`] = mkSvc({
        getUncommittedDiff: vi.fn(() => new Promise(resolve => {
          inflight++;
          maxInflight = Math.max(maxInflight, inflight);
          release.push(() => { inflight--; resolve({ staged: [], unstaged: [{ path: `f${i}.ts`, status: 'M' }], conflict: [] }); });
        })),
      });
    }
    const order = Object.keys(svcs);
    setRepos(order, svcs);
    const wb = new ChangesWorkbench();
    const refreshing = wb.tree.refresh();
    await flush();
    expect(maxInflight).toBe(8); // STATUS_CONCURRENCY: neither serial nor all 12
    // Release newest-first so completion order is the reverse of discovery order.
    while (release.length) { release.pop()!(); await flush(); }
    await refreshing;
    expect(maxInflight).toBe(8);
    expect(unstagedRepoPaths(wb)).toEqual(order);
  });

  it('strict read (commit): the first unreadable checked repo rejects the call and stops new reads', async () => {
    const started: string[] = [];
    const svcs: Record<string, ReturnType<typeof mkSvc>> = {};
    for (let i = 0; i < 10; i++) {
      const path = `/r${i}`;
      svcs[path] = mkSvc({
        getUncommittedDiff: vi.fn(() => {
          started.push(path);
          if (i === 0) return Promise.reject(new Error('index.lock'));
          return new Promise(resolve => setTimeout(() => resolve({ staged: [], unstaged: [], conflict: [] }), 0));
        }),
      });
    }
    setRepos(Object.keys(svcs), svcs);
    await expect(new ChangesWorkbench().commit('fix', false)).rejects.toThrow('r0: index.lock');
    await flush();
    expect(started).toHaveLength(8); // the pool's first window only — r8/r9 never started
  });
});

describe('ChangesTreeProvider progressive paint', () => {
  const repo = (path: string): RepoStatus => ({
    repoName: path.slice(1), repoPath: path, branch: 'main',
    staged: [], unstaged: [{ path: 'f.ts', status: 'M' }], conflict: [],
  });
  const unstagedRepoPaths = (provider: ChangesTreeProvider): string[] =>
    provider.getChildren(provider.getChildren()[1]).map(node => (node as RepoNode).repoPath);

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('paints the repos that have answered (one throttled paint per burst), then the full set', async () => {
    let finish!: (all: RepoStatus[]) => void;
    const provider = new ChangesTreeProvider((onPartial) => new Promise(resolve => {
      onPartial?.([repo('/a')]);
      onPartial?.([repo('/a'), repo('/b')]);
      finish = resolve;
    }));
    const paints: string[][] = [];
    provider.onDidChangeTreeData(() => paints.push(unstagedRepoPaths(provider)));
    const refreshing = provider.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(paints).toEqual([[]]); // readiness change; partial rows still throttled
    await vi.advanceTimersByTimeAsync(50);
    expect(paints).toEqual([[], ['/a', '/b']]); // two completions, one paint
    finish([repo('/a'), repo('/b'), repo('/c')]);
    await refreshing;
    expect(paints).toEqual([[], ['/a', '/b'], ['/a', '/b', '/c']]);
  });

  it('a partial that has nothing to show stays an empty root (no "Staged 0 / Unstaged 0" flash)', async () => {
    let finish!: (all: RepoStatus[]) => void;
    const clean: RepoStatus = { ...repo('/clean'), unstaged: [] };
    const provider = new ChangesTreeProvider((onPartial) => new Promise(resolve => { onPartial?.([clean]); finish = resolve; }));
    const paints: number[] = [];
    provider.onDidChangeTreeData(() => paints.push(provider.getChildren().length));
    const refreshing = provider.refresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(paints).toEqual([0, 0]);
    finish([clean, repo('/dirty')]);
    await refreshing;
    expect(paints).toEqual([0, 0, 2]);
  });

  it('a superseded refresh never paints its partials, even after its timer fires', async () => {
    let finishOld!: (all: RepoStatus[]) => void;
    const loads: Array<(onPartial?: (partial: RepoStatus[]) => void) => Promise<RepoStatus[]>> = [
      (onPartial) => new Promise(resolve => { onPartial?.([repo('/stale')]); finishOld = resolve; }),
      async () => [repo('/fresh')],
    ];
    const provider = new ChangesTreeProvider((onPartial) => loads.shift()!(onPartial));
    const paints: string[][] = [];
    provider.onDidChangeTreeData(() => paints.push(unstagedRepoPaths(provider)));
    const older = provider.refresh();
    await provider.refresh(); // newer wins
    await vi.advanceTimersByTimeAsync(50); // the stale partial's timer fires — must be a no-op
    finishOld([repo('/stale')]);
    await older;
    expect(paints).toEqual([[], [], ['/fresh']]);
  });
});
/* SNIPCODE-HOOK end */
