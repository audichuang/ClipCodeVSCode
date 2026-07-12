import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore } from '../diff-store.svelte';
import type { DiffData } from '../../lib/types';

function sample(): DiffData {
  return { file: 'src/a.ts', isBinary: false, isImage: false,
    hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ type: 'add', content: 'x', newLineNumber: 1 }] }] };
}

beforeEach(() => diffStore.reset());

describe('diffStore', () => {
  it('setDiffs stores both sides, file, repo and marks loaded', () => {
    diffStore.setDiffs('/repo', 'src/a.ts', sample(), null);
    expect(diffStore.repoPath).toBe('/repo');
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.stagedDiff?.hunks.length).toBe(1);
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.loaded).toBe(true);
    expect(diffStore.error).toBeNull();
  });

  it('setDiffs clears any prior error', () => {
    diffStore.error = 'boom';
    diffStore.setDiffs('/repo', 'src/a.ts', null, sample());
    expect(diffStore.error).toBeNull();
    expect(diffStore.unstagedDiff?.hunks.length).toBe(1);
  });

  it('reset clears everything including loaded', () => {
    diffStore.setDiffs('/repo', 'src/a.ts', sample(), sample());
    diffStore.reset();
    expect(diffStore.stagedDiff).toBeNull();
    expect(diffStore.unstagedDiff).toBeNull();
    expect(diffStore.file).toBe('');
    expect(diffStore.loaded).toBe(false);
  });
});
