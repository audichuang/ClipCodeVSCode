// Tracks a monotonically increasing generation per key so an in-flight async
// render can detect it was superseded by a later enable/disable toggle and
// skip applying now-stale decorations. Pure data structure, no vscode dependency.
export class GenerationGate {
  private readonly generations = new Map<string, number>();

  // Call on every enable/disable transition for `key`. Returns the new
  // generation so the caller can capture it before starting async work.
  bump(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  current(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  // True if `generation` (captured when a render started) is still the
  // latest generation for `key` — i.e. no enable/disable happened since.
  isCurrent(key: string, generation: number): boolean {
    return this.generations.get(key) === generation;
  }
}
