import { describe, expect, it, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  repos: [{ path: '/repo', name: 'repo' }],
  handler: null as null | ((message: unknown) => Promise<void>),
  posted: [] as unknown[],
  opened: 0,
  commands: [] as unknown[][],
  errors: [] as string[],
  clipboard: [] as string[],
  copied: [] as unknown[],
}));

/** Minimal stand-in for vscode.Uri: `toGitUri` needs `.fsPath` and a `.with()`
 *  that keeps both, so the test can assert the exact scheme/query the built-in
 *  git content provider is handed. */
function uri(fsPath: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: 'file', path: fsPath, fsPath, query: '', ...over, with(change: Record<string, unknown>) { return uri(fsPath, { ...over, ...change }); } };
}

vi.mock('vscode', () => ({
  Uri: {
    joinPath: (_root: unknown, ...parts: string[]) => parts.join('/'),
    file: (fsPath: string) => uri(fsPath),
  },
  commands: { executeCommand: vi.fn(async (...args: unknown[]) => { H.commands.push(args); }) },
  window: { showErrorMessage: vi.fn((message: string) => { H.errors.push(message); }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  env: { language: 'en', clipboard: { writeText: vi.fn(async (text: string) => { H.clipboard.push(text); }) } },
  ViewColumn: { Active: 1 },
}));
vi.mock('../../panels/MainPanel', () => ({
  MainPanel: {
    assetRootUri: undefined,
    // The sidebar is a pure transfer to this host-injected handler; the runtime
    // pair must come along or the read is unspawnable on SSH-remote hosts.
    copyRuntime: { gitPath: '/usr/bin/git', gitEnv: { GIT_X: '1' } },
    copyFullSourceAtCommit: vi.fn(async (...args: unknown[]) => { H.copied.push(args); }),
  },
}));
vi.mock('../../services/repo-discovery', () => ({ RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos) } }));

import { RecentCommitsViewProvider } from '../recent-commits-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub service: each
// test overrides just the methods it exercises, so the shape is open by design.
function service(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    log: vi.fn(async () => [{ hash: 'h', abbreviatedHash: 'h', subject: 'subject', refs: [{ type: 'head', name: 'HEAD' }], parents: [], author: {}, committer: {}, body: '' }]),
    branches: vi.fn(async () => [{ name: 'main', current: true, ahead: 1, behind: 2, hash: 'h' }]),
    getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a', status: 'M' }], unstaged: [], conflict: [] })),
    // Default: an ordinary single-parent commit — no per-file overrides.
    resolveCommitFileBases: vi.fn(async () => ({ fallbackRef: 'parentsha', perFile: new Map() })),
    ...over,
  };
}

function view() {
  const listeners: Array<() => void> = [];
  return {
    visible: true,
    webview: {
      options: {}, html: '', cspSource: 'vscode-webview:',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: vi.fn((message: unknown) => { H.posted.push(message); }),
      onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { H.handler = handler; return { dispose() {} }; },
    },
    onDidChangeVisibility: (handler: () => void) => { listeners.push(handler); return { dispose() {} }; },
    onDidDispose: () => ({ dispose() {} }),
    listeners,
  };
}

beforeEach(() => {
  H.handler = null; H.posted = []; H.opened = 0;
  H.commands = []; H.errors = []; H.clipboard = []; H.copied = [];
});

/** Boot a provider on a stub service and return both. */
function boot(svc: Record<string, unknown>, repoPath = '/repo') {
  const v = view();
  const provider = new RecentCommitsViewProvider({} as never, {
    get: () => ({ path: repoPath, service: svc as never }), switchToRepo: vi.fn(), openFullGraph: vi.fn(),
  });
  provider.resolveWebviewView(v as never);
  return { v, provider };
}

describe('RecentCommitsViewProvider', () => {
  it('handshakes and refreshes the real repo data without opening the full graph', async () => {
    const svc = service();
    const v = view();
    const provider = new RecentCommitsViewProvider({} as never, {
      get: () => ({ path: '/repo', service: svc as never }),
      switchToRepo: vi.fn(),
      openFullGraph: () => { H.opened++; },
    });
    provider.resolveWebviewView(v as never);
    await H.handler!({ type: 'recentCommitsReady' });

    expect(H.opened).toBe(0);
    expect(v.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'recentCommitsState' }));
    expect(svc.log).toHaveBeenCalledWith({ branches: ['HEAD'], limit: 30 });
    expect((H.posted[0] as any).payload.graph.dots).toHaveLength(1);
    expect((H.posted[0] as any).payload.graph.dots[0].center.y).toBe(0.5);
    await H.handler!({ type: 'recentCommitsOpenGraph' });
    expect(H.opened).toBe(1);
  });

  it('keeps only the latest refresh response and skips hidden refreshes', async () => {
    let releaseOld!: (value: unknown[]) => void;
    const svcA = service({ log: vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
      });
    const svcB = service({ log: vi.fn(async () => [{ hash: 'new', abbreviatedHash: 'new', subject: 'new', refs: [{ type: 'head', name: 'HEAD' }], parents: [], author: {}, committer: {}, body: '' }]) });
    const v = view();
    let currentPath = '/a';
    const provider = new RecentCommitsViewProvider({} as never, {
      get: () => ({ path: currentPath, service: (currentPath === '/a' ? svcA : svcB) as never }), switchToRepo: vi.fn(), openFullGraph: vi.fn(),
    });
    provider.resolveWebviewView(v as never);
    const old = H.handler!({ type: 'recentCommitsReady' });
    currentPath = '/b';
    const fresh = H.handler!({ type: 'recentCommitsRefresh' });
    await fresh;
    releaseOld([{ hash: 'old', abbreviatedHash: 'old', subject: 'old', refs: [], parents: [], author: {}, committer: {}, body: '' }]);
    await old;
    const states = H.posted.filter((message: any) => message.type === 'recentCommitsState');
    expect(states).toHaveLength(1);
    expect((states[0] as any).payload.commits[0].hash).toBe('new');
    expect((states[0] as any).payload.repoPath).toBe('/b');

    H.posted = [];
    v.visible = false;
    await provider.refresh();
    expect(H.posted).toHaveLength(0);
  });

  it('keeps the repo picker populated when the active repo is unborn or unreadable', async () => {
    const svc = service({ log: vi.fn(async () => { throw new Error('does not have any commits yet'); }) });
    const v = view();
    const provider = new RecentCommitsViewProvider({} as never, {
      get: () => ({ path: '/repo', service: svc as never }), switchToRepo: vi.fn(), openFullGraph: vi.fn(),
    });
    provider.resolveWebviewView(v as never);
    await H.handler!({ type: 'recentCommitsReady' });
    const state = H.posted[0] as any;
    expect(state.payload.error).toBeUndefined();
    expect(state.payload.commits).toHaveLength(0);
    expect(state.payload.repos).toEqual(H.repos);
  });

  /* SNIPCODE-HOOK start: sidebar commit details — file list + native diff */
  // Every commit-scoped payload carries the repo it was issued for; the host
  // drops it otherwise (see the two repo tests at the end of this block).
  const FOR_REPO = { repoPath: '/repo' };

  it('serves the selected commit its file list', async () => {
    const svc = service({ showCommitFiles: vi.fn(async () => [{ path: 'src/a.ts', status: 'M' }]) });
    boot(svc);
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: 'abc1234', ...FOR_REPO } });

    expect(svc.showCommitFiles).toHaveBeenCalledWith('abc1234');
    expect(H.posted).toContainEqual({
      type: 'recentCommitsCommitFiles',
      payload: { hash: 'abc1234', files: [{ path: 'src/a.ts', status: 'M' }] },
    });
  });

  it('reports a failed file list instead of leaving the panel spinning', async () => {
    const svc = service({ showCommitFiles: vi.fn(async () => { throw new Error('bad object'); }) });
    boot(svc);
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: 'abc1234', ...FOR_REPO } });

    expect((H.posted[0] as any).payload).toMatchObject({ hash: 'abc1234', files: [], error: 'bad object' });
  });

  // A hash straight off the webview also ends up in a URI and an editor title,
  // so anything that is not an object name is dropped at the boundary.
  it('ignores a hash that is not an object name', async () => {
    const svc = service({ showCommitFiles: vi.fn() });
    boot(svc);
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: '--upload-pack=x', ...FOR_REPO } });
    await H.handler!({ type: 'recentCommitsOpenChanges', payload: { hash: 'HEAD; rm -rf /', ...FOR_REPO } });

    expect(svc.showCommitFiles).not.toHaveBeenCalled();
    expect(H.posted).toHaveLength(0);
    expect(H.commands).toHaveLength(0);
  });

  // A SHA-256 repository's %H is 64 hex, and the old 40-char cap silently
  // dropped every request there: panel stuck on "Loading", diffs no-op.
  it('accepts a 64-character SHA-256 object name', async () => {
    const sha256 = 'a'.repeat(64);
    const svc = service({ showCommitFiles: vi.fn(async () => [{ path: 'a.ts', status: 'M' }]) });
    boot(svc);
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: sha256, ...FOR_REPO } });

    expect(svc.showCommitFiles).toHaveBeenCalledWith(sha256);
    expect((H.posted[0] as any).payload.hash).toBe(sha256);
  });

  it('opens one file as a parent↔commit diff through the built-in git provider', async () => {
    const svc = service();
    boot(svc);
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: 'src/a.ts', ...FOR_REPO } });

    const [command, left, right, title] = H.commands[0] as any[];
    expect(command).toBe('vscode.diff');
    expect(left).toMatchObject({ scheme: 'git', query: JSON.stringify({ path: '/repo/src/a.ts', ref: 'parentsha' }) });
    expect(right).toMatchObject({ scheme: 'git', query: JSON.stringify({ path: '/repo/src/a.ts', ref: 'abc1234' }) });
    expect(title).toBe('a.ts (abc1234)');
  });

  // A rename did not exist under its NEW name at the parent, so the left side
  // has to come from oldPath or the diff reads as a whole-file add.
  it('resolves the left side of a rename from oldPath', async () => {
    boot(service());
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: 'src/new.ts', oldPath: 'src/old.ts', ...FOR_REPO } });

    const [, left] = H.commands[0] as any[];
    expect(left.query).toBe(JSON.stringify({ path: '/repo/src/old.ts', ref: 'parentsha' }));
  });

  // Merge: the file came in from parent 2..N, and THAT parent already knows it
  // under its new name — so ref and left path both come from the resolution,
  // never from the union list's oldPath. (Pinned against real git in
  // git/__tests__/integration/merge-file-base.integration.test.ts.)
  it('takes both the ref and the left path from the per-file merge resolution', async () => {
    const svc = service({
      resolveCommitFileBases: vi.fn(async () => ({
        fallbackRef: 'firstparent',
        perFile: new Map([['renamed.ts', { ref: 'secondparent', path: 'renamed.ts' }]]),
      })),
    });
    boot(svc);
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: 'renamed.ts', oldPath: 'a.ts', ...FOR_REPO } });

    const [, left] = H.commands[0] as any[];
    expect(left.query).toBe(JSON.stringify({ path: '/repo/renamed.ts', ref: 'secondparent' }));
  });

  it('refuses a path that escapes the repository', async () => {
    boot(service());
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: '../../etc/passwd', ...FOR_REPO } });

    expect(H.commands).toHaveLength(0);
    expect(H.errors[0]).toContain('escapes repository');
  });

  // `..foo` is an ordinary file at the repo root, not traversal — a prefix
  // test rejected it and, in a multi-diff batch, took every other file with it.
  it('opens a legitimate file whose name starts with dots', async () => {
    boot(service());
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: '..keep', ...FOR_REPO } });

    expect(H.errors).toHaveLength(0);
    expect((H.commands[0] as any[])[2].query).toBe(JSON.stringify({ path: '/repo/..keep', ref: 'abc1234' }));
  });

  it('opens every file of the commit in one multi-diff editor', async () => {
    const svc = service({
      showCommitFiles: vi.fn(async () => [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'A' }]),
    });
    boot(svc);
    await H.handler!({ type: 'recentCommitsOpenChanges', payload: { hash: 'abc1234', subject: 'feat: two files\nsecond line', ...FOR_REPO } });

    const [command, title, resources] = H.commands[0] as any[];
    expect(command).toBe('vscode.changes');
    // Native titles the multi-diff with the subject; a bare hash answers none
    // of "which commit is this". Newlines are flattened for the tab label.
    expect(title).toBe('feat: two files second line (abc1234)');
    expect(resources).toHaveLength(2);
    // [resource, original, modified] — the first drives the row label + Go To File.
    expect(resources[0][0]).toMatchObject({ scheme: 'file', fsPath: '/repo/a.ts' });
    expect(resources[0][1].query).toBe(JSON.stringify({ path: '/repo/a.ts', ref: 'parentsha' }));
    expect(resources[0][2].query).toBe(JSON.stringify({ path: '/repo/a.ts', ref: 'abc1234' }));

    H.commands = [];
    await H.handler!({ type: 'recentCommitsOpenChanges', payload: { hash: 'abc1234', ...FOR_REPO } });
    expect((H.commands[0] as any[])[1]).toBe('abc1234');
  });

  // extension.ts switches the active repo synchronously, but this view only
  // repaints once its git queries finish — so a click can arrive naming the
  // repo the user was LOOKING at while the host already points elsewhere.
  it('drops a commit request that names a repo which is no longer active', async () => {
    const svc = service({ showCommitFiles: vi.fn() });
    boot(svc, '/other');
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: 'abc1234', repoPath: '/repo' } });
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: 'a.ts', repoPath: '/repo' } });
    await H.handler!({ type: 'recentCommitsOpenChanges', payload: { hash: 'abc1234', repoPath: '/repo' } });

    expect(svc.showCommitFiles).not.toHaveBeenCalled();
    expect(H.posted).toHaveLength(0);
    expect(H.commands).toHaveLength(0);
  });

  // Windows hands the same repo out with a different drive-letter case from two
  // different sources; a `path.resolve` comparison treats those as two repos and
  // drops every click.
  it('honours a request whose repo path differs only in case or separator', async () => {
    const svc = service({ showCommitFiles: vi.fn(async () => [{ path: 'a.ts', status: 'M' }]) });
    boot(svc, 'C:\\Repo');
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: 'abc1234', repoPath: 'c:/repo' } });

    expect(svc.showCommitFiles).toHaveBeenCalledWith('abc1234');
  });

  // Losing a click is recoverable; opening another repository's file is not.
  it('drops a commit request that names no repo at all', async () => {
    const svc = service({ showCommitFiles: vi.fn() });
    boot(svc);
    await H.handler!({ type: 'recentCommitsSelectCommit', payload: { hash: 'abc1234' } });
    await H.handler!({ type: 'recentCommitsOpenFile', payload: { hash: 'abc1234', path: 'a.ts' } });

    expect(svc.showCommitFiles).not.toHaveBeenCalled();
    expect(H.commands).toHaveLength(0);
  });

  it('copies text through the clipboard, but only for the active repo', async () => {
    boot(service());
    await H.handler!({ type: 'recentCommitsCopy', payload: { text: 'abc1234', ...FOR_REPO } });
    await H.handler!({ type: 'recentCommitsCopy', payload: { text: 'wrong-repo', repoPath: '/elsewhere' } });
    await H.handler!({ type: 'recentCommitsCopy', payload: { text: '', ...FOR_REPO } });

    expect(H.clipboard).toEqual(['abc1234']);
  });

  // Copy Full Source is the reason this extension exists; the sidebar transfers
  // to the SAME host handler the graph panel uses, and builds the payload here
  // so the webview never has to know the GraphCopyPayload shape.
  it('transfers a whole commit to the host Copy Full Source handler', async () => {
    const svc = service({
      showCommitFiles: vi.fn(async () => [
        { path: 'a.ts', status: 'M' },
        { path: 'new.ts', status: 'R', oldPath: 'old.ts' },
      ]),
    });
    boot(svc);
    await H.handler!({ type: 'recentCommitsCopyFullSource', payload: { hash: 'abc1234', ...FOR_REPO } });

    const [payload, runtime] = H.copied[0] as any[];
    expect(payload).toEqual({
      hash: 'abc1234',
      files: [
        { repoRootFsPath: '/repo', relativePath: 'a.ts', oldRelativePath: undefined, status: 'M' },
        { repoRootFsPath: '/repo', relativePath: 'new.ts', oldRelativePath: 'old.ts', status: 'R' },
      ],
    });
    expect(runtime).toEqual({ gitPath: '/usr/bin/git', gitEnv: { GIT_X: '1' } });
  });

  it('narrows Copy Full Source to one file when the file menu asks for it', async () => {
    const svc = service({
      showCommitFiles: vi.fn(async () => [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'A' }]),
    });
    boot(svc);
    await H.handler!({ type: 'recentCommitsCopyFullSource', payload: { hash: 'abc1234', path: 'b.ts', ...FOR_REPO } });

    expect((H.copied[0] as any[])[0].files).toEqual([
      { repoRootFsPath: '/repo', relativePath: 'b.ts', oldRelativePath: undefined, status: 'A' },
    ]);
  });

  it('refuses a Copy Full Source path that escapes the repository', async () => {
    const svc = service({ showCommitFiles: vi.fn() });
    boot(svc);
    await H.handler!({ type: 'recentCommitsCopyFullSource', payload: { hash: 'abc1234', path: '../../etc/passwd', ...FOR_REPO } });

    expect(H.copied).toHaveLength(0);
    expect(H.errors[0]).toContain('escapes repository');
  });

  // Native's only inline action on a commit's file row opens the working file
  // itself, not a diff.
  it('opens the working-tree file', async () => {
    boot(service());
    await H.handler!({ type: 'recentCommitsOpenWorkingFile', payload: { path: 'src/a.ts', ...FOR_REPO } });

    expect(H.commands[0]).toEqual(['vscode.open', expect.objectContaining({ fsPath: '/repo/src/a.ts' })]);
  });
  /* SNIPCODE-HOOK end */
});
