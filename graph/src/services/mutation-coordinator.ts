// Module-level, repo-path-keyed mutation serializer (design decision D2).
//
// GitService.withMutationLock is per-instance and per-command; it cannot make
// an apply→commit sequence atomic across panels. Two panels (the Graph view and
// the commit workbench) may hold different GitService instances for the SAME
// repo, so a per-instance lock lets them race on .git/index.lock. This module
// keeps one promise chain per repo path: same-path callers queue strictly in
// arrival order (the next starts only after the previous settles), while
// different paths proceed in parallel.
//
// B-2 wraps every mutating webview handler (Graph + workbench) in runExclusive;
// B-1 only delivers this tested module.
//
// ponytail: chains are never pruned from the Map — one entry per repo path
// touched this session, bounded by the workspace's repo count. Add eviction
// only if that ever becomes a real footprint problem.

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively with respect to other runExclusive calls for the same
 * `repoPath`. Calls with the same path never overlap and run in call order;
 * calls with different paths run concurrently. Rejection of one call does not
 * stall the queue — the next queued call still runs.
 */
export function runExclusive<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(repoPath) ?? Promise.resolve();
  // .then(fn, fn): chain onto the previous settle whether it resolved OR
  // rejected, so one failure never wedges the queue.
  const run = prev.then(fn, fn);
  // Swallow the result/error for the CHAIN pointer only; callers still see the
  // real outcome through the returned `run`.
  chains.set(repoPath, run.then(() => undefined, () => undefined));
  return run;
}
