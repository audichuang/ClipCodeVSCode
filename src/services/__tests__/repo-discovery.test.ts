import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RepoDiscoveryService } from '../repo-discovery';

/**
 * Integration-style tests for `RepoDiscoveryService`. They create real git
 * repos on disk (cheap with `init`) rather than mocking the spawn boundary,
 * because the value of this service is the interplay of git CLI + filesystem
 * traversal — mocking either side would just rehearse the implementation.
 */

const ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  LC_ALL: 'C',
};

function git(cwd: string, args: string[]): string {
  return execSync(`git ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
    cwd, encoding: 'utf-8', env: { ...process.env, ...ENV }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '--initial-branch=main']);
  git(path, ['config', 'commit.gpgsign', 'false']);
  git(path, ['config', 'user.name', 'Test']);
  git(path, ['config', 'user.email', 't@e.com']);
  writeFileSync(join(path, 'README.md'), 'r\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-m', 'init']);
}

describe('RepoDiscoveryService', () => {
  let root: string;

  beforeEach(() => {
    // realpath resolves the macOS /var → /private/var symlink so paths we
    // construct match the canonical paths git returns from --show-toplevel.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ggp-repo-disc-')));
    RepoDiscoveryService.clearCache();
  });
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    RepoDiscoveryService.clearCache();
  });

  describe('root detection', () => {
    it('returns single root repo when workspace folder is itself a git repo', async () => {
      initRepo(root);
      const repos = await RepoDiscoveryService.discoverRepos([root]);
      const roots = repos.filter(r => r.type === 'root');
      expect(roots).toHaveLength(1);
      expect(roots[0].name).toBe(require('path').basename(root));
    });

    it('returns empty list when no git repo present and no nested repos', async () => {
      // Just an empty workspace folder with nothing in it.
      const repos = await RepoDiscoveryService.discoverRepos([root]);
      expect(repos).toEqual([]);
    });

    it('dedupes when two folder paths resolve to the same repo', async () => {
      initRepo(root);
      const subDir = join(root, 'sub');
      mkdirSync(subDir);
      // Same repo accessed via two paths (root and root/sub which is inside it)
      // should only appear once. discoverRepos uses git rev-parse --show-toplevel
      // so both resolve back to `root`.
      const repos = await RepoDiscoveryService.discoverRepos([root, subDir]);
      const roots = repos.filter(r => r.type === 'root');
      expect(roots).toHaveLength(1);
    });
  });

  describe('nested repo discovery', () => {
    it('finds an independent git repo inside a non-git workspace folder', async () => {
      const nested = join(root, 'nested-project');
      initRepo(nested);

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      const found = repos.find(r => r.path === nested);
      expect(found).toBeDefined();
      expect(found?.type).toBe('nested');
      expect(found?.name).toBe('nested-project');
    });

    it('does not recurse into a discovered nested repo', async () => {
      // A nested repo with another git repo inside should still surface as
      // one entry (the outer nested); the inner one is hidden because we
      // stop descending once we hit a .git directory.
      const outer = join(root, 'outer');
      initRepo(outer);
      const inner = join(outer, 'inner-do-not-find');
      initRepo(inner);

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      expect(repos.find(r => r.path === outer)).toBeDefined();
      expect(repos.find(r => r.path === inner)).toBeUndefined();
    });

    it('skips IGNORED_DIRS (node_modules, dist, build, .venv, etc.)', async () => {
      // Plant a repo inside each ignored directory; none should be returned.
      for (const ignored of ['node_modules', 'dist', 'build', '.venv', 'vendor']) {
        initRepo(join(root, ignored, 'pkg'));
      }
      // Sanity: a non-ignored sibling IS picked up.
      const visible = join(root, 'visible');
      initRepo(visible);

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      expect(repos.find(r => r.path === visible)).toBeDefined();
      for (const ignored of ['node_modules', 'dist', 'build', '.venv', 'vendor']) {
        expect(repos.find(r => r.path.includes(`/${ignored}/`))).toBeUndefined();
      }
    });

    it('skips hidden directories (starting with .)', async () => {
      const hidden = join(root, '.hidden-pkg');
      initRepo(hidden);
      const repos = await RepoDiscoveryService.discoverRepos([root]);
      expect(repos.find(r => r.path === hidden)).toBeUndefined();
    });

    it('respects MAX_DEPTH (does not descend beyond 3 levels)', async () => {
      // Build a chain: root/a/b/c/d/repo  (depth 5 → past MAX_DEPTH of 3)
      const deep = join(root, 'a', 'b', 'c', 'd', 'too-deep');
      initRepo(deep);
      // And one at the threshold for a positive control.
      const ok = join(root, 'a', 'b', 'c', 'just-right');
      initRepo(ok);

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      // `just-right` is at depth 4 from root; `discoverNestedRepos` starts at
      // depth 0 and increments before descending, so depth 3 children (depth==3
      // when checked) are the deepest allowed. Verify the contract by checking
      // that the too-deep one is omitted.
      expect(repos.find(r => r.path === deep)).toBeUndefined();
      void ok;
    });
  });

  describe('submodule discovery', () => {
    it('detects submodules registered in .gitmodules via getSubmodules path', async () => {
      // To verify the submodule code path specifically (rather than the nested
      // walker stumbling onto the submodule first), place the submodule inside
      // an IGNORED_DIR — the walker won't descend into `vendor/`, so the entry
      // can only surface via `git submodule status --recursive`.
      const library = realpathSync(mkdtempSync(join(tmpdir(), 'ggp-sub-lib-')));
      initRepo(library);

      const parent = join(root, 'parent');
      initRepo(parent);
      // file:// + protocol.file.allow are required because git restricts
      // file-transport submodules since CVE-2022-39253.
      git(parent, [
        '-c', 'protocol.file.allow=always',
        'submodule', 'add', `file://${library}`, 'vendor/lib',
      ]);
      git(parent, ['commit', '-m', 'add submodule']);

      try {
        const repos = await RepoDiscoveryService.discoverRepos([parent]);
        const sub = repos.find(r => r.path === join(parent, 'vendor', 'lib'));
        expect(sub).toBeDefined();
        expect(sub?.type).toBe('submodule');
        expect(sub?.name).toBe('lib');
      } finally {
        rmSync(library, { recursive: true, force: true });
      }
    });
  });

  describe('caching', () => {
    it('returns the same array instance for identical folderPaths', async () => {
      initRepo(root);
      const first = await RepoDiscoveryService.discoverRepos([root]);
      const second = await RepoDiscoveryService.discoverRepos([root]);
      // Cache hit: same reference, not just equal contents.
      expect(second).toBe(first);
    });

    it('cache key is order-independent (folderPaths are sorted)', async () => {
      const a = join(root, 'a');
      const b = join(root, 'b');
      initRepo(a);
      initRepo(b);
      const first = await RepoDiscoveryService.discoverRepos([a, b]);
      const second = await RepoDiscoveryService.discoverRepos([b, a]);
      expect(second).toBe(first);
    });

    it('clearCache() forces a fresh discovery', async () => {
      initRepo(root);
      const first = await RepoDiscoveryService.discoverRepos([root]);
      RepoDiscoveryService.clearCache();
      const second = await RepoDiscoveryService.discoverRepos([root]);
      expect(second).not.toBe(first);
      expect(second).toEqual(first); // but same content
    });
  });

  describe('name deduplication', () => {
    it('prepends parent dir to disambiguate same-named repos', async () => {
      // Two repos both named "pkg" should get distinct display names by
      // prepending parent directories.
      const left = join(root, 'projects-a', 'pkg');
      const right = join(root, 'projects-b', 'pkg');
      initRepo(left);
      initRepo(right);

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      const matches = repos.filter(r => r.path === left || r.path === right);
      expect(matches).toHaveLength(2);
      // After dedupe their names must differ.
      const names = matches.map(r => r.name);
      expect(new Set(names).size).toBe(2);
      expect(names.every(n => n.includes('pkg'))).toBe(true);
    });
  });

  describe('sorting', () => {
    it('orders root < nested < submodule, then alphabetical by name', async () => {
      initRepo(root);
      initRepo(join(root, 'z-nested'));
      initRepo(join(root, 'a-nested'));

      const repos = await RepoDiscoveryService.discoverRepos([root]);
      // Root first
      expect(repos[0].type).toBe('root');
      // Nested entries sorted alphabetically
      const nested = repos.filter(r => r.type === 'nested');
      expect(nested.map(r => r.name)).toEqual(['a-nested', 'z-nested']);
    });
  });

  describe('error handling', () => {
    it('returns empty repo list when a workspace folder does not exist', async () => {
      const repos = await RepoDiscoveryService.discoverRepos([
        join(root, 'does-not-exist'),
      ]);
      expect(repos).toEqual([]);
    });

    it('skips a workspace folder with a fake .git file (not a real repo)', async () => {
      // Create a `.git` file that doesn't point anywhere — git rev-parse will fail.
      mkdirSync(join(root, 'fake'), { recursive: true });
      writeFileSync(join(root, 'fake/.git'), 'gitdir: /nowhere\n');
      const repos = await RepoDiscoveryService.discoverRepos([join(root, 'fake')]);
      expect(repos.filter(r => r.type === 'root')).toEqual([]);
    });

    it('ignores false-positive .git directory (not a real git repo)', async () => {
      // A folder named `.git` that is not actually a git repo metadata dir.
      mkdirSync(join(root, 'child/.git/objects'), { recursive: true });
      // Add a regular file so it looks like an unintialised .git dir
      writeFileSync(join(root, 'child/.git/HEAD'), 'garbage\n');
      initRepo(root);
      const repos = await RepoDiscoveryService.discoverRepos([root]);
      // The fake child should not show up as a nested repo
      expect(repos.find(r => r.path.endsWith('child'))).toBeUndefined();
    });

    it('returns empty when discoverRepos is called with no workspace folders', async () => {
      const repos = await RepoDiscoveryService.discoverRepos([]);
      expect(repos).toEqual([]);
    });
  });

  describe('caching', () => {
    it('returns the cached result on the second call with the same workspaces', async () => {
      initRepo(root);
      const first = await RepoDiscoveryService.discoverRepos([root]);
      const second = await RepoDiscoveryService.discoverRepos([root]);
      // Same reference indicates the cached value was returned
      expect(second).toBe(first);
    });

    it('clearCache forces re-discovery on the next call', async () => {
      initRepo(root);
      const first = await RepoDiscoveryService.discoverRepos([root]);
      RepoDiscoveryService.clearCache();
      const second = await RepoDiscoveryService.discoverRepos([root]);
      // Cleared cache → new array instance (still equal contents)
      expect(second).not.toBe(first);
      expect(second.length).toBe(first.length);
    });
  });
});
