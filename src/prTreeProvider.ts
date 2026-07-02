import * as vscode from 'vscode';
import type { ChangeTypeLabel } from './clipboardFormat.js';
import type { DiffFile } from './branchDiff.js';
import { mapGitStatusToChangeType } from './gitCopy.js';

export interface PrFileNode {
  kind: 'file';
  relPath: string;
  changeType: ChangeTypeLabel;
  checkboxState: vscode.TreeItemCheckboxState;
}
export interface PrFolderNode {
  kind: 'folder';
  name: string;
  children: PrTreeNode[];
}
export type PrTreeNode = PrFolderNode | PrFileNode;
export interface PrMessageNode { kind: 'message'; text: string; }
export type PrNode = PrTreeNode | PrMessageNode;

function buildTree(files: DiffFile[], checked: ReadonlySet<string>): PrTreeNode[] {
  const root: PrFolderNode = { kind: 'folder', name: '', children: [] };
  for (const f of files) {
    const segments = f.path.split('/');
    segments.pop(); // drop the filename — only folder segments build the walk below
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.children.find((c): c is PrFolderNode => c.kind === 'folder' && c.name === seg);
      if (!next) {
        next = { kind: 'folder', name: seg, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      kind: 'file',
      relPath: f.path,
      changeType: mapGitStatusToChangeType(f.status),
      checkboxState: checked.has(f.path) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked
    });
  }
  return root.children.map(compress);
}

// 單鏈壓縮:資料夾只有單一子資料夾 → 合併名稱(clone historyTree.ts 的 compress 概念)
function compress(node: PrTreeNode): PrTreeNode {
  if (node.kind === 'file') return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === 'folder') {
    const child = folder.children[0] as PrFolderNode;
    folder = { kind: 'folder', name: `${folder.name}/${child.name}`, children: child.children };
  }
  return { kind: 'folder', name: folder.name, children: folder.children.map(compress) };
}

export function collectPrFileNodes(node: PrTreeNode): PrFileNode[] {
  if (node.kind === 'file') return [node];
  return node.children.flatMap(collectPrFileNodes);
}

export class PrTreeProvider implements vscode.TreeDataProvider<PrNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<PrNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  dispose(): void { this._onDidChangeTreeData.dispose(); }

  private files: DiffFile[] = [];
  private checked = new Set<string>();
  private tree: PrTreeNode[] = [];
  private loaded = false;

  getFiles(): DiffFile[] { return this.files; }
  getCheckedPaths(): ReadonlySet<string> { return this.checked; }

  // Replace the diff and check every file by default (per Global Constraints /
  // Task V3 spec: reload() calls this after a successful diff load, all-checked).
  setFiles(files: DiffFile[]): void {
    this.files = files;
    this.checked = new Set(files.map(f => f.path));
    this.loaded = true;
    this.rebuild();
  }

  // Back to the "no base selected yet" empty state (repo switch / cleared repo).
  reset(): void {
    this.files = [];
    this.checked = new Set();
    this.loaded = false;
    this.rebuild();
  }

  setChecked(node: PrFileNode, state: vscode.TreeItemCheckboxState): void {
    if (state === vscode.TreeItemCheckboxState.Checked) this.checked.add(node.relPath);
    else this.checked.delete(node.relPath);
    this.rebuild();
  }

  private rebuild(): void {
    this.tree = buildTree(this.files, this.checked);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: PrNode): vscode.TreeItem {
    if (node.kind === 'message') {
      return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    }
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'prFolder';
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const name = node.relPath.split('/').pop() ?? node.relPath;
    const item = new vscode.TreeItem(`[${node.changeType}] ${name}`, vscode.TreeItemCollapsibleState.None);
    item.description = node.relPath;
    item.contextValue = 'prFile';
    item.checkboxState = node.checkboxState;
    return item;
  }

  getChildren(node?: PrNode): PrNode[] {
    if (!node) {
      if (!this.loaded) return [{ kind: 'message', text: 'Select a base branch to compare (⋯ menu).' }];
      if (this.tree.length === 0) return [{ kind: 'message', text: 'No changes against base.' }];
      return this.tree;
    }
    if (node.kind === 'folder') return node.children;
    return [];
  }
}
