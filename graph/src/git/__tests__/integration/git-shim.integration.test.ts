// SNIPCODE-HOOK: whole-file — Snipcode test helper's own regression test.
//
// live-QA-4: a real-VS Code pass on macOS hit `MainPanel.crossRepoMutation`
// hanging until timeout. Root cause was not the code under test but this shim:
// it compared the spawn cwd it was told about (the LOGICAL path `mkdtemp`
// returns, /var/folders/... on macOS) against the shell's `$PWD` (the PHYSICAL
// path, /private/var/folders/...). The strings never matched, the shim let every
// invocation through, and the test waited forever for an intercept that could
// not happen — a harness bug masquerading as a product failure.
//
// Linux keeps /tmp real, so the platform difference is reproduced here with an
// explicit symlink: that is the whole condition, macOS just ships one by default.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createGitShim, type GitShim } from './git-shim';
import { createTempRepo, type TempRepo } from './helpers';

const d = process.platform !== 'win32' ? describe : describe.skip;

d('git shim cwd matching', () => {
  let repo: TempRepo | undefined;
  let linkRoot: string | undefined;
  let shim: GitShim | undefined;

  afterEach(() => {
    shim?.release();
    shim?.cleanup();
    repo?.cleanup();
    if (linkRoot) { rmSync(linkRoot, { recursive: true, force: true }); }
    shim = repo = linkRoot = undefined;
  });

  it('intercepts when the repo is reached through a symlinked path', async () => {
    repo = createTempRepo();
    linkRoot = mkdtempSync(join(tmpdir(), 'ggp-shim-link-'));
    const linked = join(linkRoot, 'repo');
    symlinkSync(repo.path, linked);

    // The shim is told the LOGICAL path, exactly as a test gets it from mkdtemp.
    shim = createGitShim({ subcommand: 'status', cwd: linked });
    const child = spawn(shim.path, ['status'], { cwd: linked, stdio: 'ignore' });
    // Attach the exit listener NOW: an unblocked child can be gone before the
    // await below runs, and a listener added after that never fires.
    const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
    try {
      await expect(shim.waitForIntercept(3000)).resolves.toBeUndefined();
    } finally {
      shim.release();
      await exited;
    }
  });

  it('still ignores an invocation from a different repo', async () => {
    repo = createTempRepo();
    const other = createTempRepo();
    shim = createGitShim({ subcommand: 'status', cwd: repo.path });
    const child = spawn(shim.path, ['status'], { cwd: other.path, stdio: 'ignore' });
    const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
    try {
      await exited; // runs straight through — nothing to intercept
      await expect(shim.waitForIntercept(600)).rejects.toThrow(/never intercepted/);
    } finally {
      other.cleanup();
    }
  });
});
