// Blame results are cached per (repo, HEAD, document.version) so an unsaved
// edit (which bumps document.version) or a HEAD move invalidates naturally.
import type { BlameLine } from './blameParser.js';

export function blameCacheKey(repoRoot: string, head: string, docVersion: number): string {
  return `${repoRoot} ${head} ${docVersion}`;
}

export class BlameCache {
  private readonly map = new Map<string, BlameLine[]>();
  get(key: string): BlameLine[] | undefined { return this.map.get(key); }
  set(key: string, lines: BlameLine[]): void { this.map.set(key, lines); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
}
