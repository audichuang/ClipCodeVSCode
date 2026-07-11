import * as vscode from 'vscode';
import { GitService } from '../git/git-service';
import { RepoDiscoveryService } from '../services/repo-discovery';
import { runExclusive } from '../services/mutation-coordinator';
import { MainPanel } from '../panels/MainPanel';
import { getWorkbenchStatus } from './workbench-status';
import { commitAcrossRepos } from './commit-across-repos';
import type { WorkbenchWebviewMessage, WorkbenchExtensionMessage } from './workbench-messages';

/**
 * Persistent Activity Bar side panel (its own WebviewView, NOT MainPanel's
 * editor-tab WebviewPanel). Mirrors MainPanel's CSP/nonce/asset resolution but
 * loads the workbench.* bundle. Mutations serialize through runExclusive
 * (per-repo, D2), independent of MainPanel's transaction gate.
 */
export class CommitWorkbenchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'snipcode.commitWorkbench';

  private view: vscode.WebviewView | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assetRoot = MainPanel.assetRootUri
      ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [assetRoot],
    };
    view.webview.onDidReceiveMessage((m: WorkbenchWebviewMessage) => this.onMessage(m));
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.html = this.getHtml(view.webview, assetRoot);
    // First paint pushes status; the webview also asks on boot (Task 8).
    void this.refresh();
  }

  /** Debounced re-status; call from a file/HEAD watcher (Task 5 step 4). */
  scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  private async onMessage(m: WorkbenchWebviewMessage): Promise<void> {
    switch (m.type) {
      case 'workbenchGetStatus':
        await this.refresh();
        return;
      case 'workbenchCommit': {
        try {
          const results = await commitAcrossRepos(
            {
              runExclusive,
              commitSelected: (repoPath, message, files, opts) =>
                new GitService(repoPath).commitSelected(message, files, opts),
            },
            m.payload.message,
            m.payload.repos,
            { amend: m.payload.amend },
          );
          this.post({ type: 'workbenchCommitResult', payload: { results } });
        } catch (err) {
          // Whole-batch failure (should be rare — per-repo errors are caught
          // inside commitAcrossRepos). Surface via error so the webview clears
          // its loading state (Global Constraint 6).
          this.post({ type: 'error', payload: { message: errText(err), source: 'workbenchCommit' } });
        }
        // Status changes after any commit — push a fresh tree so successful
        // repos drop their committed files.
        await this.refresh();
        return;
      }
    }
  }

  private async refresh(): Promise<void> {
    if (!this.view) return;
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const repos = await RepoDiscoveryService.discoverRepos(folders).catch(() => []);
    const status = await getWorkbenchStatus(repos.map((r) => r.path));
    this.post({ type: 'workbenchStatus', payload: status });
  }

  private post(msg: WorkbenchExtensionMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${codiconUri}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Snipcode Commit Workbench</title>
</head>
<body>
  <div id="workbench-app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
