import { describe, it, expect } from 'vitest';
import { buildGraph, buildFullGraph } from '../git-graph-builder';
import type { Commit, Ref, BranchInfo } from '../types';

function branch(name: string, hash: string, over: Partial<BranchInfo> = {}): BranchInfo {
  return { name, current: false, ahead: 0, behind: 0, hash, ...over };
}

function makeCommit(hash: string, parents: string[] = [], refs: Ref[] = []): Commit {
  return {
    hash,
    abbreviatedHash: hash.substring(0, 7),
    author: { name: 'Test', email: 'test@test.com', date: '2024-01-01' },
    committer: { name: 'Test', email: 'test@test.com', date: '2024-01-01' },
    subject: `Commit ${hash}`,
    body: '',
    parents,
    refs,
  };
}

describe('buildGraph', () => {
  it('should return empty array for no commits', () => {
    expect(buildGraph([])).toEqual([]);
  });

  it('should place linear history in same column', () => {
    const commits = [
      makeCommit('c3', ['c2']),
      makeCommit('c2', ['c1']),
      makeCommit('c1', []),
    ];

    const nodes = buildGraph(commits);

    expect(nodes).toHaveLength(3);
    // All on the same column
    expect(nodes[0].column).toBe(nodes[1].column);
    expect(nodes[1].column).toBe(nodes[2].column);
  });

  it('should assign different columns for branches', () => {
    const commits = [
      makeCommit('c4', ['c3', 'c2']),
      makeCommit('c3', ['c1']),
      makeCommit('c2', ['c1']),
      makeCommit('c1', []),
    ];

    const nodes = buildGraph(commits);

    expect(nodes).toHaveLength(4);
    expect(nodes[0].parents).toHaveLength(2);
    // The second parent (c2) should be in a different column
    expect(nodes[0].parents[1].column).not.toBe(nodes[0].parents[0].column);
  });

  it('should handle root commit (no parents)', () => {
    const commits = [makeCommit('root', [])];
    const nodes = buildGraph(commits);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].column).toBeGreaterThanOrEqual(0);
    expect(nodes[0].parents).toEqual([]);
  });

  it('should handle octopus merge', () => {
    const commits = [
      makeCommit('merge', ['p1', 'p2', 'p3']),
      makeCommit('p1', ['root']),
      makeCommit('p2', ['root']),
      makeCommit('p3', ['root']),
      makeCommit('root', []),
    ];

    const nodes = buildGraph(commits);

    expect(nodes).toHaveLength(5);
    expect(nodes[0].parents).toHaveLength(3);
  });

  it('should assign colors to nodes', () => {
    const commits = [
      makeCommit('c2', ['c1']),
      makeCommit('c1', []),
    ];

    const nodes = buildGraph(commits);

    expect(nodes[0].color).toBeTruthy();
    expect(typeof nodes[0].color).toBe('string');
    expect(nodes[0].color.startsWith('#')).toBe(true);
  });
});

describe('buildFullGraph remote-tip detection', () => {
  it('should mark commit as remote-tip when it has only remote-branch refs and local branch exists elsewhere', () => {
    const commits = [
      makeCommit('c3', ['c2'], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit('c2', ['c1'], [{ type: 'branch', name: 'main' }]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(true);
    expect(graph.dots[1].type).toBe('default');
  });

  it('should NOT mark as remote-tip when commit has both local and remote refs', () => {
    const commits = [
      makeCommit('c2', ['c1'], [
        { type: 'branch', name: 'main' },
        { type: 'remote-branch', name: 'main', remote: 'origin' },
      ]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(false);
  });

  it('should NOT mark as remote-tip when commit has head ref', () => {
    const commits = [
      makeCommit('c2', ['c1'], [
        { type: 'head', name: 'main' },
        { type: 'remote-branch', name: 'main', remote: 'origin' },
      ]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].type).toBe('head');
  });

  it('should NOT mark as remote-tip when commit has tag ref', () => {
    const commits = [
      makeCommit('c2', ['c1'], [
        { type: 'tag', name: 'v1.0' },
        { type: 'remote-branch', name: 'main', remote: 'origin' },
      ]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(false);
  });

  it('should generate paths for remote-tip commits at branch head', () => {
    const commits = [
      makeCommit('c3', ['c2'], [{ type: 'remote-branch', name: 'feature', remote: 'origin' }]),
      makeCommit('c2', ['c1'], [{ type: 'branch', name: 'feature' }]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(true);
    expect(graph.dots[0].center).toBeDefined();
    const remoteTipY = graph.dots[0].center.y;
    const pathsStartingAtTip = graph.paths.filter(p =>
      p.points.length > 0 && p.points[0].y === remoteTipY
    );
    expect(pathsStartingAtTip).toHaveLength(1);
  });

  it('should not generate links for remote-tip merge commits', () => {
    const commits = [
      makeCommit('c4', ['c2', 'c3'], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit('c3', ['c1']),
      makeCommit('c2', ['c1'], [{ type: 'branch', name: 'main' }]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(true);
    const remoteTipY = graph.dots[0].center.y;
    const linksFromTip = graph.links.filter(l => l.start.y === remoteTipY);
    expect(linksFromTip).toHaveLength(0);
  });

  it('should mark ALL commits between remote tip and local branch as remoteTip', () => {
    // Scenario: remote is 3 commits ahead of local
    // A (main) ← B ← C ← D (origin/main)
    const commits = [
      makeCommit('d', ['c'], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit('c', ['b']),
      makeCommit('b', ['a']),
      makeCommit('a', [], [{ type: 'branch', name: 'main' }]),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].remoteTip).toBe(true);  // d
    expect(graph.dots[1].remoteTip).toBe(true);  // c
    expect(graph.dots[2].remoteTip).toBe(true);  // b
    expect(graph.dots[3].remoteTip).toBe(false); // a (local branch)
  });

  it('should mark remote-only commits even when merged into another local branch', () => {
    // Scenario: feature/db was merged into main, then remote advanced
    // main merged feature/db at some point, then feature/db local was reset back
    // 3f (feature/db local) ← f2 ← 8b ← c5 ← f0 (origin/feature/db)
    //                          \→ merged into main
    const commits = [
      makeCommit('f0', ['c5'], [{ type: 'remote-branch', name: 'feature/db', remote: 'origin' }]),
      makeCommit('merge', ['main-prev', 'f0'], [{ type: 'branch', name: 'main' }]),
      makeCommit('c5', ['8b']),
      makeCommit('8b', ['f2']),
      makeCommit('f2', ['3f']),
      makeCommit('3f', ['base'], [{ type: 'branch', name: 'feature/db' }]),
      makeCommit('main-prev', ['base']),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    // f0, c5, 8b, f2 should all be remote-only even though they're reachable from main
    expect(graph.dots[0].remoteTip).toBe(true);  // f0
    expect(graph.dots[2].remoteTip).toBe(true);  // c5
    expect(graph.dots[3].remoteTip).toBe(true);  // 8b
    expect(graph.dots[4].remoteTip).toBe(true);  // f2
    expect(graph.dots[5].remoteTip).toBe(false); // 3f (local branch)
  });
});

describe('buildFullGraph merge-parent path reuse', () => {
  it('reuses existing path via link when merge parent is already tracked', () => {
    // Topology (newest first):
    //   N (parents [B])         — keeps B's path alive after the merge
    //   M (parents [A, B])      — merge; B is the secondary parent
    //   A (parents [X])
    //   B (parents [X])
    //   X (root)
    //
    // When M is processed, N has already inserted B's path into nextMap.
    // The builder should emit a LINK from M back to that existing path
    // instead of spawning a duplicate path for B.
    const commits = [
      makeCommit('N', ['B']),
      makeCommit('M', ['A', 'B']),
      makeCommit('A', ['X']),
      makeCommit('B', ['X']),
      makeCommit('X', []),
    ];
    const graph = buildFullGraph(commits);
    const mDot = graph.dots[1];
    const linksFromM = graph.links.filter(l =>
      l.start.x === mDot.center.x && l.start.y === mDot.center.y
    );
    // One link from M to B's already-tracked path.
    expect(linksFromM.length).toBeGreaterThanOrEqual(1);
    // The link must terminate at a different column than M (B's path is
    // a separate rail). A horizontal-only link would mean we created a
    // fresh path instead of pointing at the existing one.
    expect(linksFromM.some(l => l.end.x !== mDot.center.x)).toBe(true);
  });
});

describe('buildFullGraph color palette exhaustion', () => {
  it('recycles colors deterministically when palette is exhausted', () => {
    // The palette has 12 colors. An octopus merge with 14 parents forces
    // pickColor to fall through its loop and return 0. The test just needs
    // to confirm: (a) all assigned colors stay within palette bounds, and
    // (b) at least one color repeats once the palette is exhausted.
    const parents = Array.from({ length: 14 }, (_, i) => `p${i + 1}`);
    const commits = [
      makeCommit('M', parents),
      ...parents.map(p => makeCommit(p, [])),
    ];
    const graph = buildFullGraph(commits);
    for (const path of graph.paths) {
      expect(path.color).toBeGreaterThanOrEqual(0);
      expect(path.color).toBeLessThan(12);
    }
    const colors = graph.paths.map(p => p.color);
    expect(new Set(colors).size).toBeLessThan(colors.length);
  });
});

describe('buildFullGraph upstream-based remote-only detection', () => {
  it('uses upstream tracking (not just name) to find the matching local branch', () => {
    // The local branch is named "dev" but tracks "origin/main", so a name-only
    // match would miss it. Passing branches with `upstream` set exercises
    // buildUpstreamMap, which maps "origin/main" → the local branch's hash.
    const commits = [
      makeCommit('r2', ['r1'], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit('r1', ['l1']),
      makeCommit('l1', [], [{ type: 'branch', name: 'dev' }]),
    ];
    const branches = [branch('dev', 'l1', { upstream: 'origin/main' })];
    const graph = buildFullGraph(commits, branches);
    // r2 (origin/main tip) and r1 are ahead of the local branch → remote-only.
    expect(graph.dots[0].remoteTip).toBe(true);   // r2
    expect(graph.dots[2].remoteTip).toBe(false);  // l1 (local "dev")
  });

  it('falls back to name matching when no upstream is configured', () => {
    const commits = [
      makeCommit('r2', ['r1'], [{ type: 'remote-branch', name: 'feature', remote: 'origin' }]),
      makeCommit('r1', ['l1']),
      makeCommit('l1', [], [{ type: 'branch', name: 'feature' }]),
    ];
    // Branch with no upstream → buildUpstreamMap stays empty, name fallback used.
    const graph = buildFullGraph(commits, [branch('feature', 'l1')]);
    expect(graph.dots[0].remoteTip).toBe(true);
    expect(graph.dots[2].remoteTip).toBe(false);
  });
});

/* SNIPCODE-HOOK start: X6 regression — BranchInfo.hash must be the FULL
   object name (git-service.ts now emits %(objectname), not
   %(objectname:short)) for buildUpstreamMap's hash to line up with
   hashIndex's full-hash keys. Fixtures below use realistic full-length hex
   hashes (not the 1-3 char toy IDs used elsewhere in this file) so the tests
   actually exercise exact full-string matching rather than accidentally
   passing due to short, incidental equality. One "ahead" shape (remote leads,
   with several hops of shared history below the divergence point — this is
   what silently broke before the fix: with a truncated hash, hashIndex.get()
   on the local tip missed entirely, localAncestors never resolved past a
   placeholder string, and the BFS never stopped, wrongly marking the whole
   shared history as remote-only) and one "behind" shape (remote lags local —
   this also exercises the buildRemoteOnlyData ancestor-check fix above: the
   remote tip commit itself must NOT be flagged just because it differs from
   the local tip's hash). */
describe('buildFullGraph remoteTip stays correct with full-length BranchInfo.hash (X6)', () => {
  const LOCAL_TIP = '2222222222222222222222222222222222222222';
  const SHARED_1 = '3333333333333333333333333333333333333333';
  const SHARED_0 = '4444444444444444444444444444444444444444';
  const REMOTE_1 = '1111111111111111111111111111111111111111';
  const REMOTE_2 = '0000000000000000000000000000000000000000';

  it('ahead: remote leads by 2 commits, with 2 hops of shared history below the local tip', () => {
    const commits = [
      makeCommit(REMOTE_2, [REMOTE_1], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit(REMOTE_1, [LOCAL_TIP]),
      makeCommit(LOCAL_TIP, [SHARED_1], [{ type: 'branch', name: 'main' }]),
      makeCommit(SHARED_1, [SHARED_0]),
      makeCommit(SHARED_0, []),
    ];
    const branches = [branch('main', LOCAL_TIP, { upstream: 'origin/main' })];
    const graph = buildFullGraph(commits, branches);
    expect(graph.dots[0].remoteTip).toBe(true);  // REMOTE_2
    expect(graph.dots[1].remoteTip).toBe(true);  // REMOTE_1
    expect(graph.dots[2].remoteTip).toBe(false); // LOCAL_TIP
    expect(graph.dots[3].remoteTip).toBe(false); // SHARED_1 — the "整條祖先" case
    expect(graph.dots[4].remoteTip).toBe(false); // SHARED_0
  });

  it('behind: local leads by 2 commits, remote tip is a plain ancestor — nothing is remote-only', () => {
    const commits = [
      makeCommit(LOCAL_TIP, [REMOTE_1], [{ type: 'branch', name: 'main' }]),
      makeCommit(REMOTE_1, [SHARED_1]),
      makeCommit(SHARED_1, [SHARED_0], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit(SHARED_0, []),
    ];
    const branches = [branch('main', LOCAL_TIP, { upstream: 'origin/main' })];
    const graph = buildFullGraph(commits, branches);
    for (const dot of graph.dots) {
      expect(dot.remoteTip).toBe(false);
    }
  });
});
/* SNIPCODE-HOOK end */

describe('buildFullGraph lane geometry', () => {
  it('builds bending paths when lanes are created and collapse', () => {
    // A feature branch forks off main, runs in parallel, then merges back.
    // This forces lanes to shift columns (pass/goto on a non-origin column),
    // so paths must contain bends rather than a single straight segment.
    //
    //   m4 (main)   [m3]
    //   m3 (merge)  [m2, f2]   ← feature merges back into main
    //   f2          [f1]
    //   m2          [m1]
    //   f1          [m1]       ← feature forked from m1
    //   m1          [m0]
    //   m0 (root)   []
    const commits = [
      makeCommit('m4', ['m3']),
      makeCommit('m3', ['m2', 'f2']),
      makeCommit('f2', ['f1']),
      makeCommit('m2', ['m1']),
      makeCommit('f1', ['m1']),
      makeCommit('m1', ['m0']),
      makeCommit('m0', []),
    ];
    const graph = buildFullGraph(commits);

    expect(graph.dots).toHaveLength(7);
    // The merge commit (m3) is a multi-parent node.
    expect(graph.dots[1].type).toBe('merge');
    // At least one path bends: it has points spanning more than one X column.
    const hasBend = graph.paths.some(p => {
      const xs = new Set(p.points.map(pt => pt.x));
      return xs.size > 1;
    });
    expect(hasBend).toBe(true);
    // Every dot lands on a valid (finite, non-negative) coordinate.
    for (const dot of graph.dots) {
      expect(Number.isFinite(dot.center.x)).toBe(true);
      expect(dot.center.x).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps multiple concurrent lanes distinct without overlap at the fork row', () => {
    // Two independent branches off a shared root produce two separate rails
    // that must occupy different columns.
    const commits = [
      makeCommit('a2', ['a1'], [{ type: 'branch', name: 'a' }]),
      makeCommit('b2', ['b1'], [{ type: 'branch', name: 'b' }]),
      makeCommit('a1', ['root']),
      makeCommit('b1', ['root']),
      makeCommit('root', []),
    ];
    const graph = buildFullGraph(commits);
    // a2 and b2 are tips of distinct branches → different columns.
    expect(graph.dots[0].center.x).not.toBe(graph.dots[1].center.x);
  });
});

describe('buildFullGraph branch color override', () => {
  it('stamps colorOverride on the matching tip rail path and dot', () => {
    const commits = [
      makeCommit('c3', ['c2'], [{ type: 'branch', name: 'main' }]),
      makeCommit('c2', ['c1']),
      makeCommit('c1', []),
    ];
    const resolve = (name: string) => (name === 'main' ? '#abcdef' : undefined);
    const full = buildFullGraph(commits, [], resolve);

    // The tip's dot (index 0) belongs to the main rail.
    expect(full.dots[0].colorOverride).toBe('#abcdef');
    // The rail path carrying the tip is overridden.
    expect(full.paths.some(p => p.colorOverride === '#abcdef')).toBe(true);
  });

  it('matches remote-branch refs by name without remote prefix', () => {
    const commits = [
      makeCommit('c1', [], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
    ];
    const resolve = (name: string) => (name === 'main' ? '#123456' : undefined);
    const full = buildFullGraph(commits, [], resolve);
    expect(full.dots[0].colorOverride).toBe('#123456');
  });

  it('leaves colorOverride undefined when nothing matches', () => {
    const commits = [makeCommit('c1', [], [{ type: 'branch', name: 'dev' }])];
    const resolve = () => undefined;
    const full = buildFullGraph(commits, [], resolve);
    expect(full.dots[0].colorOverride).toBeUndefined();
    expect(full.paths.every(p => p.colorOverride === undefined)).toBe(true);
  });

  it('is a no-op when no resolver is provided', () => {
    const commits = [makeCommit('c1', [], [{ type: 'branch', name: 'main' }])];
    const full = buildFullGraph(commits, []);
    expect(full.dots[0].colorOverride).toBeUndefined();
  });

  it('colors dots above the matching tip on the same rail', () => {
    // The matching ref (origin/main) sits at the BOTTOM of the rail. The newer
    // commits above it on the same rail must still get the override — the rail
    // line is recolored when the bottom tip is processed, so the dots above
    // (snapshotted earlier in the top-down pass) must not keep the auto color.
    const commits = [
      makeCommit('c0', ['c1']),
      makeCommit('c1', ['c2']),
      makeCommit('c2', [], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
    ];
    const resolve = (name: string) => (name === 'main' ? '#00FF00' : undefined);
    const full = buildFullGraph(commits, [], resolve);
    expect(full.dots.map(d => d.colorOverride)).toEqual(['#00FF00', '#00FF00', '#00FF00']);
    // The rail path is also green (it already was, pre-fix).
    expect(full.paths.some(p => p.colorOverride === '#00FF00')).toBe(true);
  });
});

/* SNIPCODE-HOOK start: G1 — stable per-branch color */
describe('buildFullGraph stable per-branch color (G1)', () => {
  it('the same branch name gets the same palette color across two unrelated logs', () => {
    const logA = [
      makeCommit('m1', ['baseA'], [{ type: 'branch', name: 'main' }]),
      makeCommit('baseA', []),
    ];
    // Unrelated surrounding branch ('other', a different preferred slot) so the
    // free-mask fallback never has to kick in for 'main' here either — this
    // isolates "does the SAME name land on the SAME slot across two graphs".
    const logB = [
      makeCommit('x1', ['baseB1'], [{ type: 'branch', name: 'other' }]),
      makeCommit('m2', ['baseB2'], [{ type: 'branch', name: 'main' }]),
      makeCommit('baseB1', []),
      makeCommit('baseB2', []),
    ];
    const graphA = buildFullGraph(logA);
    const graphB = buildFullGraph(logB);
    expect(graphA.dots[0].color).toBe(graphB.dots[1].color);
  });

  it('two simultaneously visible rails whose names hash to the same slot still get different colors', () => {
    // 'main' and 'develop' land on the same preferred palette slot (both hash
    // to 1 with the djb2-ish function this module uses) — pickColor's
    // free-mask fallback must still keep two rails visible at once distinct
    // instead of both claiming the same lane color.
    const commits = [
      makeCommit('m1', ['base1'], [{ type: 'branch', name: 'main' }]),
      makeCommit('d1', ['base2'], [{ type: 'branch', name: 'develop' }]),
      makeCommit('base1', []),
      makeCommit('base2', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].color).not.toBe(graph.dots[1].color);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: G2 — HEAD-reachability highlighting */
describe('buildFullGraph HEAD-reachability highlighting (G2)', () => {
  it('dims a rail that is not an ancestor of HEAD', () => {
    const commits = [
      makeCommit('f2', ['f1'], [{ type: 'branch', name: 'feature' }]),
      makeCommit('f1', ['base']),
      makeCommit('h1', ['base'], [{ type: 'head', name: 'main' }]),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].highlighted).toBe(false); // f2
    expect(graph.dots[1].highlighted).toBe(false); // f1
    expect(graph.dots[2].highlighted).toBe(true);  // h1 (HEAD)
    expect(graph.dots[3].highlighted).toBe(true);  // base (shared ancestor)
  });

  it('a rail starting above HEAD (e.g. an unfetched remote tip 1 commit ahead) becomes highlighted once it reaches HEAD', () => {
    const commits = [
      makeCommit('r2', ['h1'], [{ type: 'remote-branch', name: 'main', remote: 'origin' }]),
      makeCommit('h1', ['base'], [{ type: 'head', name: 'main' }]),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    const railIndex = graph.dots[1].pathIndex; // h1's rail
    expect(railIndex).toBeGreaterThanOrEqual(0);
    expect(graph.paths[railIndex].highlighted).toBe(true);
  });

  it('UNCOMMITTED (seeded as HEAD\'s synthetic child) is highlighted too', () => {
    const commits = [
      makeCommit('UNCOMMITTED', ['h1']),
      makeCommit('h1', ['base'], [{ type: 'head', name: 'main' }]),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].highlighted).toBe(true);
  });

  it('treats everything as highlighted when no HEAD is loaded (nothing to dim against)', () => {
    const commits = [
      makeCommit('f2', ['f1'], [{ type: 'branch', name: 'feature' }]),
      makeCommit('f1', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots.every(d => d.highlighted)).toBe(true);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: G6 — HEAD-on-merge keeps the merge dot, adds isHead */
describe('buildFullGraph HEAD-on-merge dot (G6)', () => {
  it('keeps type "merge" but sets isHead when HEAD lands on a merge commit', () => {
    const commits = [
      makeCommit('merge', ['a', 'b'], [{ type: 'head', name: 'main' }]),
      makeCommit('a', ['base']),
      makeCommit('b', ['base']),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].type).toBe('merge');
    expect(graph.dots[0].isHead).toBe(true);
  });

  it('a plain (non-merge) HEAD commit still gets type "head"', () => {
    const commits = [
      makeCommit('h1', ['base'], [{ type: 'head', name: 'main' }]),
      makeCommit('base', []),
    ];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].type).toBe('head');
    expect(graph.dots[0].isHead).toBe(true);
  });

  it('a non-HEAD commit never sets isHead', () => {
    const commits = [makeCommit('c1', [])];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].isHead).toBe(false);
  });
});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: G7 — rail pathIndex for hover/selected highlight */
describe('buildFullGraph rail pathIndex (G7)', () => {
  it('a dot\'s pathIndex points at the path it actually sits on', () => {
    const commits = [
      makeCommit('c2', ['c1'], [{ type: 'branch', name: 'main' }]),
      makeCommit('c1', []),
    ];
    const graph = buildFullGraph(commits);
    const idx = graph.dots[0].pathIndex;
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(graph.paths[idx]).toBeDefined();
    expect(graph.paths[idx].points[0]).toEqual(graph.dots[0].center);
  });

  it('a merge link into an existing rail carries that rail\'s pathIndex', () => {
    // Same topology as the "reuses existing path via link" test above.
    const commits = [
      makeCommit('N', ['B']),
      makeCommit('M', ['A', 'B']),
      makeCommit('A', ['X']),
      makeCommit('B', ['X']),
      makeCommit('X', []),
    ];
    const graph = buildFullGraph(commits);
    const mDot = graph.dots[1];
    const link = graph.links.find(l => l.start.x === mDot.center.x && l.start.y === mDot.center.y);
    expect(link).toBeDefined();
    expect(link!.pathIndex).toBeGreaterThanOrEqual(0);
    expect(graph.paths[link!.pathIndex]).toBeDefined();
  });

  it('a disconnected root dot with no rail gets pathIndex -1', () => {
    const commits = [makeCommit('root', [])];
    const graph = buildFullGraph(commits);
    expect(graph.dots[0].pathIndex).toBe(-1);
  });
});
/* SNIPCODE-HOOK end */
