import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import type { ChangesWorkbench } from './changes-workbench';

/**
 * The small webview at the top of the Snipcode Git container: a shared commit
 * message box + Commit / Amend. The change list lives in the sibling TreeView.
 * On commit it calls ChangesWorkbench.commit() (which commits the staged index
 * of every repo with one shared message) and posts the per-repo results back.
 */
export class CommitBoxViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'snipcode.commitBox';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const assetRoot = MainPanel.assetRootUri ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    view.webview.html = this.getHtml(view.webview, assetRoot);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type !== 'workbenchCommit') return;
      const { message, amend } = msg.payload ?? {};
      try {
        const results = await this.workbench.commit(String(message ?? ''), Boolean(amend));
        view.webview.postMessage({ type: 'workbenchCommitResult', payload: { results } });
      } catch (err) {
        view.webview.postMessage({
          type: 'error',
          payload: { source: 'workbenchCommit', message: err instanceof Error ? err.message : String(err) },
        });
        void vscode.window.showErrorMessage(`提交失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'workbench.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet" />
  <link href="${codiconUri}" rel="stylesheet" />
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
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
