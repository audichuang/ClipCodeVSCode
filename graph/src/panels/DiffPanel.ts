import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { readFile, stat } from 'fs/promises';
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
/** Posted back for a stage request whose target no longer matches the shown file
 *  (stale click racing a navigation, or a forged payload) — unlocks the webview's
 *  busy gate instead of leaving it to the timeout. */
const STALE_TARGET = 'Stale stage request — the shown file changed';

/** Same map MainPanel's getImageAtRef uses for its commit-view ImageDiff. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
};

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

  /** URI scheme for the open-in-editor full-file view; content comes from our
   *  own GitService so it works without the built-in git extension. */
  static readonly contentScheme = 'snipcode-diff';
  private contentProvider: vscode.Disposable | undefined;

  static register(extensionUri: vscode.Uri, workbench: ChangesWorkbench): DiffPanel {
    const panel = new DiffPanel(extensionUri, workbench);
    panel.contentProvider = vscode.workspace.registerTextDocumentContentProvider(DiffPanel.contentScheme, {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const { repoPath, file, ref } = JSON.parse(uri.query);
        // Absent at the ref (e.g. a new file at HEAD) → empty side, whole file
        // reads as added.
        return workbench.fileAtRef(String(repoPath), String(ref), String(file)).catch(() => '');
      },
    });
    DiffPanel.instance = panel;
    return panel;
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

  /** A stage request may only target the file this panel is itself showing — the
   *  webview holds no authority of its own, so a stale or forged repoPath/file
   *  must not reach GitService's index mutations. */
  private isCurrentTarget(repoPath: unknown, file: unknown): boolean {
    return !!this.current && this.current.repoPath === repoPath && this.current.file === file;
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
      // ImageDiff (inside FileDiffView) fetches both sides' bytes itself; without
      // this case an image file's sections would sit blank forever (MainPanel has
      // the equivalent handler for the graph's commit view).
      if (msg?.type === 'getImageAtRef') {
        const { ref, path: filePath } = msg.payload ?? {};
        await this.sendImage(panel, String(ref), String(filePath));
        return;
      }
      // Full-file view for one side in a NATIVE diff editor tab (the panel's
      // sections show hunks only): staged is HEAD↔index, unstaged is
      // index↔working. Content is served by OUR provider (see register()) —
      // `git:`-scheme URIs depend on the built-in git extension having
      // discovered the repo and fail with "editor could not be opened" when it
      // hasn't (e.g. an Extension Development Host).
      if (msg?.type === 'diffOpenSide') {
        const { repoPath, file, side } = msg.payload ?? {};
        if (!this.isCurrentTarget(repoPath, file)) { return; }
        const fileUri = vscode.Uri.file(path.join(String(repoPath), String(file)));
        const refUri = (ref: string) => fileUri.with({
          scheme: DiffPanel.contentScheme,
          query: JSON.stringify({ repoPath, file, ref }),
        });
        if (side === 'staged') {
          await vscode.commands.executeCommand('vscode.diff', refUri('HEAD'), refUri(''), `${file} (Staged)`);
        } else {
          await vscode.commands.executeCommand('vscode.diff', refUri(''), fileUri, `${file} (Working Tree)`);
        }
        return;
      }
      /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage. */
      if (msg?.type === 'diffStageLines') {
        const { repoPath, file, side, hunkIndex, lineIndices } = msg.payload ?? {};
        if (!this.isCurrentTarget(repoPath, file)) {
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message: STALE_TARGET } });
          return;
        }
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
          // Notify first: posting to a webview the user closed mid-op throws and
          // would otherwise swallow the notification too.
          void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
          if (this.panel === panel) {
            panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message } });
          }
        }
        return;
      }
      /* SNIPCODE-HOOK end */
      if (msg?.type !== 'diffStageHunk') { return; }
      const { repoPath, file, side, hunkIndex } = msg.payload ?? {};
      if (!this.isCurrentTarget(repoPath, file)) {
        panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message: STALE_TARGET } });
        return;
      }
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), [Number(hunkIndex)]);
        }
        // stageHunks/unstageHunks call refreshIfCurrent → re-push the new diff.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
        if (this.panel === panel) {
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message } });
        }
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
    let stagedDiff = null;
    let unstagedDiff = null;
    let fetchError: string | null = null;
    try {
      [stagedDiff, unstagedDiff] = await Promise.all([
        this.workbench.fileDiffData(repoPath, file, 'staged'),
        this.workbench.fileDiffData(repoPath, file, 'unstaged'),
      ]);
    } catch (err) {
      // Surface it: null sides + fetchError renders as an error banner, never as
      // the affirmative "No changes" empty state.
      fetchError = err instanceof Error ? err.message : String(err);
    }
    if (!this.seq.isCurrent(ticket) || !this.panel) { return; } // superseded / disposed
    this.panel.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, stagedDiff, unstagedDiff, fetchError } });
  }

  /** Serve one side of an ImageDiff. Mirrors MainPanel's getImageAtRef: 'working'
   *  reads the working tree (guarded against escaping the repo), anything else is
   *  a git ref; failure posts base64:'' so the webview shows its empty state. */
  private async sendImage(panel: vscode.WebviewPanel, ref: string, filePath: string): Promise<void> {
    // Same authority rule as the stage handlers: the webview may only ask about
    // the file this panel is showing.
    if (!this.current || this.current.file !== filePath) { return; }
    const { repoPath } = this.current;
    const ext = '.' + (filePath.split('.').pop()?.toLowerCase() ?? '');
    const mimeType = MIME_BY_EXT[ext] ?? 'image/png';
    let base64 = '';
    try {
      if (ref === 'working') {
        const fullPath = path.join(repoPath, filePath);
        const relative = path.relative(repoPath, fullPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('Invalid file path');
        }
        // Same 50MB cap GitService.getImageBase64 applies on the ref path.
        if ((await stat(fullPath)).size > 50 * 1024 * 1024) {
          throw new Error('Image too large');
        }
        base64 = (await readFile(fullPath)).toString('base64');
      } else {
        base64 = await this.workbench.imageBase64(repoPath, ref, filePath);
      }
    } catch { /* empty base64 → ImageDiff renders its missing-side state */ }
    if (this.panel === panel) {
      panel.webview.postMessage({ type: 'imageData', payload: { ref, path: filePath, base64, mimeType } });
    }
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
    this.contentProvider?.dispose();
    this.contentProvider = undefined;
    this.panel?.dispose();
    this.panel = undefined;
    this.current = undefined;
    this.ready = false;
  }
}

function getNonce(): string {
  return randomBytes(24).toString('base64');
}
