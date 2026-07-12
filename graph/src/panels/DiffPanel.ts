import * as vscode from 'vscode';
import * as path from 'path';
import { MainPanel } from './MainPanel';
import { SequenceGuard } from '../utils/sequence-guard';
import type { ChangesWorkbench } from '../tree/changes-workbench';

/**
 * Full-width Diff shown in an EDITOR TAB (WebviewPanel), replacing the B-2b side
 * panel. One singleton panel is re-used and retitled per clicked file. It hosts
 * the self-contained diff.js bundle (FileDiffView: side-by-side + Shiki), and
 * per-hunk Stage/Unstage routes through ChangesWorkbench → GitService.
 *
 * The diff.js bundle is a CLASSIC <script> (nonce CSP), mirroring MainPanel's
 * CSP/nonce/asset loading.
 */
export class DiffPanel {
  static readonly viewType = 'snipcode.diffPanel';
  private static instance: DiffPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  /** The file currently shown; drives retitle + refreshIfCurrent. Both sides
   *  (staged + unstaged) are pushed together, so this is keyed by file only. */
  private current: { repoPath: string; file: string } | undefined;
  /** Set once the webview's listener has confirmed it's installed (`diffReady`).
   *  Guards against posting `diffShow`/`setLocale` before the listener exists,
   *  which would silently drop the message (see the `diffReady` handler below,
   *  which re-sends locale + current diff on the handshake). */
  private ready = false;
  /** Drops a late fileDiffData reply for a file the user already navigated away
   *  from (rapid clicks / post-apply refresh racing a navigation). */
  private readonly seq = new SequenceGuard();

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  static register(extensionUri: vscode.Uri, workbench: ChangesWorkbench): DiffPanel {
    DiffPanel.instance = new DiffPanel(extensionUri, workbench);
    return DiffPanel.instance;
  }

  /** Open (or reveal) the panel for a file and push both sides' diffs. */
  show(repoPath: string, file: string): void {
    this.current = { repoPath, file };
    const ticket = this.seq.issue();
    if (!this.panel) { this.createPanel(); }
    this.panel!.title = `Diff: ${path.basename(file)}`;
    // Reveal without stealing the editor group focus away from the tree click.
    this.panel!.reveal(vscode.ViewColumn.Active, false);
    // Before the handshake lands, the webview's listener isn't installed yet and
    // this postMessage would be silently dropped; the `diffReady` handler below
    // re-pushes `this.current` once it does.
    if (this.ready) { void this.push(this.current, ticket); }
  }

  /** Re-render ONLY if it is still the file the user is viewing (post-apply). */
  refreshIfCurrent(repoPath: string, file: string): void {
    if (this.panel && this.current?.repoPath === repoPath && this.current?.file === file) {
      this.show(repoPath, file);
    }
  }

  private createPanel(): void {
    const assetRoot = MainPanel.assetRootUri
      ?? vscode.Uri.joinPath(this.extensionUri, 'webview-ui', 'dist');
    const panel = vscode.window.createWebviewPanel(
      DiffPanel.viewType,
      'Diff',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [assetRoot],
      },
    );
    panel.webview.html = this.getHtml(panel.webview, assetRoot);
    // Don't postLocale yet — the webview's message listener isn't installed
    // until it posts back `diffReady` (handled below), and an earlier post
    // would be silently dropped.
    this.ready = false;

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'diffReady') {
        this.ready = true;
        this.postLocale(panel);
        if (this.current) { void this.push(this.current, this.seq.issue()); }
        return;
      }
      /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage. */
      if (msg?.type === 'diffStageLines') {
        const { repoPath, file, side, hunkIndex, lineIndices } = msg.payload ?? {};
        const idx = Number(hunkIndex);
        const lines = Array.isArray(lineIndices) ? lineIndices.map(Number) : [];
        try {
          if (side === 'unstaged') {
            await this.workbench.stageLines(String(repoPath), String(file), idx, lines);
          } else {
            await this.workbench.unstageLines(String(repoPath), String(file), idx, lines);
          }
          // stageLines/unstageLines call refreshIfCurrent → re-push the new diff.
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message } });
          void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
        }
        return;
      }
      /* SNIPCODE-HOOK end */
      if (msg?.type !== 'diffStageHunk') { return; }
      const { repoPath, file, side, hunkIndex } = msg.payload ?? {};
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        }
        // stageHunks/unstageHunks call refreshIfCurrent → re-push the new diff.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message } });
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
      }
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.current = undefined;
      this.ready = false;
    });
    this.panel = panel;
  }

  private async push(
    target: { repoPath: string; file: string },
    ticket: number,
  ): Promise<void> {
    if (!this.panel) { return; }
    const { repoPath, file } = target;
    // One ticket for the combined fetch: both sides resolve, then a single
    // isCurrent() check + single post, so rapid file navigation stays latest-wins
    // and the view never shows half-old / half-new.
    const [stagedDiff, unstagedDiff] = await Promise.all([
      this.workbench.fileDiffData(repoPath, file, 'staged'),
      this.workbench.fileDiffData(repoPath, file, 'unstaged'),
    ]);
    if (!this.seq.isCurrent(ticket) || !this.panel) { return; } // superseded / disposed
    this.panel.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, stagedDiff, unstagedDiff } });
  }

  private postLocale(panel: vscode.WebviewPanel): void {
    const setting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = setting === 'auto' ? (vscode.env.language || 'en') : setting;
    panel.webview.postMessage({ type: 'setLocale', payload: { locale } });
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

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.current = undefined;
    this.ready = false;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) { text += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return text;
}
