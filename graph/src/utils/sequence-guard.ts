/** Monotonic ticket dispenser for guarding against stale async responses.
 *
 * Pattern: call `issue()` before starting a request; only deliver the
 * response if the returned ticket is still `isCurrent()` after the await.
 * Prevents an older request that finishes late from overwriting a newer
 * one (e.g. rapid clicks on different commits / files). */
export class SequenceGuard {
  private current = 0;

  issue(): number {
    return ++this.current;
  }

  isCurrent(ticket: number): boolean {
    return ticket !== 0 && ticket === this.current;
  }

  reset(): void {
    this.current = 0;
  }
}
