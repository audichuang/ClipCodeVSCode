// SNIPCODE-HOOK: whole-file — Snipcode-added test helper (deterministic
// real-git race control, see docs/research/2026-07-11-e2e-test-strategy.md §2.2).

import { execSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { shellQuote } from './helpers';

/**
 * Test-only git binary shim (POSIX): intercepts ONE invocation of a given
 * subcommand (optionally restricted to a spawn cwd), blocks it until
 * release() or a 10s hard timeout, then execs the real git transparently
 * (exit code / stdio / signals pass through, env untouched).
 *
 * Ground rules honoured here:
 * - matcher skips git global options (`-c key=val`, `-C path`, `--flags`) so
 *   it sees the canonical subcommand;
 * - two-word targets ("stash push") match subcommand + first following arg,
 *   so "stash list" from a concurrent refresh is never intercepted;
 * - one-shot: a `consumed` sentinel guarantees only the first match blocks;
 * - the real git is resolved to an absolute path up front (no recursion);
 * - control files live in a unique temp dir; nothing goes to stdout/stderr.
 *
 * Point the code under test at `shim.path` via `setGitBinaryPath()` and
 * restore in afterEach — the path is module-global, so shim suites must not
 * run in parallel with other real-git suites in the same process.
 */
export interface GitShim {
  /** Absolute path of the shim executable — pass to setGitBinaryPath(). */
  path: string;
  /** Resolves once the target invocation has been intercepted and is blocked. */
  waitForIntercept(timeoutMs?: number): Promise<void>;
  /** Unblocks the intercepted invocation. */
  release(): void;
  cleanup(): void;
}

export function createGitShim(opts: { subcommand: string; cwd?: string }): GitShim {
  const realGit = execSync('command -v git', { encoding: 'utf-8', shell: '/bin/bash' }).trim();
  const ctrlDir = mkdtempSync(join(tmpdir(), 'ggp-shim-'));
  const shimPath = join(ctrlDir, 'git-shim.sh');
  const script = `#!/usr/bin/env bash
# Snipcode test shim — blocks one matching git invocation until released.
CTRL=${shellQuote(ctrlDir)}
REAL=${shellQuote(realGit)}
TARGET=${shellQuote(opts.subcommand)}
TARGET_CWD=${shellQuote(opts.cwd ?? '')}

sub=""
sub2=""
found=0
skip=0
for a in "$@"; do
  if [ "$skip" = "1" ]; then skip=0; continue; fi
  if [ "$found" = "1" ]; then sub2="$a"; break; fi
  case "$a" in
    -c|-C) skip=1 ;;
    -*) ;;
    *) sub="$a"; found=1 ;;
  esac
done

match="$sub"
case "$TARGET" in
  *" "*) match="$sub $sub2" ;;
esac

if [ "$match" = "$TARGET" ] && { [ -z "$TARGET_CWD" ] || [ "$PWD" = "$TARGET_CWD" ]; } \\
   && ! [ -e "$CTRL/consumed" ]; then
  : > "$CTRL/consumed"
  : > "$CTRL/entered"
  # shell-native counter: \`seq\` is not guaranteed on stock macOS, and a
  # silently-empty loop would let git proceed before release() — the race
  # test would then pass without exercising the interleaving.
  i=0
  while [ "$i" -lt 100 ]; do
    [ -e "$CTRL/release" ] && break
    sleep 0.1
    i=$((i+1))
  done
fi
exec "$REAL" "$@"
`;
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  return {
    path: shimPath,
    async waitForIntercept(timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(join(ctrlDir, 'entered'))) {
        if (Date.now() > deadline) {
          throw new Error(`git shim never intercepted '${opts.subcommand}' within ${timeoutMs}ms`);
        }
        await new Promise(r => setTimeout(r, 25));
      }
    },
    release(): void {
      writeFileSync(join(ctrlDir, 'release'), '');
    },
    cleanup(): void {
      try { rmSync(ctrlDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
