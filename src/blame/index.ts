import * as vscode from 'vscode';
import { BlameController, type BlameDeps } from './blameController.js';

interface GitRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}

interface GitApi {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

export function registerBlame(context: vscode.ExtensionContext, deps: BlameDeps): void {
  const controller = new BlameController(deps);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand('clipcode.blame.toggle', () => controller.toggle()),
    vscode.commands.registerCommand('clipcode.blame.revealCommit', (_sha?: string) => {
      // v1: open the graph; commit-specific reveal is a follow-up.
      return vscode.commands.executeCommand('gitGraphPlus.open');
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => void controller.onActiveEditor(e)),
    vscode.window.onDidChangeVisibleTextEditors((editors) => controller.onVisibleEditors(editors)),
    vscode.workspace.onDidCloseTextDocument((doc) => controller.onCloseDocument(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => void controller.onDocChange(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => void controller.onDocChange(doc))
  );

  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) return;
  const ready = gitExtension.isActive
    ? Promise.resolve(gitExtension.exports)
    : gitExtension.activate();
  void Promise.resolve(ready).then(extension => {
    const api = extension.getAPI(1);
    const watch = (repo: GitRepository) => {
      context.subscriptions.push(
        repo.state.onDidChange(() => void controller.onRepoChange(repo.rootUri))
      );
    };
    for (const repo of api.repositories) watch(repo);
    context.subscriptions.push(api.onDidOpenRepository(watch));
  }).catch(() => {});
}
