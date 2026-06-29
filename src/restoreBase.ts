// "Off by one folder level" detection for Paste & Restore.
//
// When a bundle was copied from a different folder level than the target
// workspace (e.g. copied with the repo as root → restored into the parent that
// contains the repo, or vice-versa), the clipboard's relative paths are all off
// by the same one level. We infer that single offset by checking which
// interpretation lands the files inside directories that ALREADY exist in the
// target — then the caller asks the user to confirm before applying it.
//
// Scoring only considers paths that have a subdirectory; a file's own parent dir
// existing on disk is the signal. Root-level files (no subdir) don't disambiguate
// the offset, so they're excluded from scoring and just ride along with the chosen
// base. The confirmation step is the real safety net; this only decides whether a
// suggestion is worth surfacing.

export type RestoreBase =
  | { kind: 'strip'; segment: string }  // drop a redundant leading `${segment}/`
  | { kind: 'add'; prefix: string };    // nest everything under an existing `${prefix}/`

export interface RestoreBaseSuggestion {
  base: RestoreBase;
  label: string;   // human description for the confirmation prompt
  matched: number; // subdir-bearing files that land in an existing dir under this base
  total: number;   // subdir-bearing files considered
}

export interface DirProbe {
  isDir(absPath: string): boolean;
  childDirs(rootAbsPath: string): string[];
}

export function applyRestoreBase(base: RestoreBase, relativePath: string): string {
  if (base.kind === 'add') {
    return `${base.prefix}/${relativePath}`;
  }
  const slash = relativePath.indexOf('/');
  return slash >= 0 && relativePath.slice(0, slash) === base.segment
    ? relativePath.slice(slash + 1)
    : relativePath;
}

function isRelative(p: string): boolean {
  // Reject POSIX absolutes, Windows drive paths (C:/ or C:\) and UNC (\\server).
  return !!p && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('\\');
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel}`;
}

function baseNameOf(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
}

export function suggestRestoreBase(
  primaryRoot: string,
  relativePaths: string[],
  probe: DirProbe
): RestoreBaseSuggestion | undefined {
  // Only plain relative, subdir-bearing paths carry an offset signal; require at
  // least two so a single coincidental path can't drive a relocation.
  const multi = relativePaths.filter(p => isRelative(p) && p.includes('/'));
  if (multi.length < 2) return undefined;

  const parentExists = (rel: string): boolean => {
    const slash = rel.lastIndexOf('/');
    return slash >= 0 && probe.isDir(joinPath(primaryRoot, rel.slice(0, slash)));
  };
  const scoreBase = (base: RestoreBase | undefined): number =>
    multi.filter(p => parentExists(base ? applyRestoreBase(base, p) : p)).length;

  const identityScore = scoreBase(undefined);

  const candidates: Array<{ base: RestoreBase; score: number; label: string }> = [];

  // strip-1: only when every subdir-bearing path shares one leading segment AND
  // that segment is the workspace folder's own name — i.e. the bundle was copied
  // from the parent that contains this repo. Anchoring to the basename avoids
  // stripping a legitimately-named top folder like "examples/".
  const firstSegments = new Set(multi.map(p => p.slice(0, p.indexOf('/'))));
  if (firstSegments.size === 1 && [...firstSegments][0] === baseNameOf(primaryRoot)) {
    const segment = [...firstSegments][0];
    candidates.push({ base: { kind: 'strip', segment }, score: scoreBase({ kind: 'strip', segment }), label: `remove the leading "${segment}/"` });
  }

  // add-prefix: nest under each directory that already exists at the workspace root.
  for (const prefix of probe.childDirs(primaryRoot)) {
    candidates.push({ base: { kind: 'add', prefix }, score: scoreBase({ kind: 'add', prefix }), label: `place everything under "${prefix}/"` });
  }
  if (candidates.length === 0) return undefined;

  // The winning score must be UNIQUE — except a basename-anchored strip is allowed
  // to win a tie since it's unambiguous. Two child dirs that match equally well
  // (e.g. repo-a/src and repo-b/src) are ambiguous → suggest nothing.
  candidates.sort((a, b) => b.score - a.score);
  const maxScore = candidates[0].score;
  const top = candidates.filter(c => c.score === maxScore);
  const best = top.length === 1 ? top[0] : top.find(c => c.base.kind === 'strip');

  // Surface only a confident, non-trivial offset: beat leaving paths as-is and
  // match a majority of the subdir-bearing files.
  if (!best || best.score <= identityScore || best.score * 2 < multi.length) {
    return undefined;
  }
  return { base: best.base, label: best.label, matched: best.score, total: multi.length };
}
