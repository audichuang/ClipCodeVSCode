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
  it('setDiff stores the DiffData, file, repo and side', () => {
    diffStore.setDiff('/repo', 'src/a.ts', 'unstaged', sample());
    expect(diffStore.repoPath).toBe('/repo');
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.side).toBe('unstaged');
    expect(diffStore.diff?.hunks.length).toBe(1);
    expect(diffStore.error).toBeNull();
  });

  it('setDiff clears any prior error', () => {
    diffStore.error = 'boom';
    diffStore.setDiff('/repo', 'src/a.ts', 'staged', sample());
    expect(diffStore.error).toBeNull();
    expect(diffStore.side).toBe('staged');
  });

  it('reset clears everything', () => {
    diffStore.setDiff('/repo', 'src/a.ts', 'unstaged', sample());
    diffStore.reset();
    expect(diffStore.diff).toBeNull();
    expect(diffStore.file).toBe('');
  });
});
