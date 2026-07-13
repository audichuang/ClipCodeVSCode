import * as vscode from 'vscode';
import * as path from 'node:path';
import { runBlame, defaultSpawnBlame } from './blameRunner.js';
import { BlameCache, blameCacheKey } from './blameCache.js';
import { GenerationGate } from './blameGeneration.js';
import { formatRelativeTime, ageBucket, AGE_BUCKETS } from './blameFormat.js';
import type { BlameLine } from './blameParser.js';

const MAX_LINES = 20_000;
// Coalesce the burst of onDidChangeTextDocument events fired per keystroke
// into a single render, instead of spawning `git blame` on every character.
const DOC_CHANGE_DEBOUNCE_MS = 300;
const AGE_BUCKET_COLOR_IDS = [
  'editorLineNumber.activeForeground',
  'charts.blue',
  'charts.green',
  'charts.yellow',
  'editorLineNumber.foreground',
] as const;

export interface BlameDeps {
  getGitPath: () => string;
  resolveRepoRoot: (uri: vscode.Uri) => { repoRoot: string; head: string } | undefined;
}

// Per-editor toggle key: document URI is not enough because the same
// document opened in a left/right split view shares one URI — bundling
// viewColumn in makes each pane's blame toggle independent of the other.
function tabKey(docUri: string, viewColumn: number | undefined): string {
  return `${docUri}::${viewColumn ?? 'none'}`;
}

function editorKey(editor: vscode.TextEditor): string {
  return tabKey(editor.document.uri.toString(), editor.viewColumn);
}

export class BlameController {
  private readonly enabled = new Set<string>(); // editor keys (doc URI + viewColumn)
  // Bumped for every render and enable/disable transition so an in-flight
  // request can detect any newer request or lifecycle change for its editor.
  private readonly gate = new GenerationGate();
  private readonly cache = new BlameCache();
  private readonly types: vscode.TextEditorDecorationType[] = [];
  private readonly docChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: BlameDeps) {
    for (let i = 0; i < AGE_BUCKETS; i++) {
      // Newest bucket brightest; older buckets fade toward a muted colour.
      this.types.push(vscode.window.createTextEditorDecorationType({
        before: {
          margin: '0 1.5em 0 0',
          color: new vscode.ThemeColor(AGE_BUCKET_COLOR_IDS[i])
        }
      }));
    }
  }

  dispose(): void {
    // Clear enabled first: an in-flight render that rejects after this point
    // fails the isRenderCurrent check instead of touching disposed types.
    this.enabled.clear();
    for (const t of this.types) t.dispose();
    for (const timer of this.docChangeTimers.values()) clearTimeout(timer);
    this.docChangeTimers.clear();
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.cache.clear();
  }

  async toggle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const key = editorKey(editor);
    if (this.enabled.has(key)) {
      // Invalidate any render already in flight for this editor so it can't
      // resurrect decorations after we clear them below.
      this.resetEditor(key);
      this.clearDecorations(editor);
    } else {
      if (editor.document.lineCount > MAX_LINES) {
        void vscode.window.showInformationMessage('檔案過大，暫不標註');
        return;
      }
      this.enabled.add(key);
      this.gate.bump(key);
      await this.render(editor);
    }
  }

  async onActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (editor && this.enabled.has(editorKey(editor))) {
      await this.render(editor);
    }
  }

  // A CLOSED TAB — not mere invisibility — is what invalidates an editor's
  // toggle: switching tabs keeps blame enabled (the editor re-renders on
  // activation), while close + reopen of the same URI/viewColumn must start
  // clean instead of inheriting the previous tab's enabled/generation state.
  // The document may stay open elsewhere (split, other group), so this fires
  // even when onCloseDocument doesn't.
  //
  // `uriStillOpen` = some tab (any column) still shows this URI. When the LAST
  // tab goes, sweep every per-column key: the tab event's column cannot
  // address keys recorded as '::none' (TextEditor.viewColumn is undefined
  // beyond column three) or keys stranded by an earlier group renumbering.
  // Known ceiling: a stale key for a STILL-open URI (renumber, >3 columns)
  // survives until the document closes; migrate keys via
  // window.onDidChangeTextEditorViewColumn if this ever matters in practice.
  onTabClosed(docUri: string, viewColumn: number | undefined, uriStillOpen = true): void {
    this.resetEditor(tabKey(docUri, viewColumn));
    if (uriStillOpen) return;
    const prefix = `${docUri}::`;
    for (const key of this.enabled) {
      if (key.startsWith(prefix)) this.resetEditor(key);
    }
  }

  onCloseDocument(doc: vscode.TextDocument): void {
    const docKey = doc.uri.toString();
    const editorKeyPrefix = `${docKey}::`;
    for (const key of this.enabled) {
      if (!key.startsWith(editorKeyPrefix)) continue;
      this.resetEditor(key);
    }
    const timer = this.docChangeTimers.get(docKey);
    if (timer) clearTimeout(timer);
    this.docChangeTimers.delete(docKey);
    this.cache.deleteForDoc(docKey);
  }

  async onRepoChange(repoRoot: vscode.Uri): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!this.enabled.has(editorKey(editor))) continue;
      if (this.deps.resolveRepoRoot(editor.document.uri)?.repoRoot !== repoRoot.fsPath) continue;
      await this.render(editor);
    }
  }

  async onGitReady(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.enabled.has(editorKey(editor))) await this.render(editor);
    }
  }

  // Debounced: fires on every keystroke via onDidChangeTextDocument, so we
  // coalesce bursts into one render ~DOC_CHANGE_DEBOUNCE_MS after the last one.
  async onDocChange(doc: vscode.TextDocument): Promise<void> {
    const key = doc.uri.toString();
    const existing = this.docChangeTimers.get(key);
    if (existing) clearTimeout(existing);
    this.docChangeTimers.set(key, setTimeout(() => {
      this.docChangeTimers.delete(key);
      void this.renderIfEnabled(doc);
    }, DOC_CHANGE_DEBOUNCE_MS));
  }

  private async renderIfEnabled(doc: vscode.TextDocument): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document !== doc || !this.enabled.has(editorKey(editor))) continue;
      await this.render(editor);
    }
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    for (const t of this.types) editor.setDecorations(t, []);
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    // Snapshot this editor's toggle identity before the first await — used
    // below to detect a disable (or a pane's viewColumn changing) that
    // happened while blame data was being fetched.
    const key = editorKey(editor);
    if (editor.document.lineCount > MAX_LINES) {
      this.gate.bump(key);
      this.cancelRender(key);
      this.clearDecorations(editor);
      return;
    }
    const generation = this.gate.bump(key);
    // The bump above already made any in-flight request stale; kill its
    // process too (a cache hit below would otherwise let it run to waste).
    this.cancelRender(key);
    const doc = editor.document;
    const docVersion = doc.version;
    const info = this.deps.resolveRepoRoot(doc.uri);
    if (!info) return;
    const cacheKey = blameCacheKey(info.repoRoot, info.head, doc.version, doc.uri.fsPath);
    let lines = this.cache.get(cacheKey);
    if (!lines) {
      const abort = new AbortController();
      this.inFlight.set(key, abort);
      try {
        lines = await runBlame({
          gitPath: this.deps.getGitPath(),
          repoRoot: info.repoRoot,
          // Relative to the same repoRoot passed as `git -C`, not the
          // workspace folder — they differ whenever the repo root is a
          // subfolder of (or sibling to) the workspace folder.
          relPath: path.relative(info.repoRoot, doc.uri.fsPath),
          contents: doc.getText(),
          spawnBlame: defaultSpawnBlame,
          signal: abort.signal
        });
      } catch {
        if (this.isRenderCurrent(editor, doc, docVersion, key, generation)) {
          this.clearDecorations(editor); // silent on failure
        }
        return;
      } finally {
        if (this.inFlight.get(key) === abort) this.inFlight.delete(key);
      }
    }
    // Editor/doc may have changed while awaiting, or the user may have
    // toggled blame off (and possibly back on) for this editor in the
    // meantime — any of those makes this render stale, so skip it instead of
    // resurrecting decorations the user already turned off.
    if (!this.isRenderCurrent(editor, doc, docVersion, key, generation)) return;
    this.cache.setForDoc(doc.uri.toString(), cacheKey, lines);
    this.applyDecorations(editor, lines);
  }

  private cancelRender(key: string): void {
    this.inFlight.get(key)?.abort();
    this.inFlight.delete(key);
  }

  private resetEditor(key: string): void {
    this.enabled.delete(key);
    this.gate.bump(key);
    this.cancelRender(key);
  }

  private isRenderCurrent(
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    docVersion: number,
    key: string,
    generation: number
  ): boolean {
    return vscode.window.visibleTextEditors.includes(editor) &&
      editor.document === doc &&
      editor.document.version === docVersion &&
      editorKey(editor) === key &&
      this.enabled.has(key) &&
      this.gate.isCurrent(key, generation);
  }

  private applyDecorations(editor: vscode.TextEditor, lines: BlameLine[]): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const buckets: vscode.DecorationOptions[][] = this.types.map(() => []);
    for (const line of lines) {
      const zeroIdx = line.finalLine - 1;
      if (zeroIdx < 0 || zeroIdx >= editor.document.lineCount) continue;
      const c = line.commit;
      const label = c.isUncommitted
        ? '你 · 未提交'
        : `${c.author} · ${formatRelativeTime(c.authorTime, nowSec)}`;
      const bucket = c.isUncommitted ? 0 : ageBucket(c.authorTime, nowSec);
      const hover = new vscode.MarkdownString();
      hover.isTrusted = { enabledCommands: ['clipcode.blame.revealCommit'] };
      if (c.isUncommitted) {
        hover.appendMarkdown('尚未提交');
      } else {
        const args = encodeURIComponent(JSON.stringify([c.sha]));
        hover.appendMarkdown(`**${c.sha.slice(0, 8)}** · ${c.author}\n\n${c.summary}\n\n[在 Graph 開啟此 commit](command:clipcode.blame.revealCommit?${args})`);
      }
      const range = new vscode.Range(zeroIdx, 0, zeroIdx, 0);
      buckets[bucket].push({
        range,
        hoverMessage: hover,
        renderOptions: { before: { contentText: label } }
      });
    }
    this.types.forEach((t, i) => editor.setDecorations(t, buckets[i]));
  }
}
