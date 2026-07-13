import * as vscode from 'vscode';
import * as path from 'path';
import { buildChangeTree, type GroupNode, type RepoNode, type FileNode, type RepoStatus } from './build-change-tree';
/* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
import { SequenceGuard } from '../utils/sequence-guard';
/* SNIPCODE-HOOK end */

export type ChangeTreeNode = GroupNode | RepoNode | FileNode;

/** Loads per-repo staged/unstaged status for the tree. Injected by the host so
 *  the provider stays free of git plumbing. */
export type LoadStatus = () => Promise<RepoStatus[]>;

/**
 * TreeDataProvider for the Snipcode Git commit workbench. Paints the IntelliJ
 * hierarchy Staged/Unstaged → repo → file. File nodes carry a `resourceUri` so
 * VS Code renders the native file-type icon and the built-in git decoration
 * colour for free; `contextValue` (`file-staged` / `file-unstaged`) drives the
 * inline +/- stage/unstage menu.
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: GroupNode[] = [];
  /* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
  private readonly refreshSequence = new SequenceGuard();
  /* SNIPCODE-HOOK end */

  constructor(
    private readonly loadStatus: LoadStatus,
    /** Whether a staged repo is checked to be included in the next commit. */
    private readonly isCheckedForCommit: (repoPath: string) => boolean = () => true,
  ) {}

  /** Re-read status and repaint the tree. */
  async refresh(): Promise<void> {
    /* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
    const ticket = this.refreshSequence.issue();
    const groups = buildChangeTree(await this.loadStatus());
    if (!this.refreshSequence.isCurrent(ticket)) return;
    this.groups = groups;
    /* SNIPCODE-HOOK end */
    this._onDidChangeTreeData.fire();
  }

  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  getStagedRepoCount(): number {
    return (this.groups.find(group => group.group === 'staged')?.repos ?? [])
      .filter(repo => this.isCheckedForCommit(repo.repoPath)).length;
  }

  notifyCommitSelectionChanged(): void {
    this._onDidChangeTreeData.fire();
  }
  /* SNIPCODE-HOOK end */

  getChildren(node?: ChangeTreeNode): ChangeTreeNode[] {
    if (!node) return this.groups;
    if (node.kind === 'group') return node.repos;
    if (node.kind === 'repo') return node.files;
    return [];
  }

  getTreeItem(node: ChangeTreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${node.count}`;
      item.contextValue = `group-${node.group}`;
      item.iconPath = new vscode.ThemeIcon(node.group === 'staged' ? 'check' : 'diff-modified');
      return item;
    }
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.Expanded);
      // IntelliJ-style incoming/outgoing badges; zero or no-upstream sides drop out.
      item.description = node.branch
        + (node.behind ? ` ↓${node.behind}` : '')
        + (node.ahead ? ` ↑${node.ahead}` : '');
      item.contextValue = `repo-${node.group}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      // Distinguish the same repo appearing under both groups.
      item.id = `${node.group}:${node.repoPath}`;
      // Staged repos get a checkbox: only checked repos are included in Commit.
      if (node.group === 'staged') {
        item.checkboxState = this.isCheckedForCommit(node.repoPath)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
      }
      return item;
    }
    // file
    const uri = vscode.Uri.file(path.join(node.repoPath, node.path));
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.description = path.dirname(node.path) === '.' ? '' : path.dirname(node.path);
    item.contextValue = `file-${node.group}`;
    item.resourceUri = uri; // native file icon + git decoration colour
    item.id = `${node.group}:${node.repoPath}:${node.path}`;
    item.command = {
      command: 'snipcode.git.showDiff',
      title: 'Show Diff',
      arguments: [node],
    };
    return item;
  }
}
