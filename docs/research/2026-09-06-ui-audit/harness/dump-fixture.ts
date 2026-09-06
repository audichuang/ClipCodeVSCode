// One-shot: run the REAL git layer of the graph extension against the synthetic
// repo and dump exactly what MainPanel would post to the webview.
import { writeFileSync } from 'fs';
import { GitService } from '/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/src/git/git-service';
import { buildFullGraph } from '/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/src/git/git-graph-builder';
import { compileBranchColorRules, makeBranchColorResolver } from '/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/src/git/branch-color-resolver';

const repoPath = process.argv[2];
const out = process.argv[3];
const gs = new GitService(repoPath);

(async () => {
  // Mirrors MainPanel.getLog: limit+1, topological, signatures on first load.
  const [allFetched, branches, tags, remotes, stashes, worktrees] = await Promise.all([
    gs.log({ limit: 201, sortOrder: 'topological', includeSignature: true }),
    gs.branches(), gs.tags(), gs.remotes(), gs.stashList(), gs.worktreeList(),
  ]);
  const commits = allFetched; // 42 rows < 200 → trimLogRows is a no-op, hasMore=false
  const full = buildFullGraph(commits, branches, makeBranchColorResolver(compileBranchColorRules(undefined)));
  const logData = {
    commits, hasMore: false, currentLimit: 200, graph: [],
    paths: full.paths, links: full.links, dots: full.dots, commitLeftMargin: full.commitLeftMargin,
    remoteFilter: undefined, branches: undefined,
  };
  const branchData = { branches, tags, remotes, stashes, worktrees };

  // Bottom-panel data: file list for every real commit, full diffs for merges.
  const commitFiles: Record<string, unknown> = {};
  const fileDiffs: Record<string, unknown> = {};
  for (const c of commits) {
    if (c.hash === 'UNCOMMITTED' || c.refs.some(r => r.type === 'stash')) continue;
    commitFiles[c.hash] = await gs.showCommitFiles(c.hash);
    if (c.parents.length > 1) {
      for (const f of commitFiles[c.hash] as Array<{ path: string }>) {
        fileDiffs[`${c.hash}:${f.path}`] = (await gs.showCommitDiff(c.hash, f.path))[0] ?? null;
      }
    }
  }
  const uncommitted = await gs.getUncommittedDiff();
  const dirtyFile = 'src/api/users.ts';
  const uncommittedFileDiffs = {
    [`staged:${dirtyFile}`]: await gs.getUncommittedFileDiff(dirtyFile, true),
    [`unstaged:${dirtyFile}`]: await gs.getUncommittedFileDiff(dirtyFile, false),
  };

  writeFileSync(out, JSON.stringify({ repoPath, logData, branchData, commitFiles, fileDiffs, uncommitted, dirtyFile, uncommittedFileDiffs }, null, 1));
  console.log(`commits=${commits.length} paths=${full.paths.length} links=${full.links.length} dots=${full.dots.length} branches=${branches.length} tags=${tags.length} stashes=${stashes.length}`);
  console.log('merges:', commits.filter(c => c.parents.length > 1).map(c => `${c.abbreviatedHash} ${c.subject}`).join(' | '));
  console.log('refs sample:', JSON.stringify(commits.slice(0, 6).map(c => [c.abbreviatedHash, c.refs])));
})().catch(e => { console.error(e); process.exit(1); });
