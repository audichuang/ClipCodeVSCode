import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import SearchBar from '../SearchBar.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';
import { commitStore } from '../../../lib/stores/commits.svelte';
import type { Commit, BranchInfo } from '../../../lib/types';

function commit(over: Partial<Commit>): Commit {
  return {
    hash: 'h',
    abbreviatedHash: 'h',
    author: { name: 'A', email: 'a@x.com', date: '' },
    committer: { name: 'A', email: 'a@x.com', date: '' },
    subject: 'subject',
    body: '',
    parents: [],
    refs: [],
    ...over,
  };
}

function setCommits(commits: Commit[]) {
  commitStore.commits = commits;
}

const baseProps = {
  onResults: vi.fn(),
  onNavigate: vi.fn(),
};

beforeEach(() => {
  i18n.setLocale('en');
  setCommits([]);
  commitStore.hasMore = false;
  commitStore.loadingMore = false;
  vi.useFakeTimers();
});

describe('SearchBar — basic search', () => {
  it('typing then waiting 150ms triggers a search (debounce)', async () => {
    setCommits([
      commit({ hash: 'h1', subject: 'fix login bug' }),
      commit({ hash: 'h2', subject: 'add feature' }),
    ]);
    const onResults = vi.fn();
    const onNavigate = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults, onNavigate });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'login' } });
    vi.advanceTimersByTime(150);
    expect(onResults).toHaveBeenCalled();
    const matched = onResults.mock.calls.at(-1)![0] as Set<string>;
    expect(matched.has('h1')).toBe(true);
    expect(matched.has('h2')).toBe(false);
    expect(onNavigate).toHaveBeenCalledWith('h1');
  });

  it('clearing the input passes null to onResults', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'fix' } });
    vi.advanceTimersByTime(150);
    onResults.mockClear();
    await fireEvent.input(input, { target: { value: '' } });
    expect(onResults).toHaveBeenLastCalledWith(null);
  });

  it('no-match search passes an empty Set, not null', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'no match here' } });
    vi.advanceTimersByTime(150);
    const matched = onResults.mock.calls.at(-1)![0] as Set<string>;
    expect(matched).toBeInstanceOf(Set);
    expect(matched.size).toBe(0);
  });

  it('recomputes matches when commits refresh without navigating again', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix login' })]);
    const onResults = vi.fn();
    const onNavigate = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults, onNavigate });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;

    await fireEvent.input(input, { target: { value: 'login' } });
    vi.advanceTimersByTime(150);
    expect(onNavigate).toHaveBeenCalledWith('h1');

    onResults.mockClear();
    onNavigate.mockClear();
    setCommits([commit({ hash: 'h2', subject: 'fix login again' })]);
    await tick();

    const matched = onResults.mock.calls.at(-1)![0] as Set<string>;
    expect(matched.has('h2')).toBe(true);
    expect(matched.has('h1')).toBe(false);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('matches on author name, email, hash, and refs', async () => {
    setCommits([
      commit({ hash: 'aaa111', author: { name: 'Carol', email: 'c@x.com', date: '' }, subject: 's' }),
      commit({ hash: 'bbb222', subject: 's', refs: [{ type: 'branch', name: 'feature/login' }] }),
      commit({ hash: 'ccc333', subject: 's', refs: [{ type: 'remote-branch', name: 'main', remote: 'origin' }] }),
    ]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;

    await fireEvent.input(input, { target: { value: 'Carol' } });
    vi.advanceTimersByTime(150);
    expect((onResults.mock.calls.at(-1)![0] as Set<string>).has('aaa111')).toBe(true);

    await fireEvent.input(input, { target: { value: 'feature/login' } });
    vi.advanceTimersByTime(150);
    expect((onResults.mock.calls.at(-1)![0] as Set<string>).has('bbb222')).toBe(true);

    await fireEvent.input(input, { target: { value: 'origin/main' } });
    vi.advanceTimersByTime(150);
    expect((onResults.mock.calls.at(-1)![0] as Set<string>).has('ccc333')).toBe(true);
  });
});

describe('SearchBar — keyboard navigation', () => {
  it('Enter goes to next match when there are existing results', async () => {
    setCommits([
      commit({ hash: 'h1', subject: 'match a' }),
      commit({ hash: 'h2', subject: 'match b' }),
    ]);
    const onNavigate = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onNavigate });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'match' } });
    vi.advanceTimersByTime(150);
    onNavigate.mockClear();
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('h2');
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Enter' });
    expect(onNavigate).toHaveBeenLastCalledWith('h1'); // wraps
  });

  it('Shift+Enter navigates backwards (wraps to last)', async () => {
    setCommits([
      commit({ hash: 'h1', subject: 'match a' }),
      commit({ hash: 'h2', subject: 'match b' }),
    ]);
    const onNavigate = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onNavigate });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'match' } });
    vi.advanceTimersByTime(150);
    onNavigate.mockClear();
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Enter', shiftKey: true });
    expect(onNavigate).toHaveBeenCalledWith('h2');
  });

  it('Escape with no open dropdown clears the query', async () => {
    setCommits([commit({ hash: 'h1', subject: 'x' })]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'x' } });
    vi.advanceTimersByTime(150);
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Escape' });
    expect(input.value).toBe('');
  });

  it('prev/next buttons are disabled when no matches', async () => {
    setCommits([commit({ hash: 'h1', subject: 'foo' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'zzz' } });
    vi.advanceTimersByTime(150);
    const navBtns = container.querySelectorAll<HTMLButtonElement>('.nav-btn');
    // up, down, close (3)
    expect(navBtns[0].disabled).toBe(true);
    expect(navBtns[1].disabled).toBe(true);
  });

  it('clicking the X button clears the search', async () => {
    setCommits([commit({ hash: 'h1', subject: 'foo' })]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'foo' } });
    vi.advanceTimersByTime(150);
    onResults.mockClear();
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.close-btn')!);
    expect(onResults).toHaveBeenCalledWith(null);
    expect(input.value).toBe('');
  });
});

describe('SearchBar — filter UI', () => {
  it('source filter button toggles dropdown open/closed', async () => {
    const { container } = render(SearchBar, { ...baseProps, remotes: ['origin'] });
    expect(container.querySelector('.dropdown')).toBeNull();
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    expect(container.querySelector('.dropdown')).not.toBeNull();
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    expect(container.querySelector('.dropdown')).toBeNull();
  });

  it('clicking a remote in the source filter calls onFilterChange', async () => {
    const onFilterChange = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, remotes: ['origin', 'upstream'], onFilterChange });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    const items = container.querySelectorAll<HTMLButtonElement>('.dd-item');
    // items: [All, Local, origin, upstream]
    await fireEvent.click(items[2]);
    expect(onFilterChange).toHaveBeenCalledWith(['origin']);
  });

  it('"All" item clears the source filter', async () => {
    const onFilterChange = vi.fn();
    const { container } = render(SearchBar, {
      ...baseProps,
      remotes: ['origin'],
      remoteFilter: ['origin'],
      onFilterChange,
    });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    const items = container.querySelectorAll<HTMLButtonElement>('.dd-item');
    await fireEvent.click(items[0]);
    expect(onFilterChange).toHaveBeenCalledWith([]);
  });

  it('Enter with empty query clears (no search posted)', async () => {
    setCommits([commit({ hash: 'h1', subject: 'foo' })]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    onResults.mockClear();
    // Press Enter without typing anything — Enter with no matches and no query
    // falls through to doSearch(), which sees empty query and calls clear().
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Enter' });
    expect(onResults).toHaveBeenLastCalledWith(null);
  });

  it('Escape closes the open branch-filter dropdown without clearing the query', async () => {
    setCommits([commit({ hash: 'h1', subject: 'foo' })]);
    const branches = [{ name: 'main', current: true, ahead: 0, behind: 0, hash: 'h' }];
    const { container } = render(SearchBar, { ...baseProps, branches });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'foo' } });
    vi.advanceTimersByTime(150);
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    expect(container.querySelector('.dropdown')).not.toBeNull();
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Escape' });
    expect(container.querySelector('.dropdown')).toBeNull();
    expect(input.value).toBe('foo');
  });

  it('source filter backdrop click closes the dropdown', async () => {
    const { container } = render(SearchBar, { ...baseProps, remotes: ['origin'] });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    expect(container.querySelector('.dropdown')).not.toBeNull();
    await fireEvent.click(container.querySelector<HTMLDivElement>('.backdrop')!);
    expect(container.querySelector('.dropdown')).toBeNull();
  });

  it('branch filter backdrop click closes the dropdown', async () => {
    const { container } = render(SearchBar, {
      ...baseProps,
      branches: [{ name: 'main', current: true, ahead: 0, behind: 0, hash: 'h' }],
    });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    expect(container.querySelector('.dropdown')).not.toBeNull();
    await fireEvent.click(container.querySelector<HTMLDivElement>('.backdrop')!);
    expect(container.querySelector('.dropdown')).toBeNull();
  });

  it('Escape closes the open source-filter dropdown without clearing the query', async () => {
    setCommits([commit({ hash: 'h1', subject: 'foo' })]);
    const { container } = render(SearchBar, { ...baseProps, remotes: ['origin'] });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'foo' } });
    vi.advanceTimersByTime(150);
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[0]);
    expect(container.querySelector('.dropdown')).not.toBeNull();
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Escape' });
    expect(container.querySelector('.dropdown')).toBeNull();
    expect(input.value).toBe('foo');
  });
});

describe('SearchBar — HEAD keyword', () => {
  it('typing HEAD matches the commit carrying a head ref', async () => {
    setCommits([
      commit({ hash: 'h1', subject: 'one' }),
      commit({ hash: 'h2', subject: 'two', refs: [{ type: 'head', name: 'HEAD' }] }),
    ]);
    const onResults = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onResults });
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'HEAD' } });
    vi.advanceTimersByTime(150);
    const matched = onResults.mock.calls.at(-1)![0] as Set<string>;
    expect(matched.has('h2')).toBe(true);
    expect(matched.has('h1')).toBe(false);
  });
});

describe('SearchBar — branch filter', () => {
  const branches: BranchInfo[] = [
    { name: 'main', current: true, ahead: 0, behind: 0, hash: 'h' },
    { name: 'feature/login', current: false, ahead: 0, behind: 0, hash: 'h' },
    { name: 'origin/main', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
    { name: 'origin/HEAD', current: false, remote: 'origin', ahead: 0, behind: 0, hash: 'h' },
  ];

  it('lists local and remote branches grouped, skipping origin/HEAD', async () => {
    const { container } = render(SearchBar, { ...baseProps, branches, remotes: ['origin'] });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    const items = Array.from(container.querySelectorAll('.dd-item')).map(el => el.textContent?.trim());
    expect(items.some(t => t?.includes('main'))).toBe(true);
    expect(items.some(t => t?.includes('feature/login'))).toBe(true);
    expect(items.some(t => t === 'origin/HEAD')).toBe(false);
  });

  it('clicking a branch fires onBranchFilterChange', async () => {
    const onBranchFilterChange = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, branches, onBranchFilterChange });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    const items = container.querySelectorAll<HTMLButtonElement>('.dd-item');
    const featureItem = Array.from(items).find(i => i.textContent?.includes('feature/login'))!;
    await fireEvent.click(featureItem);
    expect(onBranchFilterChange).toHaveBeenCalledWith(['feature/login']);
  });

  it('typing in the branch search input narrows the list', async () => {
    const { container } = render(SearchBar, { ...baseProps, branches });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    const search = container.querySelector<HTMLInputElement>('.branch-search-input')!;
    await fireEvent.input(search, { target: { value: 'feat' } });
    const items = Array.from(container.querySelectorAll('.dd-item')).map(el => el.textContent?.trim());
    expect(items.some(t => t?.includes('feature/login'))).toBe(true);
    expect(items.some(t => t === 'main')).toBe(false);
  });

  it('"All branches" item clears the branch filter', async () => {
    const onBranchFilterChange = vi.fn();
    const { container } = render(SearchBar, {
      ...baseProps,
      branches,
      branchFilter: ['main'],
      onBranchFilterChange,
    });
    await fireEvent.click(container.querySelectorAll<HTMLButtonElement>('.filter-btn')[1]);
    const items = container.querySelectorAll<HTMLButtonElement>('.dd-item');
    await fireEvent.click(items[0]);
    expect(onBranchFilterChange).toHaveBeenCalledWith([]);
  });
});

describe('SearchBar — jump to HEAD button', () => {
  it('is disabled when no commit is HEAD', () => {
    setCommits([commit({ hash: 'h1' })]);
    const { container } = render(SearchBar, { ...baseProps });
    const btn = container.querySelector<HTMLButtonElement>('.head-btn')!;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
  });

  it('is enabled and calls onJumpToHead when clicked', async () => {
    setCommits([commit({ hash: 'h1', refs: [{ type: 'head', name: 'HEAD' }] })]);
    const onJumpToHead = vi.fn();
    const { container } = render(SearchBar, { ...baseProps, onJumpToHead });
    const btn = container.querySelector<HTMLButtonElement>('.head-btn')!;
    expect(btn.disabled).toBe(false);
    await fireEvent.click(btn);
    expect(onJumpToHead).toHaveBeenCalled();
  });

  it('has the active class when headOffscreen is true', () => {
    setCommits([commit({ hash: 'h1', refs: [{ type: 'head', name: 'HEAD' }] })]);
    const { container } = render(SearchBar, { ...baseProps, headOffscreen: true });
    const btn = container.querySelector<HTMLButtonElement>('.head-btn')!;
    expect(btn.classList.contains('active')).toBe(true);
  });
});

/* SNIPCODE-HOOK start: M9 — hash-shaped no-result fallback, "No results in {n}
   loaded commits" + Load more, and Esc handing focus back to the graph. */
describe('SearchBar — M9 no-results copy and hash fallback', () => {
  it('no-match search shows "No results in {n} loaded commits"', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'nope' } });
    vi.advanceTimersByTime(150);
    expect(container.querySelector('.search-count')?.textContent).toContain('1');
    expect(container.querySelector('.search-count')?.textContent?.toLowerCase()).toContain('loaded');
  });

  it('a non-hex, non-loaded query does not post searchByHash', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'totally not hex' } });
    vi.advanceTimersByTime(150);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'searchByHash'
    )).toBe(false);
  });

  it('a hash-shaped query with no local match posts searchByHash', async () => {
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'abc1234' } }); // 7 hex chars, not loaded
    vi.advanceTimersByTime(150);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'searchByHash'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { hash: string } }).payload.hash).toBe('abc1234');
  });

  it('searchByHash finding a commit shows "Found — not in the loaded range" instead of a fake 1/1', async () => {
    setCommits([]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'abc1234deadbeef' } });
    vi.advanceTimersByTime(150);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'searchResults', payload: { commits: [{ hash: 'abc1234deadbeef00000' }], graph: [] } },
    }));
    await tick();
    expect(container.querySelector('.search-count')?.textContent?.toLowerCase()).toContain('not in the loaded range');
    // Still no fake match — prev/next stay disabled, nothing navigable.
    const navBtns = container.querySelectorAll<HTMLButtonElement>('.nav-btn');
    expect(navBtns[0].disabled).toBe(true);
  });

  it('searchByHash finding nothing keeps the plain "No results" copy', async () => {
    setCommits([]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'abc1234deadbeef' } });
    vi.advanceTimersByTime(150);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'searchResults', payload: { commits: [], graph: [] } },
    }));
    await tick();
    expect(container.querySelector('.search-count')?.textContent?.toLowerCase()).toContain('loaded');
    expect(container.querySelector('.search-count')?.textContent?.toLowerCase()).not.toContain('not in the loaded range');
  });

  it('a stale searchResults reply is ignored once the box no longer shows the hash it was requested for', async () => {
    setCommits([]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'abc1234' } });
    vi.advanceTimersByTime(150);
    // Query changes to something non-hash-shaped (no new lookup fires, so
    // lastHashLookupQuery still remembers 'abc1234') before the reply lands —
    // e.g. CommitDetails' own searchByHash for an unrelated parent-hash click
    // could also produce a searchResults reply while the user keeps typing.
    await fireEvent.input(input, { target: { value: 'not hex at all' } });
    vi.advanceTimersByTime(150);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'searchResults', payload: { commits: [{ hash: 'abc1234000000' }], graph: [] } },
    }));
    await tick();
    expect(container.querySelector('.search-count')?.textContent?.toLowerCase()).not.toContain('not in the loaded range');
  });

  it('Load more appears when there are no results and hasMore, and posts getLog with the extended limit', async () => {
    commitStore.hasMore = true;
    commitStore.currentLimit = 200;
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'nope' } });
    vi.advanceTimersByTime(150);
    const loadMoreBtn = container.querySelector<HTMLButtonElement>('.load-more-btn');
    expect(loadMoreBtn).not.toBeNull();
    await fireEvent.click(loadMoreBtn!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'getLog'
    );
    expect(req).toBeDefined();
    expect((req!.data as { payload: { limit: number } }).payload.limit).toBeGreaterThan(200);
    commitStore.hasMore = false;
  });

  it('Load more is absent when hasMore is false', async () => {
    commitStore.hasMore = false;
    setCommits([commit({ hash: 'h1', subject: 'fix' })]);
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'nope' } });
    vi.advanceTimersByTime(150);
    expect(container.querySelector('.load-more-btn')).toBeNull();
  });

  it('Escape hands focus back to the graph container', async () => {
    setCommits([commit({ hash: 'h1', subject: 'x' })]);
    document.body.innerHTML = '<div class="commit-graph" tabindex="0"></div>';
    const graphEl = document.querySelector<HTMLElement>('.commit-graph')!;
    const focusSpy = vi.spyOn(graphEl, 'focus');
    const { container } = render(SearchBar, baseProps);
    const input = container.querySelector<HTMLInputElement>('.search-input')!;
    await fireEvent.input(input, { target: { value: 'x' } });
    vi.advanceTimersByTime(150);
    await fireEvent.keyDown(container.querySelector('.search-bar')!, { key: 'Escape' });
    expect(focusSpy).toHaveBeenCalled();
  });
});
/* SNIPCODE-HOOK end */
