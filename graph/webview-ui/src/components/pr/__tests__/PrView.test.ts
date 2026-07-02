// SNIPCODE-HOOK: PR tab (Task G3) — new component, new test file.
// SNIPCODE-HOOK: Important 1 & 2 — updated for commitsBetween now returning
// `files` directly (no compareCommits round-trip) and requestId-guarded
// responses (see PrView.svelte).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import PrView from '../PrView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { uiStore } from '../../../lib/stores/ui.svelte';
import type { BranchInfo } from '../../../lib/types';

function branch(over: Partial<BranchInfo> = {}): BranchInfo {
  return { name: 'main', current: false, ahead: 0, behind: 0, hash: 'h', ...over };
}

function deliver(type: string, payload?: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
}

function lastMessageOf(type: string) {
  const msgs = globalThis.__postedMessages.filter((m) => (m.data as { type?: string }).type === type);
  return msgs[msgs.length - 1]?.data as { type: string; payload: any } | undefined;
}

// The requestId a fresh PrView instance stamps on its first getCommitsBetween
// request (per-instance counter starting at 1 — see PrView.svelte's requestSeq).
function currentRequestId(): string {
  return lastMessageOf('getCommitsBetween')!.payload.requestId;
}

beforeEach(() => {
  i18n.setLocale('en');
  branchStore.branches = [];
  branchStore.tags = [];
  branchStore.remotes = [];
  branchStore.stashes = [];
  branchStore.worktrees = [];
  uiStore.activeRepo = '/repo';
  globalThis.__postedMessages = [];
});

afterEach(() => cleanup());

describe('PrView — default base selection', () => {
  it('uses the current branch upstream as the default base and requests getCommitsBetween', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/feat' }),
      branch({ name: 'origin/feat', remote: 'origin' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'origin/feat', head: 'HEAD', requestId: currentRequestId() });
  });

  it('falls back to origin/main when the current branch has no upstream', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'origin/main', head: 'HEAD', requestId: currentRequestId() });
  });

  it('ignores an upstream marked gone and falls back', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/gone', upstreamGone: true }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'origin/main', head: 'HEAD', requestId: currentRequestId() });
  });
});

describe('PrView — commits, ahead/behind, and Files (Important 1: files come from commitsBetween itself)', () => {
  function setup() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    return render(PrView);
  }

  it('shows the behind banner and ahead info once counts arrive', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 2, behind: 3, files: [],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('3 commit(s) behind origin/main');
      expect(container.textContent).toContain('2 commit(s) ahead of origin/main');
    });
  });

  it('renders files straight from the commitsBetween response — no separate compareCommits round-trip', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/a.ts', status: 'M' }],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('src/a.ts');
    });
    expect(lastMessageOf('compareCommits')).toBeUndefined();
  });

  it('clicking a file requests openDiff with mergeBase/HEAD refs and oldPath for a rename', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/new.ts', status: 'R', oldPath: 'src/old.ts' }],
    });
    const row = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-file-row'))
        .find((b) => b.textContent?.includes('src/new.ts'));
      expect(btn).toBeDefined();
      return btn!;
    });
    await fireEvent.click(row);
    const req = lastMessageOf('openDiff');
    expect(req?.payload).toEqual({ file: 'src/new.ts', oldPath: 'src/old.ts', ref1: 'mb', ref2: 'HEAD' });
  });

  it('ignores a commitsBetween response whose requestId no longer matches (Important 2)', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: 'stale-request', commits: [{ hash: 'x', subject: 'stale', author: 'a', date: 'd' }],
      mergeBase: 'mb', ahead: 5, behind: 5, files: [{ path: 'stale.ts', status: 'M' }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).not.toContain('stale.ts');
    expect(container.textContent).not.toContain('5 commit(s) behind');
  });

  it('discards a commitsBetween response for a base no longer selected (defense in depth)', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'some-other-branch', requestId: currentRequestId(), commits: [{ hash: 'x', subject: 's', author: 'a', date: 'd' }],
      mergeBase: 'mb', ahead: 5, behind: 5, files: [{ path: 'other.ts', status: 'M' }],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).not.toContain('other.ts');
  });

  it('clears loading on a getCommitsBetween error message (Minor 1)', async () => {
    setup();
    deliver('error', { message: 'boom', source: 'getCommitsBetween' });
    // Nothing to assert on state directly (no exposed getter), but this must
    // not throw and the Files tab must fall out of its loading spinner.
    await waitFor(() => {
      expect(document.querySelector('.spinner')).toBeNull();
    });
  });
});

describe('PrView — Copy Full Source', () => {
  function setupWithFiles() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const utils = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main',
      requestId: currentRequestId(),
      commits: [],
      mergeBase: 'mb',
      ahead: 0,
      behind: 0,
      files: [
        { path: 'src/a.ts', status: 'M' },
        { path: 'src/old.ts', status: 'R', oldPath: 'src/older.ts' },
      ],
    });
    return utils;
  }

  it('is disabled when there are no files', () => {
    branchStore.branches = [branch({ name: 'feat', current: true })];
    const { container } = render(PrView);
    const btn = container.querySelector<HTMLButtonElement>('.pr-copy-btn');
    expect(btn?.disabled).toBe(true);
  });

  it('posts snipcodeCopyFullSource with repoRootFsPath and oldRelativePath mapped from files', async () => {
    const { container } = setupWithFiles();
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.pr-copy-btn');
      expect(b?.disabled).toBe(false);
      return b!;
    });
    await fireEvent.click(btn);
    const req = lastMessageOf('snipcodeCopyFullSource');
    expect(req?.payload).toEqual({
      hash: 'HEAD',
      files: [
        { repoRootFsPath: '/repo', relativePath: 'src/a.ts', oldRelativePath: undefined, status: 'M' },
        { repoRootFsPath: '/repo', relativePath: 'src/old.ts', oldRelativePath: 'src/older.ts', status: 'R' },
      ],
    });
  });
});

describe('PrView — Commits sub-tab', () => {
  it('renders commits once switched to the Commits tab', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main',
      requestId: currentRequestId(),
      commits: [{ hash: 'abcdef1234', subject: 'Add feature', author: 'Bob', date: '2026-01-01T00:00:00Z' }],
      mergeBase: 'mb',
      ahead: 1,
      behind: 0,
      files: [],
    });
    const tabs = container.querySelectorAll<HTMLButtonElement>('.pr-subtab');
    const commitsTab = Array.from(tabs).find((b) => b.textContent?.includes('Commits'));
    await fireEvent.click(commitsTab!);
    await waitFor(() => {
      expect(container.textContent).toContain('Add feature');
      expect(container.textContent).toContain('abcdef1');
    });
  });
});

describe('PrView — repo switch resets PR state (Important 2)', () => {
  it('clears base/commits/files when uiStore.activeRepo changes', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/a.ts', status: 'M' }],
    });
    await waitFor(() => expect(container.textContent).toContain('src/a.ts'));

    uiStore.activeRepo = '/other-repo';
    branchStore.branches = [];
    await waitFor(() => {
      expect(container.textContent).not.toContain('src/a.ts');
      expect(container.textContent).toContain('Select base branch');
    });
  });
});
