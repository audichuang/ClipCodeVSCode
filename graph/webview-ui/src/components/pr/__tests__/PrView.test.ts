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
    // head now defaults to the current branch's own name (selectable/swappable),
    // not a hardcoded 'HEAD'.
    expect(req?.payload).toEqual({ base: 'origin/feat', head: 'feat', requestId: currentRequestId() });
  });

  it('falls back to origin/main when the current branch has no upstream', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'origin/main', head: 'feat', requestId: currentRequestId() });
  });

  it('ignores an upstream marked gone and falls back', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/gone', upstreamGone: true }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'origin/main', head: 'feat', requestId: currentRequestId() });
  });

  it('does not request getCommitsBetween until a head is available (no current branch marked)', () => {
    branchStore.branches = [branch({ name: 'origin/main', remote: 'origin' })];
    const { container } = render(PrView);
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    expect(pills[1].textContent).toContain('HEAD');
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
    expect(req?.payload).toEqual({ file: 'src/new.ts', oldPath: 'src/old.ts', ref1: 'mb', ref2: 'feat' });
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
      hash: 'feat',
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

describe('PrView — repo switch resets PR state (Important 2 + repo-switch race)', () => {
  it('does NOT auto-select a base from the OLD repo branches when activeRepo changes before branchData', async () => {
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

    // Real ordering: the host posts `repoList` (activeRepo) FIRST, while
    // `branchStore.branches` is still the previous repo's list. State must
    // reset, but no base may be auto-selected from that stale list yet.
    globalThis.__postedMessages = [];
    uiStore.activeRepo = '/other-repo';
    await waitFor(() => {
      expect(container.textContent).not.toContain('src/a.ts');
      expect(container.textContent).toContain('Select base branch');
    });
    // Give any (buggy) default-base effect a tick to fire off the stale list.
    await new Promise((r) => setTimeout(r, 0));
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();

    // The new repo's branches arrive on a later tick (branchData) as a fresh
    // array reference — only now may a base be auto-selected, from the NEW list.
    branchStore.branches = [
      branch({ name: 'dev', current: true, upstream: 'origin/dev' }),
      branch({ name: 'origin/dev', remote: 'origin' }),
    ];
    await waitFor(() => {
      // head resets on repo switch too and is re-picked from the NEW repo's
      // current branch ('dev'), never carried over from the old repo ('feat').
      expect(lastMessageOf('getCommitsBetween')?.payload).toEqual({
        base: 'origin/dev', head: 'dev', requestId: currentRequestId(),
      });
    });
  });

  // SNIPCODE-HOOK: PR tab (Important, repo-switch stale-head race) — proves
  // the pickers are inert during the awaitingBranches window: a pick made
  // while the OLD repo's branches are still rendered must not set base/head
  // or fire getCommitsBetween, and once the new branches land the normal
  // default-selection flow still fires exactly one request from the NEW list.
  it('blocks selectBase/selectHead while awaitingBranches, then picks defaults from the NEW repo once branches arrive', async () => {
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

    // Trigger the switch: activeRepo changes first, branchStore.branches is
    // still the OLD repo's list (real host ordering — repoList before
    // branchData) — this is the awaitingBranches window.
    globalThis.__postedMessages = [];
    uiStore.activeRepo = '/other-repo';
    await waitFor(() => expect(container.textContent).toContain('Select base branch'));

    // Both pickers must be disabled while awaitingBranches, and a direct call
    // must be a no-op even if something still reaches them (e.g. a dropdown
    // left open across the switch).
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    expect(pills[0].disabled).toBe(true);
    expect(pills[1].disabled).toBe(true);
    await fireEvent.click(pills[0]);
    expect(container.querySelector('.repo-dropdown')).toBeNull();

    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();

    // New repo's branches arrive as a fresh array reference — awaitingBranches
    // clears, pickers re-enable, and defaults pick from the NEW list only.
    branchStore.branches = [
      branch({ name: 'dev', current: true, upstream: 'origin/dev' }),
      branch({ name: 'origin/dev', remote: 'origin' }),
    ];
    await waitFor(() => {
      expect(pills[0].disabled).toBe(false);
      expect(lastMessageOf('getCommitsBetween')?.payload).toEqual({
        base: 'origin/dev', head: 'dev', requestId: currentRequestId(),
      });
    });
  });
});

describe('PrView — head selectable + swap', () => {
  function setup() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
      branch({ name: 'dev' }),
    ];
    return render(PrView);
  }

  function openHeadDropdown(container: HTMLElement) {
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    return fireEvent.click(pills[1]);
  }

  function findDropdownItem(container: HTMLElement, name: string) {
    return waitFor(() => {
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('.repo-dropdown-item'))
        .find((b) => b.textContent?.includes(name));
      expect(btn).toBeDefined();
      return btn!;
    });
  }

  it('selecting a different head re-requests getCommitsBetween with the new head, same base', async () => {
    const { container } = setup();
    globalThis.__postedMessages = [];
    await openHeadDropdown(container);
    const devBtn = await findDropdownItem(container, 'dev');
    await fireEvent.click(devBtn);
    await waitFor(() => {
      const req = lastMessageOf('getCommitsBetween');
      expect(req?.payload).toEqual({ base: 'origin/main', head: 'dev', requestId: currentRequestId() });
    });
  });

  it('swap exchanges base and head and re-requests getCommitsBetween with them swapped', async () => {
    const { container } = setup();
    globalThis.__postedMessages = [];
    const swapBtn = container.querySelector<HTMLButtonElement>('.pr-swap-btn');
    expect(swapBtn).toBeTruthy();
    await fireEvent.click(swapBtn!);
    await waitFor(() => {
      const req = lastMessageOf('getCommitsBetween');
      expect(req?.payload).toEqual({ base: 'feat', head: 'origin/main', requestId: currentRequestId() });
    });
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    expect(pills[0].textContent).toContain('feat');
    expect(pills[1].textContent).toContain('origin/main');
  });

  it('copyAll sends the selected head, not a hardcoded HEAD', async () => {
    const { container } = setup();
    await openHeadDropdown(container);
    const devBtn = await findDropdownItem(container, 'dev');
    await fireEvent.click(devBtn);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/b.ts', status: 'M' }],
    });
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.pr-copy-btn');
      expect(b?.disabled).toBe(false);
      return b!;
    });
    await fireEvent.click(btn);
    const req = lastMessageOf('snipcodeCopyFullSource');
    expect(req?.payload.hash).toBe('dev');
  });

  it('openFile sends the selected head as ref2', async () => {
    const { container } = setup();
    await openHeadDropdown(container);
    const devBtn = await findDropdownItem(container, 'dev');
    await fireEvent.click(devBtn);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/new.ts', status: 'M' }],
    });
    const row = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-file-row'))
        .find((b) => b.textContent?.includes('src/new.ts'));
      expect(btn).toBeDefined();
      return btn!;
    });
    await fireEvent.click(row);
    const req = lastMessageOf('openDiff');
    expect(req?.payload).toEqual({ file: 'src/new.ts', oldPath: undefined, ref1: 'mb', ref2: 'dev' });
  });
});
