import type { Commit } from '../types';

export interface SquashTodo {
  action: 'pick' | 'fixup';
  hash: string;
  subject: string;
  message?: string;
}

/**
 * Validate a multi-commit selection for squashing and, if valid, return the
 * commits ordered oldest→newest. Returns null when the selection cannot be
 * squashed.
 *
 * A selection is squashable when (mirroring GitKraken's rules):
 *  - two or more commits are selected,
 *  - every selected commit is known and is a non-merge commit with exactly one
 *    parent (a merge or root commit disqualifies the selection — the oldest
 *    must have a parent to rebase onto),
 *  - the commits form a single contiguous first-parent ancestor-descendant
 *    chain with no gaps.
 */
export function getSquashChain(
  selectedHashes: string[],
  commitsByHash: Map<string, Commit>
): Commit[] | null {
  if (selectedHashes.length < 2) return null;

  const selected = new Set(selectedHashes);
  if (selected.size !== selectedHashes.length) return null; // duplicates

  const commits: Commit[] = [];
  for (const hash of selectedHashes) {
    const commit = commitsByHash.get(hash);
    if (!commit) return null;
    // Exactly one parent: rejects merges (>1) and root commits (0).
    if (commit.parents.length !== 1) return null;
    commits.push(commit);
  }

  // The chain head (newest) is the one not referenced as another selected
  // commit's first parent. There must be exactly one.
  const referencedAsParent = new Set<string>();
  for (const c of commits) {
    if (selected.has(c.parents[0])) referencedAsParent.add(c.parents[0]);
  }
  const heads = commits.filter(c => !referencedAsParent.has(c.hash));
  if (heads.length !== 1) return null;

  // Walk from the head down the first-parent chain; every selected commit must
  // be reachable contiguously.
  const orderedNewestFirst: Commit[] = [];
  let current: string | undefined = heads[0].hash;
  while (current && selected.has(current)) {
    const c: Commit = commitsByHash.get(current)!;
    orderedNewestFirst.push(c);
    current = c.parents[0];
  }
  if (orderedNewestFirst.length !== selectedHashes.length) return null;

  return orderedNewestFirst.reverse(); // oldest→newest
}

function fullMessage(commit: Commit): string {
  return commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
}

/**
 * Default combined message for a squash: each commit's full message joined
 * oldest→newest with blank lines between them.
 */
export function buildDefaultSquashMessage(commitsOldestFirst: Commit[]): string {
  return commitsOldestFirst.map(fullMessage).join('\n\n');
}

/**
 * Build the interactive-rebase todo list that squashes `selectedHashes` into a
 * single commit carrying `finalMessage`.
 *
 * `rebaseCommits` is the full `base..HEAD` range (oldest→newest) where
 * `base` is the parent of the oldest selected commit. Commits outside the
 * selection are preserved as `pick`; the oldest selected commit becomes the
 * squash target (`pick` + final message) and the rest become `fixup`.
 */
export function buildSquashTodos(
  rebaseCommits: Commit[],
  selectedHashes: string[],
  oldestHash: string,
  finalMessage: string
): SquashTodo[] {
  const selected = new Set(selectedHashes);
  return rebaseCommits.map(c => {
    if (c.hash === oldestHash) {
      return { action: 'pick', hash: c.hash, subject: c.subject, message: finalMessage };
    }
    if (selected.has(c.hash)) {
      return { action: 'fixup', hash: c.hash, subject: c.subject };
    }
    return { action: 'pick', hash: c.hash, subject: c.subject };
  });
}
