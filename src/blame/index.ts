import * as vscode from 'vscode';
import { BlameController, type BlameDeps } from './blameController.js';

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
    vscode.workspace.onDidChangeTextDocument((e) => void controller.onDocChange(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => void controller.onDocChange(doc))
  );
}
