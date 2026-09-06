// SNIPCODE-HOOK: PR tab (Task G3) — new component, new test file.
// SNIPCODE-HOOK: Important 1 & 2 — updated for commitsBetween now returning
// `files` directly (no compareCommits round-trip) and requestId-guarded
// responses (see PrView.svelte).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import PrView from '../PrView.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { branchStore } from '../../../lib/stores/branches.svelte';
import { uiStore } from '../../../lib/stores/ui.svelte';
import type { BranchInfo, DiffData } from '../../../lib/types';

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
    // head pill is now first (GitHub-style "head into base" layout)
    expect(pills[0].textContent).toContain('HEAD');
  });

  // SNIPCODE-HOOK start: PR tab (P0-2/P2) local-branch fallback — a repo with
  // no remote configured at all used to leave `base` permanently null (the
  // "pickBase" empty state forever); falls back to a conventional local
  // mainline branch instead.
  it('falls back to a local "develop" branch when there is no upstream and no remotes at all', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true }),
      branch({ name: 'develop' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'develop', head: 'feat', requestId: currentRequestId() });
  });

  it('prefers "main" over "develop" when both exist locally (no upstream/remotes)', () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true }),
      branch({ name: 'develop' }),
      branch({ name: 'main' }),
    ];
    render(PrView);
    const req = lastMessageOf('getCommitsBetween');
    expect(req?.payload).toEqual({ base: 'main', head: 'feat', requestId: currentRequestId() });
  });

  it('does not fall back to the current branch itself even if it is named "main"', () => {
    branchStore.branches = [branch({ name: 'main', current: true })];
    const { container } = render(PrView);
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();
    expect(container.textContent).toContain('Select a base branch to compare against.');
  });
  // SNIPCODE-HOOK end
});

describe('PrView — commits, ahead/behind, and Files (Important 1: files come from commitsBetween itself)', () => {
  function setup() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    return render(PrView);
  }

  // SNIPCODE-HOOK: PR tab (P4/X2) — replaces the old two-separate-banners
  // assertion ("N commit(s) behind/ahead of ...") now that both banners are
  // merged into one .pr-stats-row (ahead/behind/merge-base/file-count/+-).
  it('shows a merged ahead/behind/merge-base/files stats row once counts arrive', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'abcdef1234', ahead: 2, behind: 3,
      files: [{ path: 'a.ts', status: 'M' }],
    });
    await waitFor(() => {
      const row = container.querySelector('.pr-stats-row');
      expect(row).toBeTruthy();
      expect(row!.textContent).toContain('2 ahead');
      expect(row!.textContent).toContain('3 behind');
      expect(row!.textContent).toContain('abcdef1'); // merge-base, sliced to 7 chars
      expect(row!.textContent).toContain('1 files');
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

  // SNIPCODE-HOOK: PR tab inline diff (Task D2) — a file with no parsed diff
  // (missing from commitsBetween.diffs, e.g. binary/unparseable) renders as a
  // placeholder in the diff stack; its "Open native diff" button is now what
  // requests openDiff (the plain file row instead scrolls to it — see the
  // "clicking a file scrolls" test below).
  it('a file with no parsed diff shows a placeholder whose "Open native diff" button requests openDiff (mergeBase/HEAD refs, oldPath for a rename)', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/new.ts', status: 'R', oldPath: 'src/old.ts' }],
      diffs: [],
    });
    const btn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-open-native-btn'))
        .find((el) => el.closest('[data-pr-file="src/new.ts"]'));
      expect(b).toBeDefined();
      return b!;
    });
    await fireEvent.click(btn);
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
    // SNIPCODE-HOOK: PR tab (P4/X2) — mergeBase (and so .pr-stats-row) never
    // got set from the stale/mismatched response, so the row shouldn't exist.
    expect(container.querySelector('.pr-stats-row')).toBeNull();
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

// SNIPCODE-HOOK start: PR tab (P1/R7) stale-data refresh — a commit, fetch,
// pull, or checkout while the PR tab is open re-posts branchData (host
// fullRefresh), which reassigns branchStore.branches to a new array even
// though there was no repo switch. Once a compare is already configured
// (base && head both selected) that must re-request the same compare instead
// of leaving the PR tab showing stale commits/files/ahead-behind forever.
describe('PrView — stale-data refresh (P1/R7)', () => {
  it('reassigning branchStore.branches (a host branchData/fullRefresh arrival) re-requests getCommitsBetween for the current compare', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    render(PrView);
    await waitFor(() => expect(lastMessageOf('getCommitsBetween')).toBeDefined());
    const firstReqId = currentRequestId();

    globalThis.__postedMessages = [];
    // New array reference, same content — this is exactly what
    // branchStore.setData() does on every fullRefresh, repo switch or not.
    branchStore.branches = [...branchStore.branches];

    await waitFor(() => {
      const req = lastMessageOf('getCommitsBetween');
      expect(req?.payload).toEqual({ base: 'origin/main', head: 'feat', requestId: currentRequestId() });
      expect(req?.payload.requestId).not.toBe(firstReqId);
    });
  });

  it('does not clear the currently-shown files while a background refresh is in flight (no flicker)', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb1', ahead: 1, behind: 0,
      files: [{ path: 'src/a.ts', status: 'M' }],
    });
    await waitFor(() => expect(container.textContent).toContain('src/a.ts'));

    globalThis.__postedMessages = [];
    branchStore.branches = [...branchStore.branches]; // triggers the background refresh
    await waitFor(() => expect(lastMessageOf('getCommitsBetween')).toBeDefined());

    // The refresh request is now in flight (no response delivered yet), but
    // the previous compare's file must still be visible — no spinner, no
    // "No changed files" flash.
    expect(container.textContent).toContain('src/a.ts');
    expect(document.querySelector('.spinner')).toBeNull();
  });
});
// SNIPCODE-HOOK end

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
    // head pill is first in the "head into base" layout
    return fireEvent.click(pills[0]);
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
    // pills[0] = head, pills[1] = base; after swap head='origin/main', base='feat'
    expect(pills[0].textContent).toContain('origin/main');
    expect(pills[1].textContent).toContain('feat');
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

  it('openFile (via the placeholder\'s Open native diff button) sends the selected head as ref2', async () => {
    const { container } = setup();
    await openHeadDropdown(container);
    const devBtn = await findDropdownItem(container, 'dev');
    await fireEvent.click(devBtn);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/new.ts', status: 'M' }],
      diffs: [],
    });
    const btn = await waitFor(() => {
      const b = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-open-native-btn'))
        .find((el) => el.closest('[data-pr-file="src/new.ts"]'));
      expect(b).toBeDefined();
      return b!;
    });
    await fireEvent.click(btn);
    const req = lastMessageOf('openDiff');
    expect(req?.payload).toEqual({ file: 'src/new.ts', oldPath: undefined, ref1: 'mb', ref2: 'dev' });
  });
});

// SNIPCODE-HOOK start: PR tab (P0-2/P2) empty-state machine — "No changed
// files"/"No commits" used to be shared by four unrelated situations
// (nothing picked yet, detached HEAD, a host error, a genuine no-diff
// compare); each now gets its own message via PrView's emptyReason().
describe('PrView — empty-state machine (P0-2/P2)', () => {
  it('"pickBase": no current branch marked and no remotes/local-mainline fallback — shows the pick-a-base message', async () => {
    branchStore.branches = [branch({ name: 'some-topic-branch' })];
    const { container } = render(PrView);
    await waitFor(() => {
      expect(container.textContent).toContain('Select a base branch to compare against.');
    });
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();
  });

  it('"detached": HEAD detached — shows the detached message even though other local branches exist', async () => {
    branchStore.branches = [
      branch({ name: '(HEAD detached at abc1234)', current: true, detached: true }),
      branch({ name: 'develop' }),
      branch({ name: 'main' }),
    ];
    const { container } = render(PrView);
    await waitFor(() => {
      expect(container.textContent).toContain('HEAD is detached');
    });
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();
  });

  it('"error": a host error while a compare is configured — shows the error message inline instead of "No changed files"', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    await waitFor(() => expect(lastMessageOf('getCommitsBetween')).toBeDefined());
    deliver('error', { message: 'unknown revision', source: 'getCommitsBetween' });
    await waitFor(() => {
      expect(container.textContent).toContain('Could not load comparison: unknown revision');
      expect(container.textContent).not.toContain('No changed files');
    });
  });

  it('"sameRef": base and head selected to the same branch — shows the same-ref message, not "No changed files"', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    await waitFor(() => expect(lastMessageOf('getCommitsBetween')).toBeDefined());

    // Pick 'origin/main' (the current base) as head too, via the head dropdown.
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]); // head pill is first
    const sameRefItem = await waitFor(() => {
      const btn = Array.from(container.querySelectorAll<HTMLButtonElement>('.repo-dropdown-item'))
        .find((b) => b.textContent?.includes('origin/main'));
      expect(btn).toBeDefined();
      return btn!;
    });
    await fireEvent.click(sameRefItem);

    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'origin/main', ahead: 0, behind: 0, files: [],
    });
    await waitFor(() => {
      expect(container.textContent).toContain('are the same ref');
      expect(container.textContent).not.toContain('No changed files');
    });
  });
});
// SNIPCODE-HOOK end

// SNIPCODE-HOOK start: PR tab branch-dropdown type-to-filter — both the base
// and head dropdowns gain a filter input at the top; typing narrows the list
// to a case-insensitive substring match, an empty/no-match result shows "No
// matching branches", the input auto-focuses on open, and closing (select,
// backdrop click, Escape) clears the filter for the next open.
describe('PrView — branch dropdown type-to-filter', () => {
  function setup() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
      branch({ name: 'origin/develop', remote: 'origin' }),
      branch({ name: 'release/1.0' }),
    ];
    return render(PrView);
  }

  function filterInput(container: HTMLElement) {
    return container.querySelector<HTMLInputElement>('.repo-dropdown .dropdown-filter-input');
  }

  // SNIPCODE-HOOK: PR tab (Medium fix) — the dropdown item for the currently
  // selected branch (marked via class:active in PrView.svelte).
  function findActiveItem(container: HTMLElement) {
    return waitFor(() => {
      const btn = container.querySelector<HTMLButtonElement>('.repo-dropdown-item.active');
      expect(btn).toBeTruthy();
      return btn!;
    });
  }

  it('auto-focuses the base filter input when the dropdown opens', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]);
    const input = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(document.activeElement).toBe(input);
  });

  it('filters the base branch list case-insensitively as the user types', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]);
    const input = filterInput(container)!;
    await fireEvent.input(input, { target: { value: 'DEV' } });
    await waitFor(() => {
      const items = Array.from(container.querySelectorAll<HTMLButtonElement>('.repo-dropdown-item'));
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('origin/develop');
    });
  });

  it('shows "No matching branches" when nothing matches the filter', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]);
    const input = filterInput(container)!;
    await fireEvent.input(input, { target: { value: 'zzz-no-such-branch' } });
    await waitFor(() => {
      expect(container.querySelector('.repo-dropdown-empty')).toBeTruthy();
      expect(container.textContent).toContain('No matching branches');
      expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(0);
    });
  });

  it('clears the base filter when the dropdown closes (backdrop click) and reopens with the full list', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]);
    const input = filterInput(container)!;
    await fireEvent.input(input, { target: { value: 'dev' } });
    await waitFor(() => expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(1));

    await fireEvent.click(container.querySelector('.repo-dropdown-backdrop')!);
    expect(container.querySelector('.repo-dropdown')).toBeNull();

    await fireEvent.click(pills[0]);
    const reopened = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(reopened.value).toBe('');
    expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(4);
  });

  it('filters the head branch list the same way', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[1]);
    const input = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    await fireEvent.input(input, { target: { value: 'release' } });
    await waitFor(() => {
      const items = Array.from(container.querySelectorAll<HTMLButtonElement>('.repo-dropdown-item'));
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('release/1.0');
    });
  });

  it('pressing Enter selects the first filtered result and closes the dropdown', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    await fireEvent.click(pills[0]);
    const input = filterInput(container)!;
    await fireEvent.input(input, { target: { value: 'develop' } });
    await waitFor(() => expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(1));
    await fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(pills[0].textContent).toContain('origin/develop');
    });
    expect(container.querySelector('.repo-dropdown')).toBeNull();
  });

  it('pressing Escape closes the dropdown without selecting anything', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    // base pill is now second (head into base); its default is 'origin/main', not 'feat'
    await fireEvent.click(pills[1]);
    const input = filterInput(container)!;
    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('.repo-dropdown')).toBeNull();
    expect(pills[1].textContent).not.toContain('feat');
  });

  // SNIPCODE-HOOK start: PR tab (Medium fix) — picking the already-selected
  // branch is still a "pick" and must close+clear the dropdown per the pick
  // contract; only the reload is skipped since base/head is unchanged. Before
  // the fix, `if (base === b) return;` fired before closeBaseDropdown(),
  // leaving the dropdown open with a live filter.
  it('picking the already-selected base still closes+clears the dropdown, without a new getCommitsBetween', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    // base pill is now second (head into base layout)
    await fireEvent.click(pills[1]);
    // Default base is 'origin/main' (current branch's upstream) — filter down
    // to just that already-active item.
    const input = filterInput(container)!;
    await fireEvent.input(input, { target: { value: 'origin/main' } });
    await waitFor(() => expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(1));

    globalThis.__postedMessages = [];
    const activeBtn = await findActiveItem(container);
    await fireEvent.click(activeBtn);

    expect(container.querySelector('.repo-dropdown')).toBeNull();
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();

    // Reopening starts with a cleared filter, proving the filter was reset,
    // not just the dropdown hidden.
    await fireEvent.click(pills[1]);
    const reopened = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(reopened.value).toBe('');
    expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(4);
  });

  it('picking the already-selected head still closes+clears the dropdown, without a new getCommitsBetween', async () => {
    const { container } = setup();
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    // head pill is now first (head into base layout)
    await fireEvent.click(pills[0]);
    // Default head is 'feat' (the current branch) — filter down to just that
    // already-active item.
    const input = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    await fireEvent.input(input, { target: { value: 'feat' } });
    await waitFor(() => expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(1));

    globalThis.__postedMessages = [];
    const activeBtn = await findActiveItem(container);
    await fireEvent.click(activeBtn);

    expect(container.querySelector('.repo-dropdown')).toBeNull();
    expect(lastMessageOf('getCommitsBetween')).toBeUndefined();

    await fireEvent.click(pills[0]);
    const reopened = await waitFor(() => {
      const el = filterInput(container);
      expect(el).toBeTruthy();
      return el!;
    });
    expect(reopened.value).toBe('');
    expect(container.querySelectorAll('.repo-dropdown-item').length).toBe(4);
  });
  // SNIPCODE-HOOK end

  it('disabled while awaitingBranches: clicking the base pill does not open the dropdown or its filter input', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    await waitFor(() => expect(lastMessageOf('getCommitsBetween')).toBeDefined());
    uiStore.activeRepo = '/other-repo';
    await waitFor(() => expect(container.textContent).toContain('Select base branch'));
    const pills = container.querySelectorAll<HTMLButtonElement>('.base-pill');
    expect(pills[0].disabled).toBe(true);
    await fireEvent.click(pills[0]);
    expect(container.querySelector('.repo-dropdown')).toBeNull();
  });
});
// SNIPCODE-HOOK end

// SNIPCODE-HOOK start: PR tab inline diff (Task D2) — PrView renders
// FileDiffView stacked per changed file straight from commitsBetween.diffs
// (Task D1), drives a shared inline/side-by-side toggle across all of them,
// and offers prev/next-change scrolling within the shared .pr-content pane.
describe('PrView — inline diff preview (Task D2)', () => {
  function diffFixture(file: string, line: string): DiffData {
    return {
      file,
      isBinary: false,
      isImage: false,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: 'add', content: line, newLineNumber: 1 }],
        },
      ],
    };
  }

  function setupWithDiffs() {
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
        { path: 'src/b.ts', status: 'M' },
      ],
      diffs: [diffFixture('src/a.ts', 'hello-from-a'), diffFixture('src/b.ts', 'hello-from-b')],
    });
    return utils;
  }

  it('renders a stacked, mode-toggle-hidden FileDiffView per changed file from commitsBetween.diffs', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => {
      expect(container.textContent).toContain('hello-from-a');
      expect(container.textContent).toContain('hello-from-b');
    });
    // Each stacked FileDiffView's own built-in toggle is hidden — PrView
    // drives mode from one shared toolbar control instead (hideModeToggle).
    expect(container.querySelectorAll('.diff-mode-toggle').length).toBe(0);
  });

  it('shows a placeholder with an "Open native diff" button for a file missing from diffs (binary/unparseable)', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'assets/logo.png', status: 'M' }],
      diffs: [],
    });
    await waitFor(() => {
      expect(container.querySelector('.pr-open-native-btn')).toBeTruthy();
      expect(container.textContent).toContain('assets/logo.png');
    });
  });

  // SNIPCODE-HOOK: PR tab inline diff (Task D2 fix, blocking review finding) —
  // D1's parseDiff DOES return a DiffData entry for binary files (isBinary:
  // true, empty hunks — git-parser.ts:248-252), so this is NOT the "missing
  // from diffs" case above: `d` is found, but must still route to the
  // placeholder rather than <FileDiffView>, since FileDiffView would render
  // <ImageDiff> with no commitHash (PrView has no single commit — base..head
  // is a range) and silently compare the wrong things (index vs working tree).
  it('a binary/image diffs entry (isBinary+isImage) shows the placeholder, not FileDiffView, and its native-diff button uses the mergeBase/head refs', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'assets/logo.png', status: 'M' }],
      diffs: [{ file: 'assets/logo.png', isBinary: true, isImage: true, hunks: [] }],
    });
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.pr-open-native-btn');
      expect(b).toBeTruthy();
      return b!;
    });
    expect(container.textContent).toContain('assets/logo.png');
    // Never rendered via FileDiffView/ImageDiff for this range comparison.
    expect(container.querySelector('.diff-content')).toBeNull();
    expect(container.querySelector('.diff-sbs')).toBeNull();
    expect(container.querySelector('img')).toBeNull();

    await fireEvent.click(btn);
    const req = lastMessageOf('openDiff');
    expect(req?.payload).toEqual({ file: 'assets/logo.png', oldPath: undefined, ref1: 'mb', ref2: 'feat' });
  });

  // SNIPCODE-HOOK start: PR tab (Minor fix) — a pure rename/mode-only/empty
  // add-delete diff is NOT binary but has hunks: [], so `d` is found and
  // !d.isBinary is true; without the hunks.length > 0 check this used to
  // render an empty FileDiffView with nothing to show and no way to see the
  // actual change. Must fall through to the same placeholder + native-diff
  // fallback as binary files.
  it('a non-binary diffs entry with zero hunks (e.g. a pure rename) shows the placeholder, not an empty FileDiffView', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/renamed.ts', status: 'R', oldPath: 'src/original.ts' }],
      diffs: [{ file: 'src/renamed.ts', isBinary: false, isImage: false, hunks: [] }],
    });
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.pr-open-native-btn');
      expect(b).toBeTruthy();
      return b!;
    });
    expect(container.textContent).toContain('src/renamed.ts');
    // Never rendered via FileDiffView for a zero-hunk diff.
    expect(container.querySelector('.diff-content')).toBeNull();
    expect(container.querySelector('.diff-sbs')).toBeNull();

    await fireEvent.click(btn);
    const req = lastMessageOf('openDiff');
    expect(req?.payload).toEqual({ file: 'src/renamed.ts', oldPath: 'src/original.ts', ref1: 'mb', ref2: 'feat' });
  });
  // SNIPCODE-HOOK end

  it('clicking a file in the left list scrolls to its matching stacked FileDiffView section', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-file-row'))
      .find((b) => b.textContent?.includes('src/b.ts'))!;
    await fireEvent.click(row);
    expect(scrollSpy).toHaveBeenCalled();
    const scrolledEl = scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1] as unknown as HTMLElement;
    expect(scrolledEl.closest('[data-pr-file="src/b.ts"]')).toBeTruthy();
    // The old click-opens-native-diff behavior is gone for files with a parsed diff.
    expect(lastMessageOf('openDiff')).toBeUndefined();
    scrollSpy.mockRestore();
  });

  it('the shared toolbar toggle switches every stacked FileDiffView between inline and side-by-side', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    expect(container.querySelectorAll('.diff-sbs').length).toBe(0);
    const sbsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-diff-mode-toggle button'))
      .find((b) => b.textContent?.includes('Side by Side'))!;
    await fireEvent.click(sbsBtn);
    await waitFor(() => {
      expect(container.querySelectorAll('.diff-sbs').length).toBe(2);
    });
  });

  // SNIPCODE-HOOK start: PR tab prev/next-change nav (fix) — replaces the old
  // viewport-center-cursor test above. jumpChange now tracks a plain index
  // (currentHunk, starting at -1) into the flattened hunk list instead of
  // comparing getBoundingClientRect().top against the pane's center line —
  // the old cursor put the FIRST hunk above center on initial load, so the
  // first "next" click skipped it (a single-hunk PR's "next" was a permanent
  // no-op), and "prev" at the top could re-jump to that same first hunk.
  // scrollIntoView is stubbed to a no-op throughout; only which element it
  // was called on matters here.
  it('first "next" click selects the first hunk (not the second) on initial load', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const hunks = Array.from(container.querySelectorAll<HTMLElement>('.diff-hunk'));
    expect(hunks.length).toBe(2);
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

    await fireEvent.click(container.querySelector<HTMLButtonElement>('.pr-jump-next')!);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.instances[0]).toBe(hunks[0]);

    scrollSpy.mockRestore();
  });

  it('"prev" before any "next" is a no-op (no scroll, nothing to go back to)', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

    await fireEvent.click(container.querySelector<HTMLButtonElement>('.pr-jump-prev')!);
    expect(scrollSpy).not.toHaveBeenCalled();

    scrollSpy.mockRestore();
  });

  it('next/prev advance and step back one logical hunk at a time; "prev" at the first hunk is a no-op', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const hunks = Array.from(container.querySelectorAll<HTMLElement>('.diff-hunk'));
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;
    const prevBtn = container.querySelector<HTMLButtonElement>('.pr-jump-prev')!;

    await fireEvent.click(nextBtn); // -1 -> 0
    expect(scrollSpy.mock.instances[0]).toBe(hunks[0]);
    await fireEvent.click(nextBtn); // 0 -> 1
    expect(scrollSpy.mock.instances[1]).toBe(hunks[1]);
    await fireEvent.click(nextBtn); // clamped at last index (1)
    expect(scrollSpy.mock.instances[2]).toBe(hunks[1]);
    await fireEvent.click(prevBtn); // 1 -> 0
    expect(scrollSpy.mock.instances[3]).toBe(hunks[0]);
    expect(scrollSpy).toHaveBeenCalledTimes(4);

    await fireEvent.click(prevBtn); // at 0: no-op, no extra scroll
    expect(scrollSpy).toHaveBeenCalledTimes(4);

    scrollSpy.mockRestore();
  });

  it('a single-hunk PR: "next" jumps to it, a second "next" is a no-op past the end', async () => {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    const { container } = render(PrView);
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/a.ts', status: 'M' }],
      diffs: [diffFixture('src/a.ts', 'hello-from-a')],
    });
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const hunk = container.querySelector<HTMLElement>('.diff-hunk')!;
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;

    await fireEvent.click(nextBtn);
    expect(scrollSpy.mock.instances[0]).toBe(hunk);
    await fireEvent.click(nextBtn); // clamped, still index 0 — scrolls to the same hunk again
    expect(scrollSpy.mock.instances[1]).toBe(hunk);

    scrollSpy.mockRestore();
  });

  it('side-by-side mode advances one logical hunk at a time (dedupes the left/right .sbs-hunk pair)', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const sbsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-diff-mode-toggle button'))
      .find((b) => b.textContent?.includes('Side by Side'))!;
    await fireEvent.click(sbsBtn);
    await waitFor(() => expect(container.querySelectorAll('.diff-sbs').length).toBe(2));

    const leftHunks = Array.from(container.querySelectorAll<HTMLElement>('.sbs-left .sbs-hunk'));
    expect(leftHunks.length).toBe(2); // one per file, not doubled by the right pane
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;

    await fireEvent.click(nextBtn);
    expect(scrollSpy.mock.instances[0]).toBe(leftHunks[0]);
    await fireEvent.click(nextBtn);
    expect(scrollSpy.mock.instances[1]).toBe(leftHunks[1]);

    scrollSpy.mockRestore();
  });

  it('resets the jump cursor on a diffMode switch (next after switching selects the first hunk again)', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    await fireEvent.click(nextBtn); // advance to hunk 0 in inline mode

    const sbsBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-diff-mode-toggle button'))
      .find((b) => b.textContent?.includes('Side by Side'))!;
    await fireEvent.click(sbsBtn);
    await waitFor(() => expect(container.querySelectorAll('.diff-sbs').length).toBe(2));

    const leftHunks = Array.from(container.querySelectorAll<HTMLElement>('.sbs-left .sbs-hunk'));
    await fireEvent.click(nextBtn); // must land on the first hunk again, not advance to the second
    expect(scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1]).toBe(leftHunks[0]);

    scrollSpy.mockRestore();
  });

  it('resets the jump cursor when the compare changes (base/head swap triggers a new compare)', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;
    const hunksBefore = Array.from(container.querySelectorAll<HTMLElement>('.diff-hunk'));
    await fireEvent.click(nextBtn); // -1 -> 0
    await fireEvent.click(nextBtn); // 0 -> 1
    expect(scrollSpy.mock.instances[1]).toBe(hunksBefore[1]);

    // Swap base/head: loadCommits clears diffs and resets currentHunk to -1
    // before the new response even lands.
    const swapBtn = container.querySelector<HTMLButtonElement>('.pr-swap-btn')!;
    await fireEvent.click(swapBtn);
    deliver('commitsBetween', {
      base: 'feat', requestId: currentRequestId(), commits: [], mergeBase: 'mb', ahead: 0, behind: 0,
      files: [{ path: 'src/c.ts', status: 'M' }],
      diffs: [diffFixture('src/c.ts', 'hello-from-c')],
    });
    await waitFor(() => expect(container.textContent).toContain('hello-from-c'));

    const newHunk = container.querySelector<HTMLElement>('.diff-hunk')!;
    await fireEvent.click(nextBtn); // must land on the first hunk of the NEW diff set, not advance past it
    expect(scrollSpy.mock.instances[scrollSpy.mock.instances.length - 1]).toBe(newHunk);

    scrollSpy.mockRestore();
  });
});
// SNIPCODE-HOOK end

// SNIPCODE-HOOK start: PR tab resizable file-list/diff splitter — mirrors
// CommitDetails.svelte's resize-handle pattern (startResize/onResizeMove/
// stopResize on document mousemove/mouseup) for the Files sub-tab's
// file-list/diff split, which previously had a CSS-fixed width.
describe('PrView — resizable file-list/diff splitter', () => {
  function diffFixture(file: string, line: string): DiffData {
    return {
      file,
      isBinary: false,
      isImage: false,
      hunks: [
        {
          header: '@@ -1 +1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [{ type: 'add', content: line, newLineNumber: 1 }],
        },
      ],
    };
  }

  function setupWithDiffs() {
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
      files: [{ path: 'src/a.ts', status: 'M' }],
      diffs: [diffFixture('src/a.ts', 'hello-from-a')],
    });
    return utils;
  }

  it('renders a resize handle between the file list and diff stack, with the file list at the default 240px width', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    // SNIPCODE-HOOK: PR tab resize handle (review fix, High) — Svelte's
    // scoped <style> block isn't injected under this project's vitest/
    // happy-dom setup (getComputedStyle on .pr-resize-handle returns ''), so
    // the height/single-divider CSS fix can't be asserted via computed style
    // here; it's covered by the drag/clamp behavior below plus manual
    // verification that the handle spans the row's full height in-app.
    expect(container.querySelector('.pr-resize-handle')).toBeTruthy();
    const fileList = container.querySelector<HTMLElement>('.pr-file-list')!;
    expect(fileList.style.width).toBe('240px');
  });

  it('dragging the handle resizes the file list, clamped to 120-600px', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const handle = container.querySelector<HTMLElement>('.pr-resize-handle')!;
    const fileList = container.querySelector<HTMLElement>('.pr-file-list')!;

    await fireEvent.mouseDown(handle, { clientX: 100 });
    await fireEvent(document, new MouseEvent('mousemove', { clientX: 150 }));
    expect(fileList.style.width).toBe('290px'); // 240 + (150 - 100)

    await fireEvent(document, new MouseEvent('mousemove', { clientX: -10000 }));
    expect(fileList.style.width).toBe('120px'); // clamped to min

    await fireEvent(document, new MouseEvent('mousemove', { clientX: 10000 }));
    expect(fileList.style.width).toBe('600px'); // clamped to max
  });

  it('stops resizing on mouseup — a later mousemove no longer changes the width', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const handle = container.querySelector<HTMLElement>('.pr-resize-handle')!;
    const fileList = container.querySelector<HTMLElement>('.pr-file-list')!;

    await fireEvent.mouseDown(handle, { clientX: 100 });
    await fireEvent(document, new MouseEvent('mousemove', { clientX: 150 }));
    expect(fileList.style.width).toBe('290px');

    await fireEvent(document, new MouseEvent('mouseup'));
    await fireEvent(document, new MouseEvent('mousemove', { clientX: 400 }));
    expect(fileList.style.width).toBe('290px');
  });

  it('removes the document mousemove/mouseup listeners on unmount (no leak)', async () => {
    const { container, unmount } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const handle = container.querySelector<HTMLElement>('.pr-resize-handle')!;
    await fireEvent.mouseDown(handle, { clientX: 100 });

    const removeSpy = vi.spyOn(document, 'removeEventListener');
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));
    removeSpy.mockRestore();
  });
});
// SNIPCODE-HOOK end

// SNIPCODE-HOOK start: PR tab (P4/X2) +/- stats — the merged
// ahead/behind/merge-base/files/total-+- row (replacing the two separate
// banners) and per-file +/- computed client-side from the already-parsed
// diffs, with "bin" for a file that has no countable diff (binary, or a
// hunkless placeholder-eligible entry).
describe('PrView — stats row and per-file +/- (P4/X2)', () => {
  function diffWithLines(file: string, adds: number, dels: number): DiffData {
    const lines: Array<{ type: 'add' | 'delete' | 'context'; content: string }> = [];
    for (let i = 0; i < adds; i++) lines.push({ type: 'add', content: `add${i}` });
    for (let i = 0; i < dels; i++) lines.push({ type: 'delete', content: `del${i}` });
    return {
      file, isBinary: false, isImage: false,
      hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: dels, newStart: 1, newLines: adds, lines }],
    };
  }

  function setup() {
    branchStore.branches = [
      branch({ name: 'feat', current: true, upstream: 'origin/main' }),
      branch({ name: 'origin/main', remote: 'origin' }),
    ];
    return render(PrView);
  }

  it('shows per-file +/- from the parsed diff, "bin" for a binary file, and a matching total in the stats row', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'abcdef1234', ahead: 1, behind: 0,
      files: [{ path: 'src/a.ts', status: 'M' }, { path: 'assets/logo.png', status: 'M' }],
      diffs: [diffWithLines('src/a.ts', 2, 1), { file: 'assets/logo.png', isBinary: true, isImage: true, hunks: [] }],
    });
    await waitFor(() => {
      const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('.pr-file-row'));
      const aRow = rows.find((b) => b.textContent?.includes('src/a.ts'))!;
      expect(aRow.querySelector('.pr-file-stats')?.textContent).toContain('+2');
      expect(aRow.querySelector('.pr-file-stats')?.textContent).toContain('−1');
      const binRow = rows.find((b) => b.textContent?.includes('logo.png'))!;
      expect(binRow.querySelector('.pr-file-stats')?.textContent).toContain('bin');
      const statsRow = container.querySelector('.pr-stats-row')!;
      expect(statsRow.textContent).toContain('+2');
      expect(statsRow.textContent).toContain('−1');
    });
  });

  it('clicking the merge-base hash copies the full hash via copyToClipboard', async () => {
    const { container } = setup();
    deliver('commitsBetween', {
      base: 'origin/main', requestId: currentRequestId(), commits: [], mergeBase: 'abcdef1234', ahead: 1, behind: 0, files: [],
    });
    const btn = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('.pr-merge-base');
      expect(b).toBeTruthy();
      expect(b!.textContent).toContain('abcdef1');
      return b!;
    });
    await fireEvent.click(btn);
    const req = lastMessageOf('copyToClipboard');
    expect(req?.payload).toEqual({ text: 'abcdef1234' });
  });

  it('the stats row disappears (no mergeBase) before any compare has loaded', () => {
    branchStore.branches = [branch({ name: 'some-topic-branch' })];
    const { container } = render(PrView);
    expect(container.querySelector('.pr-stats-row')).toBeNull();
  });
});
// SNIPCODE-HOOK end
