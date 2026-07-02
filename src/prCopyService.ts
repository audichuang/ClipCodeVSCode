import type { GraphCopyFile, GraphCopyPayload } from './graphCopy.js';
import type { DiffFile, RemoteStatus } from './branchDiff.js';

// Convert the selected diff files into the payload buildGraphCopyPayload
// consumes (hash fixed to 'HEAD'). Only files in selectedPaths are kept;
// a rename keeps its new path (f.path) with oldPath carried through.
export function toGraphCopyPayload(
  repoRootFsPath: string,
  diffFiles: DiffFile[],
  selectedPaths: ReadonlySet<string>
): GraphCopyPayload {
  const files: GraphCopyFile[] = diffFiles
    .filter(f => selectedPaths.has(f.path))
    .map(f => ({
      repoRootFsPath,
      relativePath: f.path,
      oldRelativePath: f.oldPath,
      status: f.status
    }));
  return { hash: 'HEAD', files };
}

// Status line shown above the PR tree (treeView.message). fetchAttempted &&
// !fetched means the fetch failed/offline — the diff below is stale local data.
export function formatBanner(status: RemoteStatus): string {
  let message: string;
  if (status.behind > 0) {
    message = `⚠ origin 有 ${status.behind} 個新 commit,建議 pull`;
  } else if (status.upstream) {
    message = `✓ 與 ${status.upstream} 同步(ahead ${status.ahead})`;
  } else {
    message = '本分支無對應 origin 分支';
  }
  if (status.fetchAttempted && !status.fetched) {
    message += '（未能連線 remote，以下為本地快取狀態）';
  }
  return message;
}
