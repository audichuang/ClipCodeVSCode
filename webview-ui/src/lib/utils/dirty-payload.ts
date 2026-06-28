export type DirtyOption = 'keep' | 'stash' | 'discard';

/** Mirrors the `checkout` message payload fields the backend consumes. */
export type DirtyPayload = {
  merge?: boolean;
  stash?: boolean;
  stashUntracked?: boolean;
  force?: boolean;
  clean?: boolean;
};

/**
 * Translate a dirty-handling choice into the checkout/drag message payload.
 * Mirrors CheckoutCommitModal.buildDirtyPayload: keep→merge, stash→stash+untracked,
 * discard→force+clean. A clean tree yields an empty payload.
 */
export function dirtyPayload(option: DirtyOption, dirty: boolean): DirtyPayload {
  if (!dirty) return {};
  if (option === 'stash') return { stash: true, stashUntracked: true };
  if (option === 'discard') return { force: true, clean: true };
  return { merge: true };
}
