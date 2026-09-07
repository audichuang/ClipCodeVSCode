import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
/* SNIPCODE-HOOK start: Batch D bound working-tree image reads */
import { open } from 'fs/promises';
/* SNIPCODE-HOOK end */
import { MainPanel } from './MainPanel';
/* SNIPCODE-HOOK start: stale fingerprint recovery */
import { StaleDiffError } from '../git/git-service';
/* SNIPCODE-HOOK end */
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
/* SNIPCODE-HOOK start: Batch D bound working-tree image reads */
const MAX_IMAGE_SIZE = 50 * 1024 * 1024;
/* SNIPCODE-HOOK end */

export class DiffPanel {
  static readonly viewType = 'snipcode.diffPanel';
  private static instance: DiffPanel | undefined;

  private panel: vscode.WebviewPanel | undefined;
  /** The file currently shown; drives retitle + refreshIfCurrent. Both sides
   *  (staged + unstaged) are pushed together, so this is keyed by file only. */
  /* SNIPCODE-HOOK start: Batch B image request identity */
  /* SNIPCODE-HOOK start: live-QA-2 no oldPath here — it is per-SIDE, and this
     tab renders BOTH sides of one file. A staged rename with a further edit is
     `R` (with oldPath) on the staged side and `M` (none) on the unstaged one,
     so one remembered value cannot be right for both: it used to be taken from
     whichever tree node was clicked, which rendered the staged side of a
     rename opened from Unstaged as a whole-file add. GitService resolves each
     side's rename source from git status instead — below both the display and
     the patch-builder routes, so their args still match for the fingerprint. */
  private current: { repoPath: string; file: string; generation: number } | undefined;
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */
  /** Set once the webview's listener has confirmed it's installed (`diffReady`).
   *  Guards against posting `diffShow`/`setLocale` before the listener exists,
   *  which would silently drop the message (see the `diffReady` handler below,
   *  which re-sends locale + current diff on the handshake). */
  private ready = false;
  /** Drops a late fileDiffData reply for a file the user already navigated away
   *  from (rapid clicks / post-apply refresh racing a navigation). */
  private readonly seq = new SequenceGuard();
  /* SNIPCODE-HOOK start: Batch D deduplicate image reads */
  private readonly imageResponses = new Map<string, Promise<void>>();
  /* SNIPCODE-HOOK end */

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workbench: ChangesWorkbench,
  ) {}

  /** URI scheme for the open-in-editor full-file view; content comes from our
   *  own GitService so it works without the built-in git extension. */
  static readonly contentScheme = 'snipcode-diff';
  private contentProvider: vscode.Disposable | undefined;
  /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly indexContentUris = new Map<string, vscode.Uri>();
  /* SNIPCODE-HOOK end */

  static register(extensionUri: vscode.Uri, workbench: ChangesWorkbench): DiffPanel {
    const panel = new DiffPanel(extensionUri, workbench);
    panel.contentProvider = vscode.workspace.registerTextDocumentContentProvider(DiffPanel.contentScheme, {
      /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
      onDidChange: panel.contentChanged.event,
      /* SNIPCODE-HOOK end */
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const { repoPath, file, ref } = JSON.parse(uri.query);
        /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
        if (ref === '') panel.indexContentUris.set(uri.query, uri);
        /* SNIPCODE-HOOK end */
        // Absent at the ref (e.g. a new file at HEAD) → empty side, whole file
        // reads as added.
        /* SNIPCODE-HOOK start: Batch B surface git content failures */
        return workbench.fileAtRef(String(repoPath), String(ref), String(file)).catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          if (/does not exist|exists on disk, but not in|path .* not in/i.test(message)) return '';
          throw err;
        });
        /* SNIPCODE-HOOK end */
      },
    });
    DiffPanel.instance = panel;
    return panel;
  }

  /** Open (or reveal) the panel for a file and push both sides' diffs. */
  /* SNIPCODE-HOOK start: Batch B stage operation correlation */
  /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
  /** Operation id of a correlated push that has not posted its diffShow yet.
   *  A same-target re-show (e.g. a tree click on the file already shown) that
   *  supersedes such a push must inherit this id: the webview's strict
   *  correlation drops uncorrelated diffShows while an op is in flight, so an
   *  uncorrelated superseding push would starve the op's terminal reply and
   *  leave `busy` locked. Cleared once the correlated diffShow is posted, on
   *  webview handshake (fresh page has no op gate), and on panel disposal. */
  private pendingOpId: string | undefined;
  /* SNIPCODE-HOOK end */

  show(repoPath: string, file: string, operationId?: string, reveal = true): void {
    const ticket = this.seq.issue();
    /* SNIPCODE-HOOK start: loading state only on navigation */
    // A same-file refresh (post-stage / post-error) keeps the current body
    // until the fresh diffShow lands; only real navigation clears it with a
    // loading state — otherwise every hunk stage flashes "Loading changes".
    const sameTarget = this.current?.repoPath === repoPath && this.current?.file === file;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
    const effectiveOpId = operationId ?? (sameTarget ? this.pendingOpId : undefined);
    this.pendingOpId = effectiveOpId;
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: Batch B image request identity */
    this.current = { repoPath, file, generation: ticket };
    /* SNIPCODE-HOOK end */
    if (!this.panel) { this.createPanel(); }
    /* SNIPCODE-HOOK start: D6/X2 keep the editor tab readable; the webview
       header and tooltip retain the full repo-relative path. */
    this.panel!.title = `Diff: ${path.basename(file)}`;
    /* SNIPCODE-HOOK end */
    // Navigation reveals the panel; background refreshes keep the user's
    // current editor in place.
    if (reveal) this.panel!.reveal(vscode.ViewColumn.Active, false);
    // Before the handshake lands, the webview's listener isn't installed yet and
    // this postMessage would be silently dropped; the `diffReady` handler below
    // re-pushes `this.current` once it does.
    if (this.ready) {
      /* SNIPCODE-HOOK start: Batch D clear stale body during navigation */
      if (!sameTarget) {
        this.panel!.webview.postMessage({
          type: 'diffLoading',
          payload: { repoPath, file, generation: ticket, ...(effectiveOpId ? { operationId: effectiveOpId } : {}) },
        });
      }
      /* SNIPCODE-HOOK end */
      void this.push(this.current, ticket, effectiveOpId);
    }
  }
  /* SNIPCODE-HOOK end */

  /** A stage request may only target the file this panel is itself showing — the
   *  webview holds no authority of its own, so a stale or forged repoPath/file
   *  must not reach GitService's index mutations. */
  private isCurrentTarget(repoPath: unknown, file: unknown): boolean {
    return !!this.current && this.current.repoPath === repoPath && this.current.file === file;
  }

  /** Re-render ONLY if it is still the file the user is viewing (post-apply). */
  /* SNIPCODE-HOOK start: Batch B stage operation correlation */
  refreshIfCurrent(repoPath: string, file: string, operationId?: string): void {
    if (this.panel && this.current?.repoPath === repoPath && this.current?.file === file) {
      this.show(repoPath, file, operationId, false);
    }
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
  invalidateIndexDocuments(): void {
    for (const uri of this.indexContentUris.values()) this.contentChanged.fire(uri);
  }
  /* SNIPCODE-HOOK end */

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
        /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
        // A fresh page has no op gate; a pending id from the previous page
        // would make later same-target pushes wrongly correlated.
        this.pendingOpId = undefined;
        /* SNIPCODE-HOOK end */
        /* SNIPCODE-HOOK start: Batch B image request identity */
        if (this.current) {
          const generation = this.seq.issue();
          this.current = { ...this.current, generation };
          void this.push(this.current, generation);
        }
        /* SNIPCODE-HOOK end */
        return;
      }
      // ImageDiff (inside FileDiffView) fetches both sides' bytes itself; without
      // this case an image file's sections would sit blank forever (MainPanel has
      // the equivalent handler for the graph's commit view).
      if (msg?.type === 'getImageAtRef') {
        /* SNIPCODE-HOOK start: Batch B image request identity */
        const { repoPath, generation, ref, path: filePath } = msg.payload ?? {};
        await this.sendImage(panel, String(repoPath), Number(generation), String(ref), String(filePath));
        /* SNIPCODE-HOOK end */
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
        /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
        const refUri = (ref: string) => this.contentUri(String(repoPath), String(file), ref);
        /* SNIPCODE-HOOK end */
        if (side === 'staged') {
          await vscode.commands.executeCommand('vscode.diff', refUri('HEAD'), refUri(''), `${file} (Staged)`);
        } else {
          await vscode.commands.executeCommand('vscode.diff', refUri(''), fileUri, `${file} (Working Tree)`);
        }
        return;
      }
      /* SNIPCODE-HOOK start (B-2d): line-level stage/unstage. */
      if (msg?.type === 'diffStageLines') {
        /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
        const { repoPath, file, side, hunkIndex, lineIndices, fingerprint, operationId } = msg.payload ?? {};
        /* SNIPCODE-HOOK end */
        if (!this.isCurrentTarget(repoPath, file)) {
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message: STALE_TARGET, ...(operationId === undefined ? {} : { operationId }) } });
          return;
        }
        /* SNIPCODE-HOOK start: Batch B require rendered fingerprint */
        if (typeof fingerprint !== 'string' || !fingerprint) {
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message: 'Missing diff fingerprint — refresh before staging', ...(operationId === undefined ? {} : { operationId }) } });
          return;
        }
        /* SNIPCODE-HOOK end */
        const idx = Number(hunkIndex);
        const lines = Array.isArray(lineIndices) ? lineIndices.map(Number) : [];
        try {
          if (side === 'unstaged') {
            await this.workbench.stageLines(String(repoPath), String(file), idx, lines, fingerprint, operationId === undefined ? undefined : String(operationId));
          } else {
            await this.workbench.unstageLines(String(repoPath), String(file), idx, lines, fingerprint, operationId === undefined ? undefined : String(operationId));
          }
          // stageLines/unstageLines call refreshIfCurrent → re-push the new diff.
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Notify first: posting to a webview the user closed mid-op throws and
          // would otherwise swallow the notification too.
          void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
          if (this.panel === panel) {
            panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageLines', message, ...(operationId === undefined ? {} : { operationId }) } });
            /* SNIPCODE-HOOK start: stale fingerprint recovery */
            // The webview is rendering an outdated diff — re-push the fresh one
            // (the error above already released the busy gate).
            if (err instanceof StaleDiffError) { this.refreshIfCurrent(String(repoPath), String(file)); }
            /* SNIPCODE-HOOK end */
          }
        }
        return;
      }
      /* SNIPCODE-HOOK end */
      if (msg?.type !== 'diffStageHunk') { return; }
      /* SNIPCODE-HOOK start: Batch B stale diff fingerprint */
      const { repoPath, file, side, hunkIndex, fingerprint, operationId } = msg.payload ?? {};
      if (!this.isCurrentTarget(repoPath, file)) {
        panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message: STALE_TARGET, ...(operationId === undefined ? {} : { operationId }) } });
        return;
      }
      if (typeof fingerprint !== 'string' || !fingerprint) {
        panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message: 'Missing diff fingerprint — refresh before staging', ...(operationId === undefined ? {} : { operationId }) } });
        return;
      }
      try {
        if (side === 'unstaged') {
          await this.workbench.stageHunks(String(repoPath), String(file), [Number(hunkIndex)], fingerprint, operationId === undefined ? undefined : String(operationId));
        } else {
          await this.workbench.unstageHunks(String(repoPath), String(file), [Number(hunkIndex)], fingerprint, operationId === undefined ? undefined : String(operationId));
        }
        // stageHunks/unstageHunks call refreshIfCurrent → re-push the new diff.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`Stage/Unstage 失敗：${message}`);
        if (this.panel === panel) {
          panel.webview.postMessage({ type: 'error', payload: { source: 'diffStageHunk', message, ...(operationId === undefined ? {} : { operationId }) } });
          /* SNIPCODE-HOOK start: stale fingerprint recovery */
          if (err instanceof StaleDiffError) { this.refreshIfCurrent(String(repoPath), String(file)); }
          /* SNIPCODE-HOOK end */
        }
      }
      /* SNIPCODE-HOOK end */
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
      this.current = undefined;
      this.ready = false;
      /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
      this.pendingOpId = undefined;
      /* SNIPCODE-HOOK end */
    });
    this.panel = panel;
  }

  private async push(
    /* SNIPCODE-HOOK start: Batch B image request identity */
    target: { repoPath: string; file: string; generation: number },
    /* SNIPCODE-HOOK end */
    ticket: number,
    /* SNIPCODE-HOOK start: Batch B stage operation correlation */
    operationId?: string,
    /* SNIPCODE-HOOK end */
  ): Promise<void> {
    if (!this.panel) { return; }
    /* SNIPCODE-HOOK start: Batch B image request identity */
    const { repoPath, file, generation } = target;
    /* SNIPCODE-HOOK end */
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
    /* SNIPCODE-HOOK start: Batch B stage operation correlation */
    this.panel.webview.postMessage({ type: 'diffShow', payload: { repoPath, file, generation, stagedDiff, unstagedDiff, fetchError, ...(operationId ? { operationId } : {}) } });
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: inherit pending op-id on same-target re-show */
    // The op's terminal reply is out; a LATER same-target show must not
    // resurrect the id (the webview would drop it as a stale correlation).
    if (operationId !== undefined && this.pendingOpId === operationId) { this.pendingOpId = undefined; }
    /* SNIPCODE-HOOK end */
  }

  /** Serve one side of an ImageDiff. Mirrors MainPanel's getImageAtRef: 'working'
   *  reads the working tree (guarded against escaping the repo), anything else is
   *  a git ref; failure posts base64:'' so the webview shows its empty state. */
  /* SNIPCODE-HOOK start: Batch B image request identity */
  private async sendImage(panel: vscode.WebviewPanel, repoPath: string, generation: number, ref: string, filePath: string): Promise<void> {
    // Same authority rule as the stage handlers: the webview may only ask about
    // the file this panel is showing.
    if (!this.current || this.current.repoPath !== repoPath
      || this.current.file !== filePath || this.current.generation !== generation) { return; }
    /* SNIPCODE-HOOK start: Batch D deduplicate image reads */
    const readKey = `${repoPath}\0${generation}\0${ref}\0${filePath}`;
    let pending = this.imageResponses.get(readKey);
    if (!pending) {
      pending = this.postImage(panel, repoPath, generation, ref, filePath);
      this.imageResponses.set(readKey, pending);
      const clear = () => {
        if (this.imageResponses.get(readKey) === pending) this.imageResponses.delete(readKey);
      };
      void pending.then(clear, clear);
    }
    await pending;
    /* SNIPCODE-HOOK end */
  }

  /* SNIPCODE-HOOK start: Batch D deduplicate image reads */
  private async postImage(panel: vscode.WebviewPanel, repoPath: string, generation: number, ref: string, filePath: string): Promise<void> {
    const ext = '.' + (filePath.split('.').pop()?.toLowerCase() ?? '');
    const mimeType = MIME_BY_EXT[ext] ?? 'image/png';
    let base64 = '';
    try {
      base64 = await this.readImageBase64(repoPath, ref, filePath);
    } catch { /* empty base64 → ImageDiff renders its missing-side state */ }
    if (this.panel === panel && this.current?.repoPath === repoPath
      && this.current.file === filePath && this.current.generation === generation) {
      panel.webview.postMessage({ type: 'imageData', payload: { repoPath, generation, ref, path: filePath, base64, mimeType } });
    }
  }
  /* SNIPCODE-HOOK end */
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: Batch D deduplicate image reads */
  private async readImageBase64(repoPath: string, ref: string, filePath: string): Promise<string> {
    if (ref !== 'working') return this.workbench.imageBase64(repoPath, ref, filePath);
    const fullPath = path.join(repoPath, filePath);
    const relative = path.relative(repoPath, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid file path');
    /* SNIPCODE-HOOK start: Batch D bound working-tree image reads */
    const handle = await open(fullPath, 'r');
    try {
      const readLimit = MAX_IMAGE_SIZE + 1;
      let buffer = Buffer.allocUnsafe(Math.min(64 * 1024, readLimit));
      let offset = 0;
      while (offset < readLimit) {
        if (offset === buffer.length) {
          const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, readLimit));
          buffer.copy(grown, 0, 0, offset);
          buffer = grown;
        }
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > MAX_IMAGE_SIZE) throw new Error('Image too large');
      return buffer.subarray(0, offset).toString('base64');
    } finally {
      await handle.close();
    }
    /* SNIPCODE-HOOK end */
  }
  /* SNIPCODE-HOOK end */

  private postLocale(panel: vscode.WebviewPanel): void {
    const setting = vscode.workspace.getConfiguration('gitGraphPlus').get<string>('locale', 'auto');
    const locale = setting === 'auto' ? (vscode.env.language || 'en') : setting;
    panel.webview.postMessage({ type: 'setLocale', payload: { locale } });
  }

  /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
  private contentUri(repoPath: string, file: string, ref: string): vscode.Uri {
    const uri = vscode.Uri.file(path.join(repoPath, file)).with({
      scheme: DiffPanel.contentScheme,
      query: JSON.stringify({ repoPath, file, ref }),
    });
    if (ref === '') this.indexContentUris.set(uri.query, uri);
    return uri;
  }
  /* SNIPCODE-HOOK end */

  private getHtml(webview: vscode.Webview, assetRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'diff.css'));
    const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'codicon.css'));
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <!-- SNIPCODE-HOOK start: perf — 'wasm-unsafe-eval' lets the Diff webview compile
       Shiki's oniguruma WASM engine (3.6x faster tokenising than the pure-JS
       regex fallback). Verified refused
       without it: WebAssembly.CompileError, "violates the following Content
       Security policy directive". NOT added to
       commit-box-view.ts / recent-commits-view.ts — workbench.js carries no
       Shiki, so those views keep the stricter policy. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
  <!-- SNIPCODE-HOOK end -->
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
    /* SNIPCODE-HOOK start: Batch D invalidate index virtual documents */
    this.contentChanged.dispose();
    this.indexContentUris.clear();
    /* SNIPCODE-HOOK end */
    this.panel?.dispose();
    this.panel = undefined;
    this.current = undefined;
    this.ready = false;
    /* SNIPCODE-HOOK start: Batch D deduplicate image reads */
    this.imageResponses.clear();
    /* SNIPCODE-HOOK end */
  }
}

function getNonce(): string {
  return randomBytes(24).toString('base64');
}
