import * as assert from 'node:assert';

import * as vscode from 'vscode';

const repoDir = process.env.SNIPCODE_E2E_REPO as string;

interface GraphCopyPayload {
  hash: string;
  files: { repoRootFsPath: string; relativePath: string; oldRelativePath?: string; status: string }[];
}
interface SnipcodeApi {
  copyFullSourceAtCommit(payload: GraphCopyPayload): Promise<void>;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Poll the VS Code Git API until it has discovered the fixture repo.
async function waitForRepo(gitApi: any, dir: string, timeoutMs = 30000): Promise<any> {
  const target = norm(dir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const repo = gitApi.repositories.find((r: any) => norm(r.rootUri.fsPath) === target);
    if (repo) return repo;
    await delay(250);
  }
  throw new Error(`Git API never discovered repo at ${dir}`);
}

describe('Snipcode × git-graph-plus integration', () => {
  let api: SnipcodeApi;

  it('activates and registers commands (graph + existing clipcode)', async () => {
    const ext = vscode.extensions.getExtension<SnipcodeApi>('audichuang.clipcode-vscode');
    assert.ok(ext, 'extension present');
    api = await ext!.activate();
    assert.ok(ext!.isActive, 'extension is active');

    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('gitGraphPlus.open'), 'graph view command registered');
    assert.ok(
      cmds.includes('clipcode.copyGitChanges') || cmds.some((c) => c.startsWith('clipcode.')),
      'existing clipcode commands intact',
    );
  });

  it('opens the graph without throwing', async () => {
    // webview CSP/404 is hard to assert headless; at least the command resolves and runs.
    await vscode.commands.executeCommand('gitGraphPlus.open');
  });

  it('END-TO-END copies full source at commit B (MODIFIED/DELETED/MOVED/NEW)', async () => {
    assert.ok(repoDir, 'SNIPCODE_E2E_REPO env set');

    const gitExt = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExt, 'vscode.git extension present');
    const gitApi = (await gitExt!.activate()).getAPI(1);
    const repo = await waitForRepo(gitApi, repoDir);

    // commit B is HEAD.
    const log = await repo.log({ maxEntries: 1 });
    const hashB = log[0].hash;

    const payload: GraphCopyPayload = {
      hash: hashB,
      files: [
        { repoRootFsPath: repoDir, relativePath: 'a.ts', status: 'M' },
        { repoRootFsPath: repoDir, relativePath: 'del.ts', status: 'D' },
        { repoRootFsPath: repoDir, relativePath: 'new.ts', oldRelativePath: 'old.ts', status: 'R' },
        { repoRootFsPath: repoDir, relativePath: 'added.ts', status: 'A' },
      ],
    };

    await api.copyFullSourceAtCommit(payload);
    const clip = await vscode.env.clipboard.readText();

    assert.match(clip, /\/\/ file: \[MODIFIED\] a\.ts/, 'modified header');
    assert.match(clip, /export const a = 2;/, 'modified content at commit B');
    assert.match(clip, /\[DELETED\] del\.ts/, 'deleted header');
    assert.match(clip, /This file has been deleted/, 'deleted marker');
    assert.match(clip, /\[MOVED\] new\.ts/, 'moved header');
    assert.match(clip, /\[NEW\] added\.ts/, 'new header');
  });

  it('END-TO-END copies WORKING-TREE source for the UNCOMMITTED view', async () => {
    assert.ok(repoDir, 'SNIPCODE_E2E_REPO env set');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    // Make on-disk (uncommitted) changes the committed blobs do not have.
    await fs.writeFile(path.join(repoDir, 'a.ts'), 'export const a = 999; // working tree', 'utf8');
    await fs.writeFile(path.join(repoDir, 'working-only.ts'), 'export const wonly = true;', 'utf8');

    const payload: GraphCopyPayload = {
      hash: 'UNCOMMITTED',
      files: [
        { repoRootFsPath: repoDir, relativePath: 'a.ts', status: 'M' },
        { repoRootFsPath: repoDir, relativePath: 'working-only.ts', status: 'U' }, // git-graph-plus untracked
      ],
    };

    await api.copyFullSourceAtCommit(payload);
    const clip = await vscode.env.clipboard.readText();

    assert.match(clip, /\/\/ file: \[MODIFIED\] a\.ts/, 'modified header');
    assert.match(clip, /export const a = 999; \/\/ working tree/, 'reads WORKING-TREE content, not the committed blob');
    assert.ok(!/export const a = 2;/.test(clip), 'does not fall back to committed content');
    assert.match(clip, /\[NEW\] working-only\.ts/, 'untracked status U maps to NEW');
    assert.match(clip, /export const wonly = true;/, 'untracked working file content');
  });

  it('best-effort lifecycle: re-running open does not throw', async () => {
    await vscode.commands.executeCommand('gitGraphPlus.open');
    await vscode.commands.executeCommand('gitGraphPlus.refresh');
  });
});
