import type { ChangeTypeLabel } from './clipboardFormat.js';
import { mapGitStatusToChangeType } from './gitCopy.js';
import type { HistoryChange, HistoryCommit } from './gitHistory.js';

export interface FileNode {
  kind: 'file';
  repoRoot: string;
  commit: HistoryCommit;
  change: HistoryChange;
  relPath: string;
  name: string;
  changeType: ChangeTypeLabel;
}
export interface FolderNode {
  kind: 'folder';
  name: string;
  children: TreeNode[];
}
export type TreeNode = FolderNode | FileNode;

function relativeOf(repoRoot: string, change: HistoryChange): string {
  const abs = (change.renameUri ?? change.uri).fsPath.replaceAll('\\', '/');
  const root = repoRoot.replaceAll('\\', '/');
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs;
}

export function buildCommitFileTree(repoRoot: string, commit: HistoryCommit, changes: HistoryChange[]): TreeNode[] {
  const root: FolderNode = { kind: 'folder', name: '', children: [] };

  for (const change of changes) {
    const relPath = relativeOf(repoRoot, change);
    const segments = relPath.split('/');
    const fileName = segments.pop() as string;
    let cursor = root;
    for (const seg of segments) {
      let next = cursor.children.find((c): c is FolderNode => c.kind === 'folder' && c.name === seg);
      if (!next) {
        next = { kind: 'folder', name: seg, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    cursor.children.push({
      kind: 'file', repoRoot, commit, change, relPath, name: fileName,
      changeType: mapGitStatusToChangeType(change.status),
    });
  }

  return root.children.map(compress);
}

// 單鏈壓縮:資料夾只有單一子資料夾、且自己沒有直接檔案 → 合併名稱
function compress(node: TreeNode): TreeNode {
  if (node.kind === 'file') return node;
  let folder = node;
  while (folder.children.length === 1 && folder.children[0].kind === 'folder') {
    const child = folder.children[0] as FolderNode;
    folder = { kind: 'folder', name: `${folder.name}/${child.name}`, children: child.children };
  }
  return { kind: 'folder', name: folder.name, children: folder.children.map(compress) };
}

export function collectFileNodes(node: TreeNode): FileNode[] {
  if (node.kind === 'file') return [node];
  return node.children.flatMap(collectFileNodes);
}

export function dedupeFilesKeepNewest(files: FileNode[]): FileNode[] {
  const byPath = new Map<string, FileNode>();
  for (const file of files) {
    const existing = byPath.get(file.relPath);
    if (!existing) { byPath.set(file.relPath, file); continue; }
    // 兩者都有日期才比較,擇新者;否則保留先見到的(清單較前)
    const a = file.commit.commitDate?.getTime();
    const b = existing.commit.commitDate?.getTime();
    if (a !== undefined && b !== undefined && a > b) byPath.set(file.relPath, file);
  }
  return [...byPath.values()];
}

export function resolveSourceNodes<T>(clicked: T | undefined, selected: T[] | undefined, treeSelection: readonly T[]): T[] {
  if (selected && clicked !== undefined && selected.includes(clicked)) return selected;
  if (clicked !== undefined) return [clicked];
  return [...treeSelection];
}
