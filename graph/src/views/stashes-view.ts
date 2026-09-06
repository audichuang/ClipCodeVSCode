import * as vscode from 'vscode';
import { GitService } from '../git/git-service';
import type { StashEntry } from '../git/types';

export class StashesViewProvider implements vscode.TreeDataProvider<StashItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StashItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache: StashItem[] | null = null;
  private pending: Promise<void> | null = null;

  constructor(private gitService: GitService) {}

  public setGitService(gitService: GitService): void {
    this.gitService = gitService;
    this.cache = null;
    this.refresh();
  }

  private fetchId = 0;

  refresh(): Promise<void> { this.pending = this.doFetch(); return this.pending; }

  prefetch(): Promise<void> {
    if (!this.pending) this.pending = this.doFetch();
    return this.pending;
  }

  private async doFetch(): Promise<void> {
    const id = ++this.fetchId;
    try { this.cache = (await this.gitService.stashList()).map(s => new StashItem(s)); }
    catch { /* keep old cache */ }
    if (id === this.fetchId) { this.pending = null; this._onDidChangeTreeData.fire(); }
  }

  dispose(): void { this._onDidChangeTreeData.dispose(); }

  getTreeItem(element: StashItem): vscode.TreeItem { return element; }

  async getChildren(element?: StashItem): Promise<StashItem[]> {
    if (element) return [];
    if (this.cache) return this.cache;
    try { this.cache = (await this.gitService.stashList()).map(s => new StashItem(s)); }
    catch { /* ignore */ }
    return this.cache ?? [];
  }
}

class StashItem extends vscode.TreeItem {
  constructor(public readonly stash: StashEntry) {
    /* SNIPCODE-HOOK start: S P2 the message is the primary label, stash@{n} is secondary
     * With no message, stash@{n} IS the label — putting it in `description` too
     * would duplicate it right next to itself, so description stays empty then. */
    super(stash.message || `stash@{${stash.index}}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'stash';
    this.iconPath = new vscode.ThemeIcon('archive');
    this.description = stash.message ? `stash@{${stash.index}}` : '';
    /* SNIPCODE-HOOK end */
    this.tooltip = `${stash.message}\n${stash.date}`;

    this.command = {
      command: 'gitGraphPlus.showStashMenu',
      title: 'Show Stash Menu',
      arguments: [{ stash: this.stash, index: this.stash.index }],
    };
  }
}
