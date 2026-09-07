import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import RecentCommits from '../RecentCommits.svelte';

// Matches lib/types.ts Ref: `remote` is a separate optional field, so the
// fixture can carry the shape git-parser actually produces.
type TestRef = { type: string; name: string; remote?: string };

// A real object name, not a label: the host rejects anything that isn't hex, so
// a fixture hash of 'head' left the UI→host path untested end to end.
const HASH = '0123456789abcdef0123456789abcdef01234567';
const SHORT = '0123456';
const PARENT = 'aaaabbbbccccddddeeeeffff0000111122223333';
const GRANDPARENT = '9999888877776666555544443333222211110000';

/** Three commits so arrow stepping and parent links have somewhere to go. */
function chain() {
  const base = state();
  base.commits = [
    { hash: HASH, abbreviatedHash: SHORT, subject: 'newest', refs: [{ type: 'head', name: 'HEAD' }] as TestRef[], parents: [PARENT] },
    { hash: PARENT, abbreviatedHash: 'aaaabbb', subject: 'middle', refs: [] as TestRef[], parents: [GRANDPARENT] },
    { hash: GRANDPARENT, abbreviatedHash: '9999888', subject: 'oldest', refs: [] as TestRef[], parents: [] },
  ] as never;
  base.graph = {
    paths: [{ points: [{ x: 0, y: 0 }, { x: 0, y: 3 }], color: 0 }],
    links: [],
    dots: [0.5, 1.5, 2.5].map(y => ({ center: { x: 0, y }, color: 0, type: 'commit', isHead: y === 0.5 })),
  } as never;
  return base;
}

/** Labels of the open context menu, in order. */
const menuLabels = (container: Element) =>
  [...container.querySelectorAll('.context-menu .menu-item')].map(item => item.textContent?.trim());

const clickMenuItem = (container: Element, label: string) => {
  const item = [...container.querySelectorAll('.context-menu .menu-item')]
    .find(entry => entry.textContent?.trim() === label);
  if (!item) throw new Error(`no menu item ${label}: ${JSON.stringify(menuLabels(container))}`);
  return fireEvent.click(item);
};

function state() {
  return {
    repoPath: '/repo', repoName: 'repo', repos: [{ path: '/repo', name: 'repo' }],
    commits: [{ hash: HASH, abbreviatedHash: SHORT, subject: 'HEAD subject', refs: [{ type: 'head', name: 'HEAD' }] as TestRef[] }],
    branches: [], ahead: 0, behind: 0, tracking: false, staged: 0, unstaged: 0, conflicts: 0, locale: 'en', scope: 'HEAD',
    graph: {
      paths: [{ points: [{ x: -2, y: 0.5 }, { x: 10, y: 0.5 }], color: 0 }],
      links: [], dots: [{ center: { x: 10, y: 0.5 }, color: 0, type: 'head', isHead: true }],
    },
  };
}

function post(payload: unknown, type = 'recentCommitsState') {
  window.dispatchEvent(new MessageEvent('message', { data: { type, payload } }));
}

const sent = () => globalThis.__postedMessages.map(message => message.data);

beforeEach(() => { globalThis.__postedMessages = []; });
afterEach(() => { vi.useRealTimers(); });

describe('RecentCommits', () => {
  it('does not mistake missing upstream for a clean working tree', async () => {
    const { container } = render(RecentCommits);
    const payload = { ...state(), unstaged: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload } }));
    await tick();
    expect(container.querySelector('.summary')?.textContent).toContain('Unstaged 1');
    expect(container.querySelector('.summary')?.textContent).not.toContain('No changes');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await tick();
    expect(container.querySelector('.summary')?.textContent).toContain('No changes');
  });

  // Geometry is native VS Code's Source Control Graph (row/swimlane 22, dot r5),
  // so this asserts 22-based centres — it used to pin cy=12 for the old 24px row.
  it('aligns the first dot to the 22px row and keeps it inside the rail gutter', async () => {
    const { container } = render(RecentCommits);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await Promise.resolve();

    const dot = container.querySelector<SVGCircleElement>('.dot')!;
    const svg = container.querySelector<SVGSVGElement>('svg')!;
    expect(dot.getAttribute('cy')).toBe('11');
    expect(Number(dot.getAttribute('cx'))).toBeGreaterThanOrEqual(3.5);
    expect(Number(dot.getAttribute('cx'))).toBeLessThanOrEqual(Number(svg.getAttribute('width')) - 3.5);
    expect(container.querySelector('.commit-row')?.textContent).toContain('HEAD subject');
  });

  // The row used to carry a 42px monospace hash — 16% of a 300px sidebar's
  // usable width, and the least identifying thing on the row. Native's rows
  // carry none, and the space belongs to the subject and the ref label.
  it('spends no row width on an abbreviated hash', async () => {
    const { container } = render(RecentCommits);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await Promise.resolve();

    expect(container.querySelector('.commit-hash')).toBeNull();
    expect(container.querySelector('.commit-row')?.textContent).not.toContain(SHORT);
  });

  // Regression: refs were filtered to `remote-branch | tag`, which excluded the
  // `head` ref carrying the current LOCAL branch name — so `develop` could
  // never be labelled. One ref is named, the rest collapse to icon+count.
  it('names the local HEAD branch and collapses the remaining refs into a count', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    // Real parser shape (git-parser.ts:110-119): a remote branch keeps the
    // remote in its OWN field and `name` is the bare branch. This test used to
    // pass 'origin/develop' as `name`, a shape git-parser never produces, which
    // masked the two remotes rendering as two identical "develop" labels.
    payload.commits[0].refs = [
      { type: 'head', name: 'develop' },
      { type: 'remote-branch', name: 'develop', remote: 'origin' },
      { type: 'remote-branch', name: 'develop', remote: 'upstream' },
      { type: 'tag', name: 'v1.2.3' },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload } }));
    await tick();

    const labels = [...container.querySelectorAll('.label')];
    const described = labels.map(label => label.querySelector('.description')?.textContent).filter(Boolean);
    expect(described).toEqual(['develop']);
    // At most two pills: the named one, then ONE counted pill for everything
    // else. Measured at 300px, letting the remainder split per icon left the
    // subject 70px (20px at 250px), so the strip is capped instead.
    expect(labels).toHaveLength(2);
    expect(labels[1].querySelector('.count')?.textContent).toBe('3');
    // Each remote must stay identifiable in the collapsed pill's tooltip.
    expect(labels[1].getAttribute('title')).toBe('origin/develop\nupstream/develop\nv1.2.3');
  });


  /* SNIPCODE-HOOK start: sidebar commit details — the row was deliberately inert
     ("Not activatable") and shipped neither the message body nor the file list,
     which is exactly what native's Source Control Graph gives on a click. */
  it('selects the clicked commit and asks the host for its files', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();

    await fireEvent.click(container.querySelector('.commit-row')!);
    await tick();

    expect(sent()).toContainEqual({ type: 'recentCommitsSelectCommit', payload: { hash: HASH, repoPath: '/repo' } });
    expect(container.querySelector('.commit-row')?.classList.contains('selected')).toBe(true);
    // Panel is up immediately with the message; only the file list is pending.
    expect(container.querySelector('.commit-message')?.textContent).toBe('HEAD subject');
    expect(container.querySelector('.files-note')?.textContent).toContain('Loading changes');
  });

  it('shows the commit body and every changed file, and opens the one clicked', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    payload.commits[0] = { ...payload.commits[0], body: 'why this change', author: { name: 'Ada', date: '2026-09-07T10:00:00Z' } } as never;
    post(payload);
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    post({ hash: HASH, files: [{ path: 'src/a.ts', status: 'M' }, { path: 'b.ts', status: 'R', oldPath: 'old.ts' }] }, 'recentCommitsCommitFiles');
    await tick();

    expect(container.querySelector('.commit-message')?.textContent).toBe('HEAD subject\n\nwhy this change');
    expect(container.querySelector('.commit-meta')?.textContent?.trim()).toContain('Ada');
    const rows = [...container.querySelectorAll('.file-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.file-name')?.textContent).toBe('a.ts');
    expect(rows[0].querySelector('.file-dir')?.textContent).toBe('src');
    expect(rows[1].getAttribute('title')).toContain('old.ts → b.ts');

    await fireEvent.click(rows[1]);
    expect(sent()).toContainEqual({
      type: 'recentCommitsOpenFile',
      payload: { hash: HASH, path: 'b.ts', oldPath: 'old.ts', repoPath: '/repo' },
    });

    await fireEvent.click(container.querySelector('.details-head .icon-btn')!);
    expect(sent()).toContainEqual({
      type: 'recentCommitsOpenChanges',
      payload: { hash: HASH, subject: 'HEAD subject', repoPath: '/repo' },
    });
  });

  // The host repaints the whole state every 180ms-debounced tree change; an
  // index-keyed selection would drift onto another commit, and re-requesting
  // files on every repaint would flash the panel back to "loading".
  it('keeps the selection and its file list across a refresh, and drops it when the commit is gone', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    post({ hash: HASH, files: [{ path: 'src/a.ts', status: 'M' }] }, 'recentCommitsCommitFiles');
    await tick();

    globalThis.__postedMessages = [];
    post(state());
    await tick();
    expect(container.querySelectorAll('.file-row')).toHaveLength(1);
    expect(sent()).toHaveLength(0);

    const other = state();
    other.commits[0].hash = 'fedcba9876543210fedcba9876543210fedcba98';
    post(other);
    await tick();
    expect(container.querySelector('.details')).toBeNull();
  });

  // The host drops a file-list reply issued while the view was hidden; without
  // this the panel sits on "Loading changes…" for as long as the row stays
  // selected, because nothing else re-asks.
  it('re-asks for the file list when a reply never arrived', async () => {
    vi.useFakeTimers();
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    await tick();

    globalThis.__postedMessages = [];
    vi.setSystemTime(Date.now() + 1500);
    post(state());
    await tick();
    expect(sent()).toContainEqual({ type: 'recentCommitsSelectCommit', payload: { hash: HASH, repoPath: '/repo' } });
  });

  // …but state arrives on every 180ms-debounced tree change, so re-asking on
  // each one would re-issue a slow merge query faster than it can finish.
  it('does not re-ask while the first request could still be in flight', async () => {
    vi.useFakeTimers();
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    await tick();

    globalThis.__postedMessages = [];
    vi.setSystemTime(Date.now() + 200);
    post(state());
    post(state());
    await tick();
    expect(sent()).toHaveLength(0);
  });

  it('activates a row from the keyboard', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();

    const row = container.querySelector('.commit-row')!;
    await fireEvent.keyDown(row, { key: 'Enter' });
    await tick();
    expect(container.querySelector('.details')).not.toBeNull();

    await fireEvent.keyDown(row, { key: ' ' });
    await tick();
    // Space on the selected row collapses it again, same as a second click.
    expect(container.querySelector('.details')).toBeNull();
  });

  it('sends the subject with Open All Changes so the editor tab is nameable', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    post({ hash: HASH, files: [{ path: 'a.ts', status: 'M' }] }, 'recentCommitsCommitFiles');
    await tick();

    await fireEvent.click(container.querySelector('.details-head .icon-btn')!);
    expect(sent()).toContainEqual({
      type: 'recentCommitsOpenChanges',
      payload: { hash: HASH, subject: 'HEAD subject', repoPath: '/repo' },
    });
  });

  it('carries the full message, author and hash in the row tooltip', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    payload.commits[0] = { ...payload.commits[0], body: 'why this change', author: { name: 'Ada', date: '2026-09-07T10:00:00Z' } } as never;
    post(payload);
    await tick();

    const title = container.querySelector('.commit-row')?.getAttribute('title') ?? '';
    expect(title).toContain('HEAD subject');
    expect(title).toContain('why this change');
    expect(title).toContain('Ada');
    expect(title).toContain(SHORT);
  });

  // Copying a hash into a terminal / ticket is the highest-frequency read-only
  // action after looking at a commit, and the sidebar had no menu at all.
  it('offers the copy actions on right-click and posts the copied text', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    payload.commits[0] = { ...payload.commits[0], body: 'why this change' } as never;
    post(payload);
    await tick();

    await fireEvent.contextMenu(container.querySelector('.commit-row')!);
    await tick();
    expect(menuLabels(container)).toEqual([
      'Open All Changes', 'Copy Commit SHA', 'Copy Short SHA',
      'Copy Commit Info', 'Copy Commit Message', 'Copy Full Source',
    ]);

    await clickMenuItem(container, 'Copy Commit Message');
    // Full message, not just the subject.
    expect(sent()).toContainEqual({
      type: 'recentCommitsCopy',
      payload: { text: 'HEAD subject\n\nwhy this change', repoPath: '/repo' },
    });
    expect(container.querySelector('.context-menu')).toBeNull();
  });

  it('transfers Copy Full Source to the host with only the hash', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();

    await fireEvent.contextMenu(container.querySelector('.commit-row')!);
    await tick();
    await clickMenuItem(container, 'Copy Full Source');

    expect(sent()).toContainEqual({
      type: 'recentCommitsCopyFullSource',
      payload: { hash: HASH, repoPath: '/repo' },
    });
  });

  it('steps the selection with the arrow keys and follows the first parent on Ctrl', async () => {
    const { container } = render(RecentCommits);
    post(chain());
    await tick();

    const list = container.querySelector('.commit-list')!;
    await fireEvent.keyDown(list, { key: 'ArrowDown' });
    await tick();
    // Nothing was selected, so the first step lands on the top row.
    expect(container.querySelector('.commit-row.selected')?.textContent).toContain('newest');

    await fireEvent.keyDown(list, { key: 'ArrowDown' });
    await tick();
    expect(container.querySelector('.commit-row.selected')?.textContent).toContain('middle');

    await fireEvent.keyDown(list, { key: 'ArrowUp' });
    await tick();
    expect(container.querySelector('.commit-row.selected')?.textContent).toContain('newest');

    await fireEvent.keyDown(list, { key: 'ArrowDown', ctrlKey: true });
    await tick();
    expect(container.querySelector('.commit-row.selected')?.textContent).toContain('middle');
  });

  // Roving tabindex: Tab reaches the list once, not once per row (30 rows of
  // tabindex="0" was the a11y problem, not just a missing feature).
  it('keeps exactly one row in the tab order', async () => {
    const { container } = render(RecentCommits);
    post(chain());
    await tick();

    const tabbable = () => [...container.querySelectorAll('.commit-row')]
      .filter(row => row.getAttribute('tabindex') === '0');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0].textContent).toContain('newest');

    await fireEvent.click(container.querySelectorAll('.commit-row')[1]);
    await tick();
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0].textContent).toContain('middle');
  });

  it('links to a loaded parent and disables one that is not loaded', async () => {
    const { container } = render(RecentCommits);
    post(chain());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    await tick();

    const link = container.querySelector<HTMLButtonElement>('.parent-link')!;
    expect(link.textContent).toBe('aaaabbb');
    expect(link.disabled).toBe(false);
    await fireEvent.click(link);
    await tick();
    expect(container.querySelector('.commit-row.selected')?.textContent).toContain('middle');

    // The oldest commit's parent is off the loaded page.
    await fireEvent.click(container.querySelectorAll('.commit-row')[2]);
    await tick();
    expect(container.querySelector('.parent-link')).toBeNull();
  });

  it('names the committer only when it differs from the author, and dates it relatively', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    const author = { name: 'Ada', email: 'ada@example.com', date: new Date(Date.now() - 3 * 86400000).toISOString() };
    payload.commits[0] = { ...payload.commits[0], author, committer: author } as never;
    post(payload);
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    await tick();

    const metas = () => [...container.querySelectorAll('.commit-meta')].map(m => m.textContent?.trim());
    expect(metas()).toHaveLength(1);
    expect(metas()[0]).toBe('Ada · 3 days ago');

    payload.commits[0] = { ...payload.commits[0], committer: { name: 'Grace', email: 'grace@example.com', date: author.date } } as never;
    post(payload);
    await tick();
    expect(metas()[1]).toBe('Committer · Grace');
  });

  // stopPropagation: the row itself opens the diff, so without it one click on
  // the inline action would fire both.
  it('opens the working file from the inline action without also opening the diff', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    post({ hash: HASH, files: [{ path: 'src/a.ts', status: 'M' }] }, 'recentCommitsCommitFiles');
    await tick();

    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector('.file-row .inline-action')!);
    expect(sent()).toEqual([{
      type: 'recentCommitsOpenWorkingFile',
      payload: { path: 'src/a.ts', repoPath: '/repo' },
    }]);
  });

  it('offers per-file actions on right-click', async () => {
    const { container } = render(RecentCommits);
    post(state());
    await tick();
    await fireEvent.click(container.querySelector('.commit-row')!);
    post({ hash: HASH, files: [{ path: 'src/a.ts', status: 'M' }] }, 'recentCommitsCommitFiles');
    await tick();

    await fireEvent.contextMenu(container.querySelector('.file-row')!);
    await tick();
    expect(menuLabels(container)).toEqual(['Open Changes', 'Open File', 'Copy Path', 'Copy Full Source']);

    await clickMenuItem(container, 'Copy Path');
    expect(sent()).toContainEqual({ type: 'recentCommitsCopy', payload: { text: 'src/a.ts', repoPath: '/repo' } });
  });
  /* SNIPCODE-HOOK end */
});
