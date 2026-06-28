import type { DirtyPayload } from './dirty-payload';

export type DropResolution =
  | { kind: 'ignore' }
  | { kind: 'menu'; source: string; target: string };

/**
 * Decide what a branch-label drop should do. Pure: no DOM, no stores.
 * Both ends must be local branches; same-branch is a no-op. Dirty handling is
 * decided by the caller (no longer blocked here).
 */
export function resolveDrop(
  source: string,
  target: string,
  localBranchNames: ReadonlySet<string>,
): DropResolution {
  if (!source || !target) return { kind: 'ignore' };
  if (!localBranchNames.has(source) || !localBranchNames.has(target)) return { kind: 'ignore' };
  if (source === target) return { kind: 'ignore' };
  return { kind: 'menu', source, target };
}

export function dragRebaseMessage(source: string, target: string, dirty: DirtyPayload = {}) {
  return { type: 'dragRebase' as const, payload: { source, target, ...dirty } };
}

export function dragMergeMessage(source: string, target: string, dirty: DirtyPayload = {}) {
  return { type: 'dragMerge' as const, payload: { source, target, ...dirty } };
}
