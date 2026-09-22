import { describe, it, expect } from 'vitest';
import { resolveDefaultWorktreePath } from '../worktree-path';
/* SNIPCODE-HOOK start: native() — the product builds these paths with path.join / Uri.file,
   which are NATIVE (`\\repo\\src\\a.ts` on Windows); a bare POSIX literal matched only on
   macOS and Linux, by accident. */
import { normalize as nativePath } from 'path';
const native = (p: string): string => nativePath(p);
/* SNIPCODE-HOOK end */

describe('resolveDefaultWorktreePath', () => {
  it('bases the path on the main worktree, not the passed fallback', async () => {
    const gitService = {
      worktreeList: () => Promise.resolve([
        { path: '/repos/project', isMain: true },
        { path: '/repos/project.worktrees/feature', isMain: false },
      ] as any),
    };
    const result = await resolveDefaultWorktreePath(gitService, '/repos/project.worktrees/feature');
    expect(result).toBe(native('/repos/project.worktrees'));
  });

  it('falls back to the given path when worktreeList throws', async () => {
    const gitService = { worktreeList: () => Promise.reject(new Error('boom')) };
    const result = await resolveDefaultWorktreePath(gitService, '/repos/project');
    expect(result).toBe(native('/repos/project.worktrees'));
  });

  it('falls back to the given path when there is no main worktree', async () => {
    const gitService = { worktreeList: () => Promise.resolve([] as any) };
    const result = await resolveDefaultWorktreePath(gitService, '/repos/project');
    expect(result).toBe(native('/repos/project.worktrees'));
  });
});
