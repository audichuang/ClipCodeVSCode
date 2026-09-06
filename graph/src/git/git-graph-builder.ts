// Graph layout algorithm ported from SourceGit (https://github.com/sourcegit-scm/sourcegit)
// Copyright (c) SourceGit contributors, licensed under MIT License.

import type { BranchInfo, Commit, GraphNode, ParentConnection } from './types';

const COLOR_PALETTE = [
  '#63b0f4', '#73d13d', '#ff7a45', '#b37feb',
  '#f759ab', '#36cfc9', '#ffc53d', '#ff4d4f',
  '#597ef7', '#9254de', '#43e8d8', '#faad14',
];

// ── SourceGit-faithful data structures ──

export interface GraphPath {
  points: Array<{ x: number; y: number }>;
  color: number;
  colorOverride?: string;
  /* SNIPCODE-HOOK start: G2/G7 */
  /** True when any commit on this rail is an ancestor of (or is) HEAD. */
  highlighted: boolean;
  /** Index of this path in FullGraphData.paths — lets the webview map a
   *  hovered/selected dot or link back to the rail it belongs to (G7). */
  pathIndex: number;
  /* SNIPCODE-HOOK end */
}

export interface GraphLink {
  start: { x: number; y: number };
  control: { x: number; y: number };
  end: { x: number; y: number };
  color: number;
  colorOverride?: string;
  /* SNIPCODE-HOOK start: G2/G7 */
  highlighted: boolean;
  /** Index of the rail this merge link connects into (the parent's path). */
  pathIndex: number;
  /* SNIPCODE-HOOK end */
}

export interface GraphDot {
  center: { x: number; y: number };
  color: number;
  colorOverride?: string;
  type: 'default' | 'head' | 'merge';
  localOnly: boolean;
  remoteTip: boolean;
  /* SNIPCODE-HOOK start: G2/G6/G7 */
  /** True when this commit is an ancestor of (or is) HEAD. */
  highlighted: boolean;
  /** True when this commit carries a `head` ref, independent of `type` — lets
   *  HEAD-on-a-merge-commit keep the merge dot's rendering while still
   *  drawing the HEAD ring (type stays 'merge', isHead adds the ring). */
  isHead: boolean;
  /** Index into FullGraphData.paths of the rail this dot sits on, or -1 for a
   *  disconnected root commit with no rail (G7 hover/selected rail highlight). */
  pathIndex: number;
  /* SNIPCODE-HOOK end */
}

export interface FullGraphData {
  paths: GraphPath[];
  links: GraphLink[];
  dots: GraphDot[];
  /** Per-commit left margin (X of content start) */
  commitLeftMargin: number[];
}


// ── PathHelper (exact SourceGit port) ──
class PathHelper {
  path: GraphPath;
  next: string;
  lastX: number;
  private lastY: number;
  private endY: number = 0;

  get isMerged(): boolean { return false; } // simplified

  constructor(next: string, color: number, start: { x: number; y: number }, to?: { x: number; y: number }) {
    this.next = next;
    /* SNIPCODE-HOOK start: G2/G7 — highlighted/pathIndex default; both are set
       by the caller right after construction (highlighted once reachability
       is known, pathIndex once the path is pushed onto result.paths). */
    this.path = { points: [], color, highlighted: false, pathIndex: -1 };
    /* SNIPCODE-HOOK end */

    if (to) {
      this.lastX = to.x;
      this.lastY = to.y;
      this.path.points.push(start);
      this.path.points.push(to);
    } else {
      this.lastX = start.x;
      this.lastY = start.y;
      this.path.points.push(start);
    }
  }

  /** Path passes through this row without a commit */
  pass(x: number, y: number, halfH: number) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - halfH);
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH);
      y += halfH;
      this.add(x, y);
    }
    this.lastX = x;
    this.lastY = y;
  }

  /** Path has a commit at this row, continues to next parent */
  goto(x: number, y: number, halfH: number) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - halfH);
    } else if (x < this.lastX) {
      let minY = y - halfH;
      if (minY > this.lastY) minY -= halfH;
      this.add(this.lastX, minY);
      this.add(x, y);
    }
    this.lastX = x;
    this.lastY = y;
  }

  /** Path ends at this row */
  end(x: number, y: number, halfH: number) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY);
      this.add(x, y - halfH);
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH);
    }
    this.add(x, y);
    this.lastX = x;
    this.lastY = y;
  }

  private add(x: number, y: number) {
    if (this.endY < y) {
      this.path.points.push({ x, y });
      this.endY = y;
    }
  }
}

// ── Remote-only detection ──
// Finds commits that exist only on remote branches (between remote tip and local branch).
// Uses upstream tracking info for accurate local↔remote branch matching.

function buildUpstreamMap(branches: BranchInfo[]): Map<string, string> {
  // Maps "remote/branch" (upstream) → local branch hash
  const map = new Map<string, string>();
  for (const b of branches) {
    if (!b.remote && b.upstream) {
      map.set(b.upstream, b.hash);
    }
  }
  return map;
}

/* SNIPCODE-HOOK start: X6 — remote tip must not be misjudged when it is
   actually an ancestor of the local branch (local ahead of / caught up with
   remote). The candidate-collection pass below only knows "this commit
   carries a remote-branch ref and no local ref" — it can't yet tell whether
   that commit is genuinely remote-only or just an older commit the local
   branch has already passed. That check needs each candidate's corresponding
   local branch's ancestor set, which is only computed in the second pass, so
   we defer tipSet/allSet membership to there instead of writing tipSet
   eagerly in the first pass (the old bug: a "local ahead of remote" tip that
   happened to also collide via truncated BranchInfo.hash could otherwise
   never resolve to a real ancestor and get treated as remote-only forever). */
function buildRemoteOnlyData(commits: Commit[], branches: BranchInfo[], hashIndex: Map<string, number>): { tipSet: Set<string>; allSet: Set<string> } {
  // upstream map: "origin/main" → local branch hash
  const upstreamMap = buildUpstreamMap(branches);

  // Fallback: name-based map from commit refs (for branches without explicit upstream)
  const localBranchMap = new Map<string, string>();
  for (const c of commits) {
    for (const r of c.refs) {
      if (r.type === 'branch' || r.type === 'head') {
        localBranchMap.set(r.name, c.hash);
      }
    }
  }

  // Candidates: commits that carry a remote-branch ref and no local ref, with
  // a resolvable local counterpart hash. Final tipSet/allSet membership is
  // decided below once we know each candidate isn't already an ancestor of
  // that local branch (which would mean local is ahead of / caught up with
  // the remote, not behind it — nothing remote-only there).
  const candidates: Array<{ tipIdx: number; localHash: string }> = [];
  for (const c of commits) {
    const hasRemoteRef = c.refs.some(r => r.type === 'remote-branch');
    const hasLocalRef = c.refs.some(r => r.type === 'branch' || r.type === 'head' || r.type === 'tag');
    if (!hasRemoteRef || hasLocalRef) continue;

    for (const r of c.refs) {
      if (r.type !== 'remote-branch') continue;
      const fullRemoteName = `${r.remote}/${r.name}`;
      const localHash = upstreamMap.get(fullRemoteName) ?? localBranchMap.get(r.name);
      if (localHash && localHash !== c.hash) {
        const idx = hashIndex.get(c.hash);
        if (idx !== undefined) candidates.push({ tipIdx: idx, localHash });
        break;
      }
    }
  }

  // For each candidate, BFS through parents stopping at the corresponding local branch's ancestors
  const tipSet = new Set<string>();
  const allSet = new Set<string>();
  const ancestorCache = new Map<string, Set<string>>();

  for (const { tipIdx, localHash } of candidates) {
    // Get or compute ancestors of the corresponding local branch
    let localAncestors = ancestorCache.get(localHash);
    if (!localAncestors) {
      localAncestors = new Set([localHash]);
      const q: number[] = [];
      const li = hashIndex.get(localHash);
      if (li !== undefined) q.push(li);
      let qHead = 0;
      while (qHead < q.length) {
        const idx = q[qHead++];
        for (const ph of commits[idx].parents) {
          if (!localAncestors.has(ph)) {
            localAncestors.add(ph);
            const pi = hashIndex.get(ph);
            if (pi !== undefined) q.push(pi);
          }
        }
      }
      ancestorCache.set(localHash, localAncestors);
    }

    const tipHash = commits[tipIdx].hash;
    // The remote tip is already part of the local branch's own history (local
    // is ahead of or caught up with the remote) — nothing here is remote-only.
    if (localAncestors.has(tipHash)) continue;

    // BFS from remote tip, stop at local branch ancestors
    tipSet.add(tipHash);
    allSet.add(tipHash);
    const queue = [tipIdx];
    let qHead = 0;
    while (qHead < queue.length) {
      const idx = queue[qHead++];
      for (const parentHash of commits[idx].parents) {
        if (allSet.has(parentHash) || localAncestors.has(parentHash)) continue;
        allSet.add(parentHash);
        const pi = hashIndex.get(parentHash);
        if (pi !== undefined) queue.push(pi);
      }
    }
  }

  return { tipSet, allSet };
}
/* SNIPCODE-HOOK end */

// ── Local-only detection ──

function buildPushedSet(commits: Commit[], hashIndex: Map<string, number>): Set<string> {
  const pushed = new Set<string>();
  const queue: number[] = [];

  // Start from commits that have remote-branch refs
  for (let i = 0; i < commits.length; i++) {
    if (commits[i].refs.some(r => r.type === 'remote-branch')) {
      if (!pushed.has(commits[i].hash)) {
        pushed.add(commits[i].hash);
        queue.push(i);
      }
    }
  }

  // BFS through parents
  let qHead = 0;
  while (qHead < queue.length) {
    const idx = queue[qHead++];
    for (const parentHash of commits[idx].parents) {
      if (!pushed.has(parentHash)) {
        pushed.add(parentHash);
        const pi = hashIndex.get(parentHash);
        if (pi !== undefined) queue.push(pi);
      }
    }
  }

  return pushed;
}

/* SNIPCODE-HOOK start: G1 — stable per-branch color */
function pickColor(unsolved: PathHelper[], preferred?: number): number {
  // Track used colors in a bitmask (palette is < 32 colors) instead of allocating an
  // array + Set on every call. O(lanes), allocation-free. This runs once per new
  // branch head and per merge parent, so it adds up on graphs with many lanes.
  let mask = 0;
  for (let j = 0; j < unsolved.length; j++) {
    const c = unsolved[j].path.color;
    if (c >= 0 && c < 32) mask |= 1 << c;
  }
  if (preferred !== undefined && (mask & (1 << preferred)) === 0) return preferred;
  for (let i = 0; i < COLOR_PALETTE.length; i++) {
    if ((mask & (1 << i)) === 0) return i;
  }
  return 0;
}

/** First naming ref on a commit, preferring head > branch > remote-branch —
 *  NOT `%D` order, which is git's listing order and not stable across repos
 *  (a commit carrying both `feature` and `origin/feature` would otherwise
 *  hash to a different color depending on which git happened to list first). */
function findNamingRef(c: Commit) {
  return c.refs.find(r => r.type === 'head')
    ?? c.refs.find(r => r.type === 'branch')
    ?? c.refs.find(r => r.type === 'remote-branch');
}

// Small deterministic string hash (djb2-ish) — same branch name always maps
// to the same palette slot across refreshes/reloads (G1), independent of
// rail-creation order.
function hashStringToIndex(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % COLOR_PALETTE.length;
}

/** Preferred palette index for a new rail's starting commit (G1). Looks at
 *  the commit's own naming ref first; when the commit has none of its own
 *  (the synthetic UNCOMMITTED row, or a merge-parent commit that isn't itself
 *  a branch tip), falls through to its first parent's naming ref once — that
 *  parent is what actually identifies the branch visually. Returns undefined
 *  when no name is found anywhere, so pickColor just uses the lowest free slot. */
function preferredIndexForCommit(commit: Commit, commits: Commit[], hashIndex: Map<string, number>): number | undefined {
  let ref = findNamingRef(commit);
  if (!ref && commit.parents.length > 0) {
    const pIdx = hashIndex.get(commit.parents[0]);
    if (pIdx !== undefined) ref = findNamingRef(commits[pIdx]);
  }
  if (!ref) return undefined;
  const name = ref.type === 'remote-branch' ? `${ref.remote}/${ref.name}` : ref.name;
  return hashStringToIndex(name);
}
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: G2 — HEAD-reachability, for dimming non-current-branch rails */
function buildHeadReachableSet(commits: Commit[], hashIndex: Map<string, number>): Set<string> | null {
  const headCommit = commits.find(c => c.refs.some(r => r.type === 'head'));
  if (!headCommit) return null; // no HEAD loaded → caller treats everything as highlighted
  const reachable = new Set<string>();
  // UNCOMMITTED (when present) sits above HEAD as its synthetic child (X4) —
  // seed it too so its dot doesn't dim despite genuinely being "on" HEAD.
  const queue: string[] = commits[0]?.hash === 'UNCOMMITTED' ? ['UNCOMMITTED', headCommit.hash] : [headCommit.hash];
  let qHead = 0;
  while (qHead < queue.length) {
    const hash = queue[qHead++];
    if (reachable.has(hash)) continue;
    reachable.add(hash);
    if (hash === 'UNCOMMITTED') {
      queue.push(headCommit.hash);
      continue;
    }
    const idx = hashIndex.get(hash);
    if (idx === undefined) continue;
    for (const p of commits[idx].parents) if (!reachable.has(p)) queue.push(p);
  }
  return reachable;
}
/* SNIPCODE-HOOK end */

// ── Main parse function (SourceGit CommitGraph.Parse port) ──

export function buildFullGraph(
  commits: Commit[],
  branches: BranchInfo[] = [],
  resolveBranchColor?: (refName: string) => string | undefined,
): FullGraphData {
  const UNIT_W = 12;
  const HALF_W = 6;
  const UNIT_H = 1;
  const HALF_H = 0.5;

  const result: FullGraphData = {
    paths: [],
    links: [],
    dots: [],
    commitLeftMargin: [],
  };

  const unsolved: PathHelper[] = [];
  const ended: PathHelper[] = [];
  // Track the rail (PathHelper) each dot sits on so we can backfill the dot's
  // pattern color after the loop. A rail's override may be set by a tip that
  // appears lower on the rail than commits already processed top-to-bottom;
  // the path object is recolored retroactively, but the dots above it were
  // already snapshotted, so we resolve them once the loop has finished.
  const dotPaths: (PathHelper | null)[] = [];
  // Index `unsolved` by `.next` for O(1) merge-parent lookup. Matches `.find()`
  // "first wins" semantics: if multiple paths share the same `next`, the
  // earliest-inserted one is kept in the map.
  const nextMap = new Map<string, PathHelper>();
  const trackNext = (l: PathHelper) => { if (!nextMap.has(l.next)) nextMap.set(l.next, l); };
  const untrackNext = (l: PathHelper) => { if (nextMap.get(l.next) === l) nextMap.delete(l.next); };
  let offsetY = -HALF_H;
  // Build the hash→index map once and share it across the two reachability
  // passes below instead of letting each rebuild its own O(n) copy.
  const hashIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    hashIndex.set(commits[i].hash, i);
  }
  const { tipSet: remoteTipSet, allSet: remoteOnlySet } = buildRemoteOnlyData(commits, branches, hashIndex);
  const pushedSet = buildPushedSet(commits, hashIndex);
  /* SNIPCODE-HOOK start: G2 */
  // null (no HEAD loaded) means "nothing to dim against" — treat everything as highlighted.
  const headReachable = buildHeadReachableSet(commits, hashIndex);
  const isHighlighted = (hash: string) => headReachable === null || headReachable.has(hash);
  /* SNIPCODE-HOOK end */

  // Map each commit that is a (local or remote) branch tip to its pattern color.
  // First matching ref on a commit wins; the resolver enforces config-order priority.
  const tipColorMap = new Map<string, string>();
  if (resolveBranchColor) {
    for (const commit of commits) {
      for (const ref of commit.refs) {
        if (ref.type !== 'branch' && ref.type !== 'remote-branch') continue;
        const c = resolveBranchColor(ref.name);
        if (c) { tipColorMap.set(commit.hash, c); break; }
      }
    }
  }

  for (const commit of commits) {
    let major: PathHelper | null = null;
    offsetY += UNIT_H;

    let offsetX = 4 - HALF_W;
    const maxOffsetOld = unsolved.length > 0 ? unsolved[unsolved.length - 1].lastX : offsetX + UNIT_W;

    for (const l of unsolved) {
      if (l.next === commit.hash) {
        if (major === null) {
          offsetX += UNIT_W;
          major = l;
          /* SNIPCODE-HOOK start: G2 — OR-accumulate: a rail started above HEAD
             (e.g. an origin/main tip 1 commit ahead) becomes highlighted the
             moment it reaches a HEAD-reachable commit; monotonic since every
             ancestor of a reachable commit is itself reachable. */
          major.path.highlighted = major.path.highlighted || isHighlighted(commit.hash);
          /* SNIPCODE-HOOK end */
          if (commit.parents.length > 0) {
            untrackNext(major);
            major.next = commit.parents[0];
            trackNext(major);
            major.goto(offsetX, offsetY, HALF_H);
          } else {
            major.end(offsetX, offsetY, HALF_H);
            ended.push(l);
          }
        } else {
          l.end(major.lastX, offsetY, HALF_H);
          ended.push(l);
        }
      } else {
        offsetX += UNIT_W;
        l.pass(offsetX, offsetY, HALF_H);
      }
    }

    // Remove ended paths in a single O(n) pass
    if (ended.length > 0) {
      const toRemove = new Set(ended);
      let w = 0;
      for (let r = 0; r < unsolved.length; r++) {
        if (!toRemove.has(unsolved[r])) unsolved[w++] = unsolved[r];
      }
      unsolved.length = w;
      for (const e of ended) untrackNext(e);
      ended.length = 0;
    }

    // New branch head
    if (major === null) {
      offsetX += UNIT_W;
      if (commit.parents.length > 0) {
        /* SNIPCODE-HOOK start: G1/G2/G7 */
        const preferred = preferredIndexForCommit(commit, commits, hashIndex);
        major = new PathHelper(commit.parents[0], pickColor(unsolved, preferred), { x: offsetX, y: offsetY });
        major.path.highlighted = isHighlighted(commit.hash);
        unsolved.push(major);
        trackNext(major);
        result.paths.push(major.path);
        major.path.pathIndex = result.paths.length - 1;
        /* SNIPCODE-HOOK end */
      }
    }

    // Pattern color: recolor this commit's rail. The tip sets it once; first set
    // wins so the topmost tip on a shared rail takes precedence.
    if (major && tipColorMap.size > 0 && major.path.colorOverride === undefined) {
      const override = tipColorMap.get(commit.hash);
      if (override) major.path.colorOverride = override;
    }

    // Dot
    const position = { x: major?.lastX ?? offsetX, y: offsetY };
    /* SNIPCODE-HOOK start: G1/P2 — root commit (no rail) still gets a stable
       preferred color instead of always falling back to palette[0]. */
    const dotColor = major?.path.color ?? (preferredIndexForCommit(commit, commits, hashIndex) ?? 0);
    /* SNIPCODE-HOOK end */
    // For parentless (root) commits major is null and carries no path; fall back to tipColorMap.
    const dotColorOverride = major?.path.colorOverride ?? tipColorMap.get(commit.hash);
    const isRemoteOnly = remoteOnlySet.has(commit.hash);
    const isLocalOnly = !pushedSet.has(commit.hash);
    /* SNIPCODE-HOOK start: G6 — isHead independent of type so a HEAD commit
       that is also a merge keeps its merge dot rendering (type stays
       'merge') while still carrying the flag the webview needs to also draw
       the HEAD ring around it. */
    const isHead = commit.refs.some(r => r.type === 'head');
    let dotType: GraphDot['type'] = 'default';
    if (commit.parents.length > 1) dotType = 'merge';
    else if (isHead) dotType = 'head';
    result.dots.push({
      center: position, color: dotColor, colorOverride: dotColorOverride, type: dotType,
      localOnly: isLocalOnly, remoteTip: isRemoteOnly,
      highlighted: isHighlighted(commit.hash), isHead, pathIndex: major?.path.pathIndex ?? -1,
    });
    /* SNIPCODE-HOOK end */
    dotPaths.push(major);

    // Merge parents - skip for remote-tip commits unless they are merge commits
    if (!remoteTipSet.has(commit.hash) || commit.parents.length > 1) {
      for (let j = 1; j < commit.parents.length; j++) {
        const parentHash = commit.parents[j];
        const parent = nextMap.get(parentHash);

        if (parent) {
          // Existing path → create link
          result.links.push({
            start: position,
            end: { x: parent.lastX, y: offsetY + HALF_H },
            control: { x: parent.lastX, y: position.y },
            color: parent.path.color,
            colorOverride: parent.path.colorOverride,
            /* SNIPCODE-HOOK start: G2/G7 */
            highlighted: isHighlighted(commit.hash),
            pathIndex: parent.path.pathIndex,
            /* SNIPCODE-HOOK end */
          });
        } else {
          // New path for merge parent. No separate GraphLink here — the
          // connecting curve from the merge commit down to this rail's start
          // is baked directly into the new path's own points (the `to` arg
          // below), same as upstream.
          offsetX += UNIT_W;
          /* SNIPCODE-HOOK start: G1/G2/G7 */
          const parentIdx = hashIndex.get(parentHash);
          const preferred = parentIdx !== undefined ? preferredIndexForCommit(commits[parentIdx], commits, hashIndex) : undefined;
          const l = new PathHelper(parentHash, pickColor(unsolved, preferred), position, { x: offsetX, y: position.y + HALF_H });
          l.path.highlighted = isHighlighted(commit.hash);
          unsolved.push(l);
          trackNext(l);
          result.paths.push(l.path);
          l.path.pathIndex = result.paths.length - 1;
          /* SNIPCODE-HOOK end */
        }
      }
    }

    result.commitLeftMargin.push(Math.max(offsetX, maxOffsetOld) + HALF_W + 2);
  }

  // Backfill dot overrides from each rail's final color. Dots are 1:1 with
  // commits in order; a dot on a rail whose override was set after the dot was
  // created (a tip lower on the same rail) now picks up the rail color, so the
  // node matches its line. Root commits (no rail) fall back to tipColorMap.
  for (let i = 0; i < result.dots.length; i++) {
    const override = dotPaths[i]?.path.colorOverride ?? tipColorMap.get(commits[i].hash);
    if (override) result.dots[i].colorOverride = override;
  }

  // End remaining paths at the bottom of the graph. End them on their own rail
  // (path.lastX) rather than on their position in the `unsolved` array — the two
  // only coincidentally line up, so the array-index form bent the trailing line
  // sideways when they didn't.
  for (let i = 0; i < unsolved.length; i++) {
    const path = unsolved[i];
    const endY = (commits.length - 0.5) * UNIT_H;
    if (path.path.points.length === 1 && Math.abs(path.path.points[0].y - endY) < 0.0001) continue;
    path.end(path.lastX, endY + HALF_H, HALF_H);
  }

  return result;
}

// ── Legacy adapter: convert FullGraphData to GraphNode[] for existing rendering ──

export function buildGraphFromFullData(commits: Commit[], full: FullGraphData): GraphNode[] {
  const nodes: GraphNode[] = [];
  const hashIndex = new Map<string, number>();
  for (let i = 0; i < commits.length; i++) {
    hashIndex.set(commits[i].hash, i);
  }
  for (let i = 0; i < commits.length; i++) {
    const dot = full.dots[i];
    const commit = commits[i];
    const color = COLOR_PALETTE[dot.color % COLOR_PALETTE.length];
    const parentConns: ParentConnection[] = [];
    for (let pi = 0; pi < commit.parents.length; pi++) {
      const parentIdx = hashIndex.get(commit.parents[pi]) ?? -1;
      if (parentIdx === -1) continue;
      const parentDot = full.dots[parentIdx];
      const pColor = COLOR_PALETTE[parentDot.color % COLOR_PALETTE.length];
      parentConns.push({
        hash: commit.parents[pi],
        column: parentDot.center.x,
        color: pi === 0 ? color : pColor,
      });
    }
    nodes.push({
      commit: commit.hash,
      column: dot.center.x,
      color,
      parents: parentConns,
    });
  }
  return nodes;
}

export function buildGraph(commits: Commit[], branches: BranchInfo[] = []): GraphNode[] {
  return buildGraphFromFullData(commits, buildFullGraph(commits, branches));
}
