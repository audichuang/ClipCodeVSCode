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

  // SNIPCODE-HOOK: PR tab inline diff (Task D2) — jumpChange compares each
  // hunk's live getBoundingClientRect() against the container's viewport
  // center line, not offsetTop vs scrollTop (offsetTop is relative to the
  // offsetParent, not comparable to scrollTop, and once
  // scrollIntoView({block:'center'}) has run once, an offsetTop/scrollTop
  // compare re-selects the same hunk forever — see PrView.svelte's
  // jumpChange comment). `.pr-content` itself doesn't move when scrolled
  // (only its children do), so its own getBoundingClientRect().top/
  // clientHeight are fixed for the whole test; each hunk's rect.top is
  // modeled as `documentY - virtualScrollTop`, and virtualScrollTop is
  // advanced after each click the same way a real
  // scrollIntoView({block:'center'}) would (since scrollIntoView itself is
  // stubbed to a no-op here) — landing the clicked hunk's rect.top on the
  // center line for the next assertion.
  it('prev/next-change buttons scroll to the next/previous diff hunk within .pr-content, advancing past each one', async () => {
    const { container } = setupWithDiffs();
    await waitFor(() => expect(container.textContent).toContain('hello-from-a'));
    const prContent = container.querySelector<HTMLElement>('.pr-content')!;
    const hunks = Array.from(container.querySelectorAll<HTMLElement>('.diff-hunk'));
    expect(hunks.length).toBe(2);

    const clientHeight = 200;
    const center = clientHeight / 2; // 100
    const hunkDocY = [500, 700]; // fixed document positions, arbitrary
    let virtualScrollTop = 0;

    vi.spyOn(prContent, 'getBoundingClientRect').mockImplementation(() => ({ top: 0 }) as DOMRect);
    Object.defineProperty(prContent, 'clientHeight', { value: clientHeight, configurable: true });
    hunks.forEach((el, i) => {
      vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
        () => ({ top: hunkDocY[i] - virtualScrollTop }) as DOMRect,
      );
    });
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});

    const nextBtn = container.querySelector<HTMLButtonElement>('.pr-jump-next')!;
    const prevBtn = container.querySelector<HTMLButtonElement>('.pr-jump-prev')!;

    // Nothing scrolled yet: both hunks are below the center line, "next"
    // finds the first one.
    await fireEvent.click(nextBtn);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.instances[0]).toBe(hunks[0]);
    virtualScrollTop = hunkDocY[0] - center; // simulate the centering scrollIntoView caused

    // The bug this replaces: an offsetTop/scrollTop compare would re-select
    // hunks[0] here forever. The fixed rect-vs-center-line compare correctly
    // skips it (its rect.top now sits at the center line) and advances.
    await fireEvent.click(nextBtn);
    expect(scrollSpy).toHaveBeenCalledTimes(2);
    expect(scrollSpy.mock.instances[1]).toBe(hunks[1]);
    virtualScrollTop = hunkDocY[1] - center; // simulate centering hunks[1]

    // "prev" from hunks[1] centered: skips hunks[1] itself, steps back to hunks[0].
    await fireEvent.click(prevBtn);
    expect(scrollSpy).toHaveBeenCalledTimes(3);
    expect(scrollSpy.mock.instances[2]).toBe(hunks[0]);

    scrollSpy.mockRestore();
  });
});
// SNIPCODE-HOOK end
