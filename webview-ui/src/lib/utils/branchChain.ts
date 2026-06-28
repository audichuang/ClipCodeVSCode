import type { Commit } from '../types';

/**
 * Given the head (newest) commit of a contiguous first-parent chain, return the
 * names of local branches whose first-parent history reaches that head.
 *
 * Walks `parents[0]` from each branch tip through `commitsByHash`. Limited to
 * loaded commits — a tip or head outside the loaded range yields no match for
 * that branch, consistent with the graph's other client-side derivations.
 */
export function chainBranches(
  chainHeadHash: string,
  commitsByHash: Map<string, Commit>,
  localBranchTips: Array<{ name: string; hash: string }>,
): string[] {
  const result: string[] = [];
  for (const branch of localBranchTips) {
    let current: string | undefined = branch.hash;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === chainHeadHash) {
        result.push(branch.name);
        break;
      }
      seen.add(current);
      const commit = commitsByHash.get(current);
      if (!commit) break;
      current = commit.parents[0];
    }
  }
  return result;
}
