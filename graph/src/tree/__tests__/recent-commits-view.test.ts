import { describe, expect, it, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  repos: [{ path: '/repo', name: 'repo' }],
  handler: null as null | ((message: unknown) => Promise<void>),
  posted: [] as unknown[],
  opened: 0,
}));

vi.mock('vscode', () => ({
  Uri: { joinPath: (_root: unknown, ...parts: string[]) => parts.join('/') },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/repo' } }],
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  env: { language: 'en' },
  ViewColumn: { Active: 1 },
}));
vi.mock('../../panels/MainPanel', () => ({ MainPanel: { assetRootUri: undefined } }));
vi.mock('../../services/repo-discovery', () => ({ RepoDiscoveryService: { discoverRepos: vi.fn(async () => H.repos) } }));

import { RecentCommitsViewProvider } from '../recent-commits-view';

function service(over: Record<string, unknown> = {}) {
  return {
    log: vi.fn(async () => [{ hash: 'h', abbreviatedHash: 'h', subject: 'subject', refs: [{ type: 'head', name: 'HEAD' }], parents: [], author: {}, committer: {}, body: '' }]),
    branches: vi.fn(async () => [{ name: 'main', current: true, ahead: 1, behind: 2, hash: 'h' }]),
    getUncommittedDiff: vi.fn(async () => ({ staged: [{ path: 'a', status: 'M' }], unstaged: [], conflict: [] })),
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

beforeEach(() => { H.handler = null; H.posted = []; H.opened = 0; });

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
});
