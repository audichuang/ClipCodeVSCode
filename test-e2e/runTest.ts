import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

// Build the temp fixture repo with the exact 2 commits the suite asserts on:
//   commit A: add a.ts, del.ts, old.ts
//   commit B: modify a.ts, delete del.ts, rename old.ts -> new.ts, add added.ts
function makeFixtureRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipcode-e2e-'));
  const write = (rel: string, content: string) => fs.writeFileSync(path.join(repoDir, rel), content);

  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'e2e@example.com');
  git(repoDir, 'config', 'user.name', 'Snipcode E2E');
  git(repoDir, 'config', 'commit.gpgsign', 'false');

  // commit A
  write('a.ts', 'export const a = 1;\n');
  write('del.ts', 'export const del = true;\n');
  write('old.ts', 'export const moved = "before";\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'commit A: initial files');

  // commit B
  write('a.ts', 'export const a = 2; // modified\n');
  fs.rmSync(path.join(repoDir, 'del.ts'));
  fs.renameSync(path.join(repoDir, 'old.ts'), path.join(repoDir, 'new.ts'));
  write('added.ts', 'export const added = true;\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'commit B: modify/delete/rename/add');

  return repoDir;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  const repoDir = makeFixtureRepo();

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        repoDir,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      // The fixture repo path is read back in the suite to build the payload.
      extensionTestsEnv: { SNIPCODE_E2E_REPO: repoDir },
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Failed to run e2e tests:', err);
  process.exit(1);
});
