// Blame results are cached per (repo, HEAD, document.version) so an unsaved
// edit (which bumps document.version) or a HEAD move invalidates naturally.
import type { BlameLine } from './blameParser.js';

export function blameCacheKey(repoRoot: string, head: string, docVersion: number): string {
  return `${repoRoot} ${head} ${docVersion}`;
}

export class BlameCache {
  private readonly map = new Map<string, BlameLine[]>();
  // Tracks the most recent cache key stored for each document (keyed by
  // document URI string), so a new document.version can evict its own stale
  // entry instead of the map growing once per keystroke forever.
  private readonly lastKeyForDoc = new Map<string, string>();

  get(key: string): BlameLine[] | undefined { return this.map.get(key); }
  set(key: string, lines: BlameLine[]): void { this.map.set(key, lines); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); this.lastKeyForDoc.clear(); }
  get size(): number { return this.map.size; }

  // Stores `lines` under `key` for `docKey`, evicting whatever entry was
  // previously cached for the same document (its old document.version) so
  // the cache stays bounded to one entry per open document.
  setForDoc(docKey: string, key: string, lines: BlameLine[]): void {
    const prevKey = this.lastKeyForDoc.get(docKey);
    if (prevKey && prevKey !== key) this.map.delete(prevKey);
    this.map.set(key, lines);
    this.lastKeyForDoc.set(docKey, key);
  }
}
