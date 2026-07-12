import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import { SequenceGuard } from '../utils/sequence-guard';
import type { ChangeGroup } from './build-change-tree';
import type { ChangesWorkbench } from './changes-workbench';

/**
 * The Diff webview at the bottom of the Snipcode Git container. Clicking a file
 * node in the Changes tree drives show(): the host fetches that file's staged or
 * unstaged hunks and posts them here; each hunk gets a checkbox and a
 * "Stage 選取 / Unstage 選取" button that applies the checked hunks to the real
 * index (via ChangesWorkbench → GitService.stageHunks / unstageHunks).
 *
 * Its bundle (diff.js/diff.css) is a self-contained CLASSIC script — mirrors
 * CommitBoxViewProvider's CSP/nonce/asset loading.
 */
export class SnipcodeDiffViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'snipcode.diff';

  private view: vscode.WebviewView | undefined;
  /** The last-requested diff, buffered until the view has resolved (a collapsed
   *  view has no webview yet) and re-pushed on every show(). */
  private pending: { repoPath: string; file: string; side: ChangeGroup } | undefined;
  /** Guards against a late fileDiff() reply for a file the user already
   *  navigated away from clobbering the newer diff (rapid clicks / post-apply
   *  refresh racing a navigation). */
  private readonly seq = new SequenceGuard();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  /** Show a file's diff in the panel. Called on a tree click and again after a
   *  stage/unstage so the panel reflects the file's new state. */
  show(repoPath: string, file: string, side: ChangeGroup): void {
    this.pending = { repoPath, file, side };
    const ticket = this.seq.issue();
    if (this.view) {
      this.view.show?.(true); // reveal without stealing focus, if collapsed
      void this.push(this.pending, ticket);
    } else {
      // Force the view to resolve; push() runs from resolveWebviewView.
      void vscode.commands.executeCommand('snipcode.diff.focus');
    }
  }

  /** Re-render a file's diff ONLY if it is still the file the user is viewing.
   *  Used after a stage/unstage so a slow apply that finishes after the user
   *  clicked another file does not yank the panel back to the stale file. */
  refreshIfCurrent(repoPath: string, file: string, side: ChangeGroup): void {
    if (this.pending?.repoPath === repoPath && this.pending?.file === file) {
      this.show(repoPath, file, side);
    }
  }

  private async push(
    target: { repoPath: string; file: string; side: ChangeGroup },
    ticket: number,
  ): Promise<void> {
    if (!this.view) { return; }
    const { repoPath, file, side } = target;
    const hunks = await this.workbench.fileDiff(repoPath, file, side);
    // A newer show() (a different file / side) supersedes this reply — drop it.
    if (!this.seq.isCurrent(ticket)) { return; }
    void this.view.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, side, hunks } });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const assetRoot = MainPanel.assetRootUri ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [assetRoot] };
    view.webview.html = this.getHtml(view.webview, assetRoot);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type !== 'diffStageHunks') { return; }
      const { repoPath, file, side, hunkIndices } = msg.payload ?? {};
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), hunkIndices as number[]);
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), hunkIndices as number[]);
        }
        // ChangesWorkbench.stageHunks/unstageHunks re-push the file's new diff
        // (via this.show), so no extra post is needed here.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void view.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunks', message } });
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
      }
    });

    // Flush any diff requested before the view resolved.
    if (this.pending) { void this.push(this.pending, this.seq.issue()); }
  }

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.css'));
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
  <div id="diff-app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}
