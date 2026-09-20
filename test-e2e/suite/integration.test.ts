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

  it('opens the graph and completes the webview boot handshake', async () => {
    // The command resolves only after the webview posts its first message to
    // the host — proof the bundled JS actually booted under the real CSP.
    // Catches asset 404, CSP-blocked scripts, bundle syntax errors, and
    // Svelte boot crashes that a bare "command did not throw" check misses;
    // rejects after 15s if the webview never speaks.
    await vscode.commands.executeCommand('gitGraphPlus.open');
  });

  it('END-TO-END copies full source at commit B (MODIFIED/DELETED/MOVED/NEW)', async () => {
    assert.ok(repoDir, 'SNIPCODE_E2E_REPO env set');

    const gitExt = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExt, 'vscode.git extension present');
    const gitApi = (await gitExt!.activate()).getAPI(1);
    const repo = await waitForRepo(gitApi, repoDir);

    const commitB = (await repo.log({ maxEntries: 5 })).find((commit: any) => commit.message.startsWith('commit B:'));
    assert.ok(commitB, 'commit B exists in the actual Git history');

    const payload: GraphCopyPayload = {
      hash: commitB!.hash,
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
    // Deliberately inverted: a deleted file now carries its PRE-DELETION content, which is
    // what IntelliJ has always put on the clipboard and what this tool's SCM path already
    // did — only Graph, PR and History emitted the bare marker, so the same deletion looked
    // different depending on which surface copied it. The marker is the fallback for when
    // no parent still has the file (a root commit, a shallow boundary).
    assert.match(clip, /export const del = true;/, 'deleted file carries its pre-deletion content');
    assert.doesNotMatch(clip, /This file has been deleted/, 'the marker is only a fallback');
    assert.match(clip, /\[MOVED\] new\.ts/, 'moved header');
    assert.match(clip, /\[NEW\] added\.ts/, 'new header');
  });

  it('END-TO-END copies committed files contributed by both merge parents', async () => {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const gitApi = (await gitExt!.activate()).getAPI(1);
    const repo = await waitForRepo(gitApi, repoDir);
    const merge = (await repo.log({ maxEntries: 1 }))[0];
    assert.equal(merge.message, 'merge side branches');
    assert.equal(merge.parents.length, 3, 'fixture must be a real octopus merge');

    await api.copyFullSourceAtCommit({
      hash: merge.hash,
      files: [
        { repoRootFsPath: repoDir, relativePath: 'side1.ts', status: 'A' },
        { repoRootFsPath: repoDir, relativePath: 'side2.ts', status: 'A' },
      ],
    });
    const clip = await vscode.env.clipboard.readText();
    assert.match(clip, /export const side1 = true;/, 'content contributed by merge parent 2');
    assert.match(clip, /export const side2 = true;/, 'content contributed by merge parent 3');
  });

  it('History copy lists and copies files contributed by every real merge parent', async () => {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    const gitApi = (await gitExt!.activate()).getAPI(1);
    const repo = await waitForRepo(gitApi, repoDir);
    const merge = (await repo.log({ maxEntries: 5 })).find((commit: any) => commit.message === 'merge side branches');
    assert.ok(merge, 'merge commit found in the actual Git history');
    assert.equal(merge!.parents.length, 3);

    // Drive the registered History command with a commit node; its provider calls the real
    // vscode.git diff API against every parent, then reads the resulting committed blobs.
    await vscode.commands.executeCommand('clipcode.history.copyFullSource', {
      kind: 'commit', commit: merge, contextValue: 'commit',
    });
    const clip = await vscode.env.clipboard.readText();

    assert.match(clip, /side1\.ts/, 'History includes the file from merge parent 2');
    assert.match(clip, /side2\.ts/, 'History includes the file from merge parent 3');
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
