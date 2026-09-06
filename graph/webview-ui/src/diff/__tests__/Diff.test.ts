import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { tick } from 'svelte';
import Diff from '../Diff.svelte';
import { diffStore } from '../diff-store.svelte';
import { i18n } from '../../lib/i18n/index.svelte';
import * as vscodeApiModule from '../../lib/vscode-api';
import type { DiffData } from '../../lib/types';

// A small complete hunk so FileDiffView renders a stageable block arrow.
function textDiff(file = 'src/a.ts'): DiffData {
  return { file, isBinary: false, isImage: false, fingerprint: 'rendered-fp',
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ type: 'add', content: 'x', newLineNumber: 1 }] }] };
}
function binaryDiff(file = 'img.png'): DiffData {
  return { file, isBinary: true, isImage: false, hunks: [] };
}
/* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
function twoHunkDiff(file = 'src/a.ts'): DiffData {
  return {
    file, isBinary: false, isImage: false, fingerprint: 'rendered-fp',
    hunks: [
      { header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ type: 'add', content: 'x', newLineNumber: 1 }] },
      { header: '@@ -10 +10 @@', oldStart: 10, oldLines: 1, newStart: 10, newLines: 1,
        lines: [{ type: 'add', content: 'y', newLineNumber: 10 }] },
    ],
  };
}
/* SNIPCODE-HOOK end */

beforeEach(() => {
  diffStore.reset();
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
});

// The store is a singleton and getByText scans document.body, so unmount each
// render to avoid DOM from a prior test leaking into the next query.
afterEach(() => cleanup());

describe('Diff.svelte unified view', () => {
  it('shows the open-changes hint when no file is loaded', () => {
    const { getByText } = render(Diff);
    expect(getByText('Open Changes')).toBeTruthy();
  });

  /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
  it('shows a loading state instead of the previous diff during navigation', () => {
    diffStore.beginLoad('/r', 'src/b.ts', 2);
    const { getByText, queryByText } = render(Diff);
    expect(getByText('Loading changes')).toBeTruthy();
    expect(queryByText('No changes')).toBeNull();
  });
  /* SNIPCODE-HOOK end */

  it('renders two sections when both sides have a diff', () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    const { container, getByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(2);
    expect(getByText('Staged')).toBeTruthy();
    expect(getByText('Unstaged')).toBeTruthy();
  });

  it('renders only the Unstaged section when nothing is staged', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, textDiff());
    const { container, getByText, queryByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(1);
    expect(getByText('Unstaged')).toBeTruthy();
    expect(queryByText('Staged')).toBeNull();
  });

  it('still renders a section for a binary-only side (diff !== null, empty hunks)', () => {
    diffStore.setDiffs('/r', 'img.png', binaryDiff(), null);
    const { container, getByText, queryByText } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(1);
    expect(getByText('Staged')).toBeTruthy();
    expect(queryByText('No changes')).toBeNull();
  });

  it('shows "No changes" when a file is loaded but both sides are null', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, null);
    const { getByText } = render(Diff);
    expect(getByText('No changes')).toBeTruthy();
  });

  it('a fetch error shows the error banner, never the "No changes" empty state', () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, null);
    diffStore.error = 'index.lock exists';
    const { getByText, queryByText } = render(Diff);
    expect(getByText('index.lock exists')).toBeTruthy();
    expect(queryByText('No changes')).toBeNull();
  });

  it('collapsing a section hides its FileDiffView content and a second click re-expands it', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', null, textDiff());
    const { container } = render(Diff);
    expect(container.querySelector('.diff-section .diff-wrapper')).toBeTruthy();
    await fireEvent.click(container.querySelector('.section-toggle')!);
    expect(container.querySelector('.diff-section .diff-wrapper')).toBeNull();
    await fireEvent.click(container.querySelector('.section-toggle')!);
    expect(container.querySelector('.diff-section .diff-wrapper')).toBeTruthy();
  });

  it('the header open-diff button posts diffOpenSide for its section without collapsing it', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    const { container } = render(Diff);
    const unstagedOpen = container.querySelectorAll('.diff-section')[1].querySelector('.section-open-btn');
    await fireEvent.click(unstagedOpen!);
    const posted = globalThis.__postedMessages.map((m: any) => m.data);
    expect(posted).toContainEqual({
      type: 'diffOpenSide',
      payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged' },
    });
    // Still expanded: the open action must not double as a collapse toggle.
    expect(container.querySelectorAll('.diff-section')[1].querySelector('.diff-wrapper')).toBeTruthy();
  });

  it('staging a block in the staged section posts side:staged', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    /* SNIPCODE-HOOK start: D5 default is now inline — opt into SBS explicitly */
    // .sbs-block-stage-btn only exists in side-by-side mode; D5 made inline
    // the default, so this test (about block-level staging, not about which
    // mode is default) must switch modes itself rather than rely on it.
    const { container, getByText } = render(Diff);
    await fireEvent.click(getByText('Side by Side'));
    /* SNIPCODE-HOOK end */
    // Sections render in order [Staged, Unstaged]; the first section is Staged.
    const stagedSection = container.querySelectorAll('.diff-section')[0];
    const arrow = stagedSection.querySelector('.sbs-block-stage-btn');
    expect(arrow).toBeTruthy();
    await fireEvent.click(arrow!);
    const posted = globalThis.__postedMessages.map((m: any) => m.data);
    const stageMsg = posted.find((d: any) => d.type === 'diffStageLines');
    expect(stageMsg).toBeTruthy();
    expect(stageMsg.payload).toMatchObject({ repoPath: '/r', file: 'src/a.ts', side: 'staged', hunkIndex: 0, lineIndices: [0] });
  });

  it('staging a block in the unstaged section posts side:unstaged', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff());
    /* SNIPCODE-HOOK start: D5 default is now inline — opt into SBS explicitly */
    const { container, getByText } = render(Diff);
    await fireEvent.click(getByText('Side by Side'));
    /* SNIPCODE-HOOK end */
    // Second section is Unstaged.
    const unstagedSection = container.querySelectorAll('.diff-section')[1];
    const arrow = unstagedSection.querySelector('.sbs-block-stage-btn');
    expect(arrow).toBeTruthy();
    await fireEvent.click(arrow!);
    const posted = globalThis.__postedMessages.map((m: any) => m.data);
    const stageMsg = posted.find((d: any) => d.type === 'diffStageLines');
    expect(stageMsg.payload.side).toBe('unstaged');
  });

  /* SNIPCODE-HOOK start: D5 default inline + remember choice */
  it('defaults to Inline (SBS is the least capable mode and must not be the silent default)', () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null);
    const { container } = render(Diff);
    expect(container.querySelector('.diff-hunk-header')).toBeTruthy(); // inline-only element
    expect(container.querySelector('.sbs-block-stage-btn')).toBeNull();
  });

  it('persists the mode via getVsCodeApi().setState when switched', async () => {
    // The shared test stub's setState/getState don't round-trip (they're a
    // fixed no-op object — see __tests__/setup.ts), so persistence-across-
    // remount is verified at the call-site level instead: switching modes
    // must call setState with the new value merged over any prior state.
    const setState = vi.fn();
    const getState = vi.fn(() => ({ someOtherKey: 1 }));
    vi.spyOn(vscodeApiModule, 'getVsCodeApi').mockReturnValue({ postMessage: vi.fn(), getState, setState });

    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null);
    const { getByText } = render(Diff);
    await fireEvent.click(getByText('Side by Side'));

    expect(setState).toHaveBeenCalledWith({ someOtherKey: 1, diffMode: 'side-by-side' });
    vi.restoreAllMocks();
  });

  it('initializes mode from a previously persisted webview state', () => {
    vi.spyOn(vscodeApiModule, 'getVsCodeApi').mockReturnValue({
      postMessage: vi.fn(), setState: vi.fn(), getState: () => ({ diffMode: 'side-by-side' }),
    });

    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null);
    const { container } = render(Diff);
    expect(container.querySelector('.sbs-block-stage-btn')).toBeTruthy();
    expect(container.querySelector('.diff-hunk-header')).toBeNull();
    vi.restoreAllMocks();
  });
  /* SNIPCODE-HOOK end */
});

/* SNIPCODE-HOOK start: D6/X2 file header — dir/base, status letter, +/- stats */
describe('Diff.svelte file header (D6/X2)', () => {
  it('splits the file path into dir/ and base in the mode-bar', () => {
    diffStore.setDiffs('/r', 'src/api/users.ts', textDiff('src/api/users.ts'), null);
    const { container } = render(Diff);
    expect(container.querySelector('.file-dir')!.textContent).toBe('src/api/');
    expect(container.querySelector('.file-base')!.textContent).toBe('users.ts');
  });

  it('shows no dir segment for a root-level file', () => {
    diffStore.setDiffs('/r', 'README.md', textDiff('README.md'), null);
    const { container } = render(Diff);
    expect(container.querySelector('.file-dir')).toBeNull();
    expect(container.querySelector('.file-base')!.textContent).toBe('README.md');
  });

  it('shows the M status letter and +/- counts for an ordinary modify', () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null);
    const { container } = render(Diff);
    const badge = container.querySelector('.side-badge.staged')!;
    expect(badge.querySelector('.side-status')!.textContent).toBe('M');
    const header = badge.parentElement!;
    expect(header.querySelector('.stat-add')!.textContent).toBe('+1');
    expect(header.querySelector('.stat-del')!.textContent).toBe('−0');
  });

  it('shows R for a renamed file (from DiffData.oldPath, no host wiring needed)', () => {
    const renamed: DiffData = { ...textDiff('new.ts'), oldPath: 'old.ts', similarity: 90 };
    diffStore.setDiffs('/r', 'new.ts', renamed, null);
    const { container } = render(Diff);
    expect(container.querySelector('.side-status')!.textContent).toBe('R');
  });

  it('shows A for a new file and D for a deleted file', () => {
    diffStore.setDiffs('/r', 'n.ts', { ...textDiff('n.ts'), newFile: true }, null);
    const added = render(Diff);
    expect(added.container.querySelector('.side-status')!.textContent).toBe('A');
    added.unmount();

    diffStore.setDiffs('/r', 'n.ts', { ...textDiff('n.ts'), deletedFile: true }, null);
    const { container } = render(Diff);
    expect(container.querySelector('.side-status')!.textContent).toBe('D');
  });

  it('computes stats independently per side (no double-counting across staged/unstaged)', () => {
    const staged = textDiff('a.ts'); // +1/-0
    const unstaged: DiffData = {
      ...textDiff('a.ts'),
      hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ type: 'delete', content: 'y', oldLineNumber: 1 }] }], // -1
    };
    diffStore.setDiffs('/r', 'a.ts', staged, unstaged);
    const { container } = render(Diff);
    const stagedBadge = container.querySelector('.side-badge.staged')!;
    const unstagedBadge = container.querySelector('.side-badge.unstaged')!;
    const stagedHeader = stagedBadge.parentElement!;
    const unstagedHeader = unstagedBadge.parentElement!;
    expect(stagedHeader.querySelector('.stat-add')!.textContent).toBe('+1');
    expect(stagedHeader.querySelector('.stat-del')!.textContent).toBe('−0');
    expect(unstagedHeader.querySelector('.stat-add')!.textContent).toBe('+0');
    expect(unstagedHeader.querySelector('.stat-del')!.textContent).toBe('−1');
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: D7 stop remounting the section on every stage */
describe('Diff.svelte section identity across a stage/unstage re-push (D7)', () => {
  it('keeps the same .diff-section DOM node when the store advances to a new generation', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null, 1);
    const { container } = render(Diff);
    const before = container.querySelector('.diff-section');
    expect(before).not.toBeNull();

    // Simulate the post-stage re-push: same repo/file/side, bumped generation
    // (exactly what DiffPanel.refreshIfCurrent's diffShow does).
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null, 2);
    await tick();

    const after = container.querySelector('.diff-section');
    expect(after).toBe(before); // same node — not torn down and recreated
  });

  it('DOES replace the section set when the side itself changes (staged -> also-unstaged)', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), null, 1);
    const { container } = render(Diff);
    expect(container.querySelectorAll('.diff-section').length).toBe(1);

    diffStore.setDiffs('/r', 'src/a.ts', textDiff(), textDiff(), 2);
    await tick();
    expect(container.querySelectorAll('.diff-section').length).toBe(2);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: ui/diff D11 next/prev hunk nav */
describe('Diff.svelte next/prev hunk navigation (D11)', () => {
  it('Next change lands on hunk 0 first, then hunk 1; Previous change goes back', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', twoHunkDiff(), null);
    const { getByLabelText, container } = render(Diff);
    const hunks = () => [...container.querySelectorAll('.diff-hunk')];

    await fireEvent.click(getByLabelText('Next change'));
    expect(hunks()[0].classList.contains('current-hunk')).toBe(true);
    expect(hunks()[1].classList.contains('current-hunk')).toBe(false);

    await fireEvent.click(getByLabelText('Next change'));
    expect(hunks()[0].classList.contains('current-hunk')).toBe(false);
    expect(hunks()[1].classList.contains('current-hunk')).toBe(true);

    // Already at the last hunk — Next is a no-op, not a wrap to hunk 0.
    await fireEvent.click(getByLabelText('Next change'));
    expect(hunks()[1].classList.contains('current-hunk')).toBe(true);

    await fireEvent.click(getByLabelText('Previous change'));
    expect(hunks()[0].classList.contains('current-hunk')).toBe(true);

    // Already at the first hunk — Previous is a no-op, not a wrap to the last.
    await fireEvent.click(getByLabelText('Previous change'));
    expect(hunks()[0].classList.contains('current-hunk')).toBe(true);
  });

  it('Alt+ArrowDown / Alt+ArrowUp drive the same navigation as the buttons', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', twoHunkDiff(), null);
    const { container } = render(Diff);
    const hunks = () => [...container.querySelectorAll('.diff-hunk')];

    await fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
    expect(hunks()[0].classList.contains('current-hunk')).toBe(true);

    await fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
    expect(hunks()[1].classList.contains('current-hunk')).toBe(true);

    await fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
    expect(hunks()[0].classList.contains('current-hunk')).toBe(true);
  });

  it('ignores plain arrow keys (no Alt) so it does not fight normal scrolling/typing', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', twoHunkDiff(), null);
    const { container } = render(Diff);
    await fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(container.querySelector('.current-hunk')).toBeNull();
  });

  it('resets navigation when switching diff mode (inline <-> SBS render different DOM)', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', twoHunkDiff(), null);
    const { getByLabelText, getByText, container } = render(Diff);
    await fireEvent.click(getByLabelText('Next change'));
    await fireEvent.click(getByLabelText('Next change'));
    expect(container.querySelectorAll('.diff-hunk')[1].classList.contains('current-hunk')).toBe(true);

    await fireEvent.click(getByText('Side by Side'));
    await tick();
    expect(container.querySelector('.current-hunk')).toBeNull();

    // And the next click starts fresh at hunk 0 again, not wherever it left off.
    await fireEvent.click(getByLabelText('Next change'));
    const sbsHunks = [...container.querySelectorAll('.sbs-left .sbs-hunk')];
    expect(sbsHunks[0].classList.contains('current-hunk')).toBe(true);
  });

  it('resets navigation when the shown file changes', async () => {
    diffStore.setDiffs('/r', 'src/a.ts', twoHunkDiff(), null);
    const { getByLabelText, container } = render(Diff);
    await fireEvent.click(getByLabelText('Next change'));
    expect(container.querySelector('.current-hunk')).not.toBeNull();

    diffStore.setDiffs('/r', 'src/b.ts', twoHunkDiff('src/b.ts'), null);
    await tick();
    expect(container.querySelector('.current-hunk')).toBeNull();
  });
});
/* SNIPCODE-HOOK end */
