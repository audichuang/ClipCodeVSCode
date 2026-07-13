import * as vscode from 'vscode';
import { BlameController, type BlameDeps } from './blameController.js';

interface GitRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export function registerBlame(context: vscode.ExtensionContext, deps: BlameDeps): BlameController {
  const controller = new BlameController(deps);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('clipcode.blame.toggle', () => controller.toggle()),
    vscode.commands.registerCommand('clipcode.blame.revealCommit', (_sha?: string) => {
      // v1: open the graph; commit-specific reveal is a follow-up.
      return vscode.commands.executeCommand('gitGraphPlus.open');
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => void controller.onActiveEditor(e)),
    // Tab close (not visibility loss) is the reset signal: switching tabs must
    // keep the blame toggle; closing the tab must drop it even when the
    // document stays open in another split (no onDidCloseTextDocument then).
    // Diff tabs count too — blame can be toggled on a diff editor's sides.
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (e.closed.length === 0) return;
      const urisOf = (input: unknown): vscode.Uri[] =>
        input instanceof vscode.TabInputText ? [input.uri]
          : input instanceof vscode.TabInputTextDiff ? [input.original, input.modified]
            : [];
      const stillOpen = new Set(vscode.window.tabGroups.all.flatMap(
        (g) => g.tabs.flatMap((t) => urisOf(t.input).map((u) => u.toString()))));
      for (const tab of e.closed) {
        for (const uri of urisOf(tab.input)) {
          controller.onTabClosed(uri.toString(), tab.group.viewColumn, stillOpen.has(uri.toString()));
        }
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => controller.onCloseDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => void controller.onDocChange(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => void controller.onDocChange(doc))
  );

  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) return controller;
  const ready = gitExtension.isActive
    ? Promise.resolve(gitExtension.exports)
    : gitExtension.activate();
  void Promise.resolve(ready).then(extension => {
    const api = extension.getAPI(1);
    // Track per-repo listeners so a closed repo's subscription is released
    // right away instead of leaking until deactivate (double dispose via
    // context.subscriptions is harmless).
    const repoSubs = new Map<GitRepository, vscode.Disposable>();
    const watch = (repo: GitRepository) => {
      const sub = repo.state.onDidChange(() => void controller.onRepoChange(repo.rootUri));
      repoSubs.set(repo, sub);
      context.subscriptions.push(sub);
    };
    for (const repo of api.repositories) watch(repo);
    context.subscriptions.push(
      api.onDidOpenRepository(watch),
      api.onDidCloseRepository((repo) => {
        repoSubs.get(repo)?.dispose();
        repoSubs.delete(repo);
      })
    );
  }).catch(() => {});
  return controller;
}
