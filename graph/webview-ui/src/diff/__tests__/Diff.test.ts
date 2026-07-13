import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import Diff from '../Diff.svelte';
import { diffStore } from '../diff-store.svelte';
import { i18n } from '../../lib/i18n/index.svelte';
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
    const { container } = render(Diff);
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
    const { container } = render(Diff);
    // Second section is Unstaged.
    const unstagedSection = container.querySelectorAll('.diff-section')[1];
    const arrow = unstagedSection.querySelector('.sbs-block-stage-btn');
    expect(arrow).toBeTruthy();
    await fireEvent.click(arrow!);
    const posted = globalThis.__postedMessages.map((m: any) => m.data);
    const stageMsg = posted.find((d: any) => d.type === 'diffStageLines');
    expect(stageMsg.payload.side).toBe('unstaged');
  });
});
