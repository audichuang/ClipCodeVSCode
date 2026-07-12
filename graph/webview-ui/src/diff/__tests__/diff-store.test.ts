import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore, type DiffHunkView } from '../diff-store.svelte';

const HUNKS: DiffHunkView[] = [
  { header: '@@ -1,2 +1,2 @@', lines: [{ type: 'delete', content: 'a' }, { type: 'add', content: 'a2' }] },
  { header: '@@ -9,2 +9,2 @@', lines: [{ type: 'delete', content: 'b' }, { type: 'add', content: 'b2' }] },
];

beforeEach(() => diffStore.reset());

describe('DiffStore', () => {
  it('setDiff selects every hunk by default', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    expect(diffStore.file).toBe('f.txt');
    expect(diffStore.side).toBe('unstaged');
    expect(diffStore.selectedIndices).toEqual([0, 1]);
    expect(diffStore.canApply).toBe(true);
  });

  it('toggle flips a single hunk', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    diffStore.toggle(0);
    expect(diffStore.selectedIndices).toEqual([1]);
    diffStore.toggle(0);
    expect(diffStore.selectedIndices).toEqual([0, 1]);
  });

  it('clear empties the selection and blocks apply; selectAll restores it', () => {
    diffStore.setDiff('/repo', 'f.txt', 'staged', HUNKS);
    diffStore.clear();
    expect(diffStore.selectedIndices).toEqual([]);
    expect(diffStore.canApply).toBe(false);
    diffStore.selectAll();
    expect(diffStore.selectedIndices).toEqual([0, 1]);
    expect(diffStore.canApply).toBe(true);
  });

  it('actionLabel reflects the side', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    expect(diffStore.actionLabel).toBe('Stage 選取');
    diffStore.setDiff('/repo', 'f.txt', 'staged', HUNKS);
    expect(diffStore.actionLabel).toBe('Unstage 選取');
  });

  it('busy blocks apply (guards double-submit)', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', HUNKS);
    diffStore.busy = true;
    expect(diffStore.canApply).toBe(false);
  });

  it('an empty diff cannot apply', () => {
    diffStore.setDiff('/repo', 'f.txt', 'unstaged', []);
    expect(diffStore.canApply).toBe(false);
  });
});
