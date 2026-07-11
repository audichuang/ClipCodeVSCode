import * as vscode from 'vscode';
import * as path from 'node:path';
import { runBlame, defaultSpawnBlame } from './blameRunner.js';
import { BlameCache, blameCacheKey } from './blameCache.js';
import { formatRelativeTime, ageBucket, AGE_BUCKETS } from './blameFormat.js';
import type { BlameLine } from './blameParser.js';

const MAX_LINES = 20_000;
// Coalesce the burst of onDidChangeTextDocument events fired per keystroke
// into a single render, instead of spawning `git blame` on every character.
const DOC_CHANGE_DEBOUNCE_MS = 300;

export interface BlameDeps {
  getGitPath: () => string;
  resolveRepoRoot: (uri: vscode.Uri) => { repoRoot: string; head: string } | undefined;
}

export class BlameController {
  private readonly enabled = new Set<string>(); // document URI strings
  private readonly cache = new BlameCache();
  private readonly types: vscode.TextEditorDecorationType[] = [];
  private readonly docChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: BlameDeps) {
    for (let i = 0; i < AGE_BUCKETS; i++) {
      // Newest bucket brightest; older buckets fade toward a muted colour.
      this.types.push(vscode.window.createTextEditorDecorationType({
        before: {
          margin: '0 1.5em 0 0',
          color: new vscode.ThemeColor(
            i === 0 ? 'editorLineNumber.activeForeground' : 'editorLineNumber.foreground'
          )
        }
      }));
    }
  }

  dispose(): void {
    for (const t of this.types) t.dispose();
    for (const timer of this.docChangeTimers.values()) clearTimeout(timer);
    this.docChangeTimers.clear();
    this.cache.clear();
  }

  async toggle(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const key = editor.document.uri.toString();
    if (this.enabled.has(key)) {
      this.enabled.delete(key);
      this.clearDecorations(editor);
    } else {
      if (editor.document.lineCount > MAX_LINES) {
        void vscode.window.showInformationMessage('檔案過大，暫不標註');
        return;
      }
      this.enabled.add(key);
      await this.render(editor);
    }
  }

  async onActiveEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (editor && this.enabled.has(editor.document.uri.toString())) {
      await this.render(editor);
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
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === doc && this.enabled.has(doc.uri.toString())) {
      await this.render(editor);
    }
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    for (const t of this.types) editor.setDecorations(t, []);
  }

  private async render(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    const info = this.deps.resolveRepoRoot(doc.uri);
    if (!info) return;
    const cacheKey = blameCacheKey(info.repoRoot, info.head, doc.version);
    let lines = this.cache.get(cacheKey);
    if (!lines) {
      try {
        lines = await runBlame({
          gitPath: this.deps.getGitPath(),
          repoRoot: info.repoRoot,
          // Relative to the same repoRoot passed as `git -C`, not the
          // workspace folder — they differ whenever the repo root is a
          // subfolder of (or sibling to) the workspace folder.
          relPath: path.relative(info.repoRoot, doc.uri.fsPath),
          contents: doc.getText(),
          spawnBlame: defaultSpawnBlame
        });
        this.cache.setForDoc(doc.uri.toString(), cacheKey, lines);
      } catch {
        this.clearDecorations(editor); // silent on failure
        return;
      }
    }
    // Editor may have changed while awaiting.
    if (vscode.window.activeTextEditor !== editor || doc.version !== editor.document.version) return;
    this.applyDecorations(editor, lines);
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
      hover.isTrusted = true;
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
