import * as vscode from 'vscode';
import { type HistoryCommit, type HistoryRepo, listCommitFiles, listCommits } from './gitHistory.js';
import { buildCommitFileTree, collectFileNodes, type FileNode, type TreeNode } from './historyTree.js';

const PAGE_SIZE = 50;

export interface CommitNode { kind: 'commit'; commit: HistoryCommit; contextValue: 'commit'; }
export interface FolderViewNode { kind: 'folder'; node: TreeNode; commit: HistoryCommit; contextValue: 'folder'; }
export interface FileViewNode { kind: 'file'; node: FileNode; contextValue: 'file'; }
export interface LoadMoreNode { kind: 'loadMore'; contextValue: 'loadMore'; }
export interface MessageNode { kind: 'message'; text: string; contextValue: 'loading' | 'error' | 'empty'; }
export type HistoryNode = CommitNode | FolderViewNode | FileViewNode | LoadMoreNode | MessageNode;

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private repo_: HistoryRepo | undefined;
  private commits: HistoryCommit[] = [];
  private hasMore = false;
  private hasLoadedCommits = false;
  private generation = 0;
  private readonly fileCache = new Map<string, TreeNode[]>(); // key = commit.hash

  get repo(): HistoryRepo | undefined { return this.repo_; }

  setRepo(repo: HistoryRepo | undefined): void {
    this.repo_ = repo;
    this.commits = [];
    this.hasMore = false;
    this.hasLoadedCommits = false;
    this.generation++;
    this.fileCache.clear();
    this.refresh();
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  async loadMore(): Promise<void> {
    const repo = this.repo_;
    if (!repo) return;
    const gen = this.generation;
    const page = await listCommits(repo, { limit: PAGE_SIZE, skip: this.commits.length });
    if (gen !== this.generation) return; // repo switched mid-await; discard stale page
    this.commits.push(...page);
    this.hasMore = page.length === PAGE_SIZE;
    this.hasLoadedCommits = true;
    this.refresh();
  }

  private async ensureCommitFilesLoaded(commit: HistoryCommit): Promise<TreeNode[]> {
    const cached = this.fileCache.get(commit.hash);
    if (cached) return cached;
    const repo = this.repo_;
    if (!repo) return [];
    const gen = this.generation;
    const changes = await listCommitFiles(repo, commit);
    const tree = buildCommitFileTree(repo.rootUri.fsPath, commit, changes);
    if (gen === this.generation) this.fileCache.set(commit.hash, tree); // skip cache write if repo switched
    return tree;
  }

  async getFilesForNode(node: HistoryNode): Promise<FileNode[]> {
    if (node.kind === 'file') return [node.node];
    if (node.kind === 'folder') return collectFileNodes(node.node);
    if (node.kind === 'commit') {
      const tree = await this.ensureCommitFilesLoaded(node.commit);
      return tree.flatMap(collectFileNodes);
    }
    return [];
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    switch (node.kind) {
      case 'commit': {
        const item = new vscode.TreeItem(firstLine(node.commit.message), vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.commit.hash.slice(0, 7);
        item.tooltip = `${node.commit.hash}\n${node.commit.authorName ?? ''}\n${node.commit.commitDate?.toISOString() ?? ''}`;
        item.contextValue = 'commit';
        item.iconPath = new vscode.ThemeIcon('git-commit');
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem((node.node as any).name, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = 'folder';
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case 'file': {
        const f = node.node;
        const item = new vscode.TreeItem(`[${f.changeType}] ${f.name}`, vscode.TreeItemCollapsibleState.None);
        item.description = f.relPath;
        item.resourceUri = vscode.Uri.file(f.change.uri.fsPath);
        item.contextValue = 'file';
        return item;
      }
      case 'loadMore': {
        const item = new vscode.TreeItem('Load More…', vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'clipcode.history.loadMore', title: 'Load More' };
        item.contextValue = 'loadMore';
        item.iconPath = new vscode.ThemeIcon('ellipsis');
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = node.contextValue;
        return item;
      }
    }
  }

  async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
    if (!this.repo_) return [{ kind: 'message', text: 'No Git repository.', contextValue: 'empty' }];

    if (!node) {
      if (!this.hasLoadedCommits) await this.loadMore();
      const top: HistoryNode[] = this.commits.map(commit => ({ kind: 'commit', commit, contextValue: 'commit' }));
      if (this.hasMore) top.push({ kind: 'loadMore', contextValue: 'loadMore' });
      if (top.length === 0) return [{ kind: 'message', text: 'No commits.', contextValue: 'empty' }];
      return top;
    }

    if (node.kind === 'commit') {
      try {
        const tree = await this.ensureCommitFilesLoaded(node.commit);
        if (tree.length === 0) return [{ kind: 'message', text: 'No changed files.', contextValue: 'empty' }];
        return tree.map(child => toViewNode(child, node.commit));
      } catch {
        return [{ kind: 'message', text: 'Failed to load changes.', contextValue: 'error' }];
      }
    }

    if (node.kind === 'folder') {
      return (node.node as any).children.map((child: TreeNode) => toViewNode(child, node.commit));
    }

    return [];
  }
}

function toViewNode(node: TreeNode, commit: HistoryCommit): HistoryNode {
  return node.kind === 'folder'
    ? { kind: 'folder', node, commit, contextValue: 'folder' }
    : { kind: 'file', node, contextValue: 'file' };
}

function firstLine(message: string): string { return message.split('\n')[0]; }
