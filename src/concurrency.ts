// Map `fn` over `items` with bounded concurrency, yielding results in input
// order. Used to fan out the per-file `git show` reads that otherwise run one
// subprocess at a time (90 files → 90 serial spawns → ~10s).
//
// ponytail: chunked barrier — each batch waits for its slowest member before
// the next batch starts. Fine for git-show fan-out where per-file latency is
// uniform; switch to a sliding-window pool only if intra-batch latency skew
// becomes the bottleneck.
export async function* mapInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): AsyncGenerator<R> {
  const limit = Math.max(1, Math.floor(concurrency));
  for (let i = 0; i < items.length; i += limit) {
    const batch = await Promise.all(items.slice(i, i + limit).map(fn));
    for (const result of batch) yield result;
  }
}
