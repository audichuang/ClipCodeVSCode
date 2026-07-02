import type { GraphCopyFile, GraphCopyPayload } from './graphCopy.js';
import type { DiffFile } from './branchDiff.js';

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
