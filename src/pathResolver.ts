import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { asciiTrim } from './clipboardFormat.js';

export interface ResolvedRestoreTarget {
  ok: true;
  relativePath: string;
  absolutePath: string;
  rootPath: string;
  existed: boolean;
}

export interface RejectedRestoreTarget {
  ok: false;
  reason: 'unsafe path' | 'outside workspace' | 'ambiguous path' | 'missing path';
  relativePath?: string;
  candidates?: string[];
}

export type RestoreTargetResolution = ResolvedRestoreTarget | RejectedRestoreTarget;

interface RootEntry {
  path: string;
  isPrimary: boolean;
  clipboardLabel?: string;
  hasAmbiguousLabel: boolean;
}

interface TargetCandidate {
  root: RootEntry;
  target: string;
  rootRelativePath: string;
}

/**
 * The `// clipcode-root:` value: the basename of the base the PATHS in this payload are
 * relative to.
 *
 * Its only job is to let Paste & Restore line folder levels up, which works precisely when
 * the name and the paths describe the same base. Naming the git repository root instead —
 * while the headers stayed workspace-relative — broke exactly that: with the workspace
 * opened at `repo/src`, a payload said root `repo` and path `a.txt`, so restoring into
 * `repo` saw the name already matching and offered no adjustment, landing the file at
 * `repo/a.txt` instead of `repo/src/a.txt`. The graph surface is consistent the other way
 * round — it emits repo-relative paths AND the repo root — and keeps its own rule.
 *
 * Multiple roots means the paths are labelled per root, so no single name describes them
 * and none is emitted. Mirror of ClipboardPathResolver.singleRootName.
 */
export function sourceRootName(roots: string[]): string | undefined {
  return roots.length === 1 ? basenameOf(roots[0]) : undefined;
}

function basenameOf(fsPath: string): string | undefined {
  return normalizeSystemPath(fsPath).split('/').filter(Boolean).pop();
}

export function toClipboardPath(workspaceRoot: string, absolutePath: string): string {
  return toClipboardPathFromRoots([workspaceRoot], absolutePath);
}

export function toClipboardPathFromRoots(
  workspaceRoots: string[],
  absolutePath: string,
  primaryRootPath: string | undefined = workspaceRoots[0]
): string {
  const resolver = new PathResolver(workspaceRoots, primaryRootPath);
  return resolver.toClipboardPath(absolutePath);
}

export function resolveRestoreTarget(workspaceRoot: string, clipboardPath: string): RestoreTargetResolution {
  return resolveWriteTarget([workspaceRoot], clipboardPath);
}

export function resolveWriteTarget(workspaceRoots: string[], clipboardPath: string): RestoreTargetResolution {
  return new PathResolver(workspaceRoots).resolveWriteTarget(clipboardPath);
}

export function resolveDeleteTarget(workspaceRoots: string[], clipboardPath: string): RestoreTargetResolution {
  return new PathResolver(workspaceRoots).resolveDeleteTarget(clipboardPath);
}

class PathResolver {
  private readonly orderedRoots: RootEntry[];
  private readonly primaryRoot: RootEntry | undefined;
  private readonly primaryReservedLabels: Set<string>;

  constructor(workspaceRoots: string[], primaryRootPath: string | undefined = workspaceRoots[0]) {
    const normalizedRoots = distinctBy(
      workspaceRoots.map(normalizeSystemPath).filter(Boolean),
      pathKey
    );
    const normalizedPrimary = primaryRootPath
      ? normalizeSystemPath(primaryRootPath)
      : normalizedRoots[0];
    const allRootPaths = distinctBy(
      [normalizedPrimary, ...normalizedRoots].filter(Boolean),
      pathKey
    );

    const externalLabels = allRootPaths
      .filter(root => normalizedPrimary && !samePath(root, normalizedPrimary) && !isUnderRoot(root, normalizedPrimary))
      .map(root => path.basename(root))
      .filter(Boolean);
    const labelCounts = countValues(externalLabels);

    this.primaryReservedLabels = new Set();
    if (normalizedPrimary) {
      for (const root of allRootPaths) {
        if (!samePath(root, normalizedPrimary) && isUnderRoot(root, normalizedPrimary)) {
          const firstSegment = relativizePath(root, normalizedPrimary)?.split('/')[0];
          if (firstSegment) this.primaryReservedLabels.add(firstSegment);
        }
      }
      for (const label of externalLabels) {
        if (existsSync(path.join(normalizedPrimary, label))) {
          this.primaryReservedLabels.add(label);
        }
      }
    }

    this.orderedRoots = allRootPaths
      .map(root => {
        const isPrimary = normalizedPrimary !== undefined && samePath(root, normalizedPrimary);
        const isExternalRoot = !isPrimary && (!normalizedPrimary || !isUnderRoot(root, normalizedPrimary));
        const clipboardLabel = isExternalRoot ? path.basename(root) || undefined : undefined;
        return {
          path: root,
          isPrimary,
          clipboardLabel,
          hasAmbiguousLabel: clipboardLabel !== undefined &&
            ((labelCounts.get(clipboardLabel) ?? 0) !== 1 || this.primaryReservedLabels.has(clipboardLabel))
        };
      })
      .sort((left, right) => right.path.length - left.path.length);

    this.primaryRoot = this.orderedRoots.find(root => root.isPrimary) ?? this.orderedRoots[0];
  }

  toClipboardPath(absolutePath: string): string {
    const normalizedAbsolutePath = normalizeSystemPath(absolutePath);

    if (this.primaryRoot) {
      const primaryRelativePath = relativizePath(normalizedAbsolutePath, this.primaryRoot.path);
      if (primaryRelativePath !== undefined) return primaryRelativePath;
    }

    for (const root of this.orderedRoots) {
      if (root === this.primaryRoot) continue;
      const rootRelativePath = relativizePath(normalizedAbsolutePath, root.path);
      if (rootRelativePath === undefined) continue;
      if (!root.clipboardLabel || root.hasAmbiguousLabel) return normalizedAbsolutePath;
      return rootRelativePath ? `${root.clipboardLabel}/${rootRelativePath}` : root.clipboardLabel;
    }

    return normalizedAbsolutePath;
  }

  resolveWriteTarget(rawPath: string): RestoreTargetResolution {
    const absoluteCandidate = this.absoluteRootCandidate(rawPath);
    if (absoluteCandidate) {
      return this.resolveWriteCandidate(absoluteCandidate, absoluteCandidate.rootRelativePath);
    }

    const suffixCandidate = this.crossMachineSuffixCandidate(rawPath);
    if (suffixCandidate) {
      return this.resolveWriteCandidate(suffixCandidate, suffixCandidate.rootRelativePath);
    }

    const relativePath = this.toRelativeProjectPath(rawPath);
    if (!relativePath) {
      return { ok: false, reason: 'unsafe path' };
    }

    const explicitCandidates = this.explicitRootLabelCandidates(relativePath);
    if (explicitCandidates.length > 1) {
      return ambiguous(relativePath, explicitCandidates);
    }
    if (explicitCandidates.length === 1) {
      const candidate = explicitCandidates[0];
      return this.resolveWriteCandidate(candidate, candidate.rootRelativePath);
    }

    const targetCandidates = this.legacyTargetCandidates(relativePath);
    if (targetCandidates.length === 0) {
      return { ok: false, reason: 'outside workspace', relativePath };
    }

    const existingCandidates = targetCandidates.filter(candidate => isExistingFile(candidate.target));
    const primaryExisting = existingCandidates.find(candidate => candidate.root.isPrimary);
    const otherExisting = existingCandidates.filter(candidate => !candidate.root.isPrimary);

    if (primaryExisting && otherExisting.length > 0 && !this.hasNestedRootPrefix(relativePath)) {
      return ambiguous(relativePath, [primaryExisting, ...otherExisting]);
    }
    if (primaryExisting) {
      return this.resolveWriteCandidate(primaryExisting, relativePath);
    }
    if (otherExisting.length > 1) {
      return ambiguous(relativePath, otherExisting);
    }
    if (otherExisting.length === 1) {
      return this.resolveWriteCandidate(otherExisting[0], relativePath);
    }

    if (!this.primaryRoot) {
      return { ok: false, reason: 'outside workspace', relativePath };
    }
    return this.resolveWriteCandidate({
      root: this.primaryRoot,
      target: path.resolve(this.primaryRoot.path, relativePath),
      rootRelativePath: relativePath
    }, relativePath, false);
  }

  private resolveDeleteCandidate(
    candidate: TargetCandidate,
    relativePath: string
  ): RestoreTargetResolution {
    if (escapesAllRoots(this.orderedRoots.map(root => root.path), candidate.target)) {
      return { ok: false, reason: 'unsafe path', relativePath };
    }
    return resolvedTarget(candidate, relativePath, true);
  }

  resolveDeleteTarget(rawPath: string): RestoreTargetResolution {
    const absoluteCandidate = this.absoluteRootCandidate(rawPath);
    if (absoluteCandidate) {
      return isExistingFile(absoluteCandidate.target)
        ? this.resolveDeleteCandidate(absoluteCandidate, absoluteCandidate.rootRelativePath)
        : { ok: false, reason: 'missing path', relativePath: absoluteCandidate.rootRelativePath };
    }

    const suffixCandidate = this.crossMachineSuffixCandidate(rawPath);
    if (suffixCandidate) {
      return isExistingFile(suffixCandidate.target)
        ? this.resolveDeleteCandidate(suffixCandidate, suffixCandidate.rootRelativePath)
        : { ok: false, reason: 'missing path', relativePath: suffixCandidate.rootRelativePath };
    }

    const relativePath = this.toRelativeProjectPath(rawPath);
    if (!relativePath) {
      return { ok: false, reason: 'unsafe path' };
    }

    const explicitCandidates = this.explicitRootLabelCandidates(relativePath);
    if (explicitCandidates.length > 1) {
      return ambiguous(relativePath, explicitCandidates);
    }
    if (explicitCandidates.length === 1) {
      const candidate = explicitCandidates[0];
      return isExistingFile(candidate.target)
        ? this.resolveDeleteCandidate(candidate, candidate.rootRelativePath)
        : { ok: false, reason: 'missing path', relativePath: candidate.rootRelativePath };
    }

    const existingCandidates = this.legacyTargetCandidates(relativePath)
      .filter(candidate => isExistingFile(candidate.target));

    if (existingCandidates.length === 0) {
      return { ok: false, reason: 'missing path', relativePath };
    }
    if (existingCandidates.length > 1) {
      return ambiguous(relativePath, existingCandidates);
    }

    return this.resolveDeleteCandidate(existingCandidates[0], relativePath);
  }

  private toRelativeProjectPath(rawPath: string): string | undefined {
    const normalizedPath = normalizeSystemPath(rawPath);
    if (!normalizedPath) return undefined;

    if (!isAbsolutePath(normalizedPath)) {
      return sanitizeRelativePath(normalizedPath) || undefined;
    }

    if (this.primaryRoot) {
      const primaryRelativePath = relativizePath(normalizedPath, this.primaryRoot.path);
      if (primaryRelativePath) return primaryRelativePath;
    }

    for (const root of this.orderedRoots) {
      if (root === this.primaryRoot) continue;
      const rootRelativePath = relativizePath(normalizedPath, root.path);
      if (!rootRelativePath) continue;
      if (root.clipboardLabel && !root.hasAmbiguousLabel) {
        return `${root.clipboardLabel}/${rootRelativePath}`;
      }
      return rootRelativePath;
    }

    return this.crossMachineSuffixRelativePath(normalizedPath);
  }

  private absoluteRootCandidate(rawPath: string): TargetCandidate | undefined {
    const normalizedPath = normalizeSystemPath(rawPath);
    if (!isAbsolutePath(normalizedPath)) return undefined;

    for (const root of this.orderedRoots) {
      const rootRelativePath = relativizePath(normalizedPath, root.path);
      if (rootRelativePath === undefined) continue;
      return {
        root,
        target: path.resolve(root.path, rootRelativePath),
        rootRelativePath
      };
    }

    return undefined;
  }

  private explicitRootLabelCandidates(relativePath: string): TargetCandidate[] {
    const firstSegment = relativePath.split('/')[0];
    const rootRelativePath = relativePath.includes('/') ? relativePath.slice(firstSegment.length + 1) : '';
    if (!firstSegment || !rootRelativePath) return [];

    const candidates: TargetCandidate[] = [];
    if (this.primaryReservedLabels.has(firstSegment) && this.primaryRoot) {
      candidates.push({
        root: this.primaryRoot,
        target: path.resolve(this.primaryRoot.path, relativePath),
        rootRelativePath: relativePath
      });
    }

    for (const root of this.orderedRoots) {
      if (root.clipboardLabel !== firstSegment) continue;
      candidates.push({
        root,
        target: path.resolve(root.path, rootRelativePath),
        rootRelativePath
      });
    }

    return distinctBy(candidates, candidate => pathKey(candidate.target));
  }

  private legacyTargetCandidates(relativePath: string): TargetCandidate[] {
    return distinctBy(
      this.rootsPrimaryFirst().map(root => ({
        root,
        target: path.resolve(root.path, relativePath),
        rootRelativePath: relativePath
      })),
      candidate => pathKey(candidate.target)
    );
  }

  private rootsPrimaryFirst(): RootEntry[] {
    return distinctBy([
      ...(this.primaryRoot ? [this.primaryRoot] : []),
      ...this.orderedRoots.filter(root => root !== this.primaryRoot)
    ], root => pathKey(root.path));
  }

  private hasNestedRootPrefix(relativePath: string): boolean {
    const firstSegment = relativePath.split('/')[0];
    if (!firstSegment) return false;
    return this.orderedRoots
      .filter(root => root !== this.primaryRoot)
      .map(root => path.basename(root.path))
      .some(rootName => segmentsMatch(rootName, firstSegment, isWindowsStylePath(relativePath)));
  }

  /**
   * The suffix match already determines a UNIQUE target root. Returning only a relative
   * path threw that away, so the caller resolved it against the PRIMARY root: an external
   * root's file was written over the primary repo's same-named file and the real target
   * was never created. Both resolvers take this candidate; the string form stays in
   * toRelativeProjectPath for its own label and ambiguity fallbacks.
   */
  private crossMachineSuffixCandidate(rawPath: string): TargetCandidate | undefined {
    // Absolute only — this is the "payload came from another machine" fallback. Without
    // the guard an ordinary relative path whose first segment happens to be a root name
    // short-circuits the explicit-label and restore-base logic (Kotlin guards on it).
    const absolutePath = normalizeSystemPath(rawPath);
    if (!absolutePath || !isAbsolutePath(absolutePath)) return undefined;
    const segments = absolutePath.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '').split('/').filter(Boolean);
    const candidates: TargetCandidate[] = [];
    const windowsStylePath = isWindowsStylePath(absolutePath) ||
      this.orderedRoots.some(root => isWindowsStylePath(root.path));

    for (const root of this.orderedRoots) {
      const rootName = path.basename(root.path);
      if (!rootName) continue;
      for (let index = 0; index < segments.length - 1; index++) {
        if (!segmentsMatch(segments[index], rootName, windowsStylePath)) continue;
        const relativePath = sanitizeRelativePath(segments.slice(index + 1).join('/'));
        if (!relativePath) continue;
        candidates.push({
          root,
          target: path.resolve(root.path, relativePath),
          rootRelativePath: relativePath
        });
      }
    }

    const targetKeys = new Set(candidates.map(candidate => pathKey(candidate.target)));
    if (targetKeys.size !== 1) return undefined;
    return candidates.find(candidate => candidate.root.isPrimary) ?? candidates[0];
  }

  private crossMachineSuffixRelativePath(absolutePath: string): string | undefined {
    const winner = this.crossMachineSuffixCandidate(absolutePath);
    if (!winner) return undefined;
    if (!winner.root.isPrimary && winner.root.clipboardLabel && !winner.root.hasAmbiguousLabel) {
      return `${winner.root.clipboardLabel}/${winner.rootRelativePath}`;
    }
    return winner.rootRelativePath;
  }

  private resolveWriteCandidate(
    candidate: TargetCandidate,
    relativePath: string,
    existed: boolean = isExistingFile(candidate.target)
  ): RestoreTargetResolution {
    if (escapesAllRoots(this.orderedRoots.map(root => root.path), candidate.target)) {
      return { ok: false, reason: 'unsafe path', relativePath };
    }
    return resolvedTarget(candidate, relativePath, existed);
  }
}

function resolvedTarget(
  candidate: TargetCandidate,
  relativePath: string,
  existed: boolean = isExistingFile(candidate.target)
): ResolvedRestoreTarget {
  return {
    ok: true,
    relativePath,
    absolutePath: normalizeSystemPath(candidate.target),
    rootPath: normalizeSystemPath(candidate.root.path),
    existed
  };
}

function ambiguous(relativePath: string, candidates: TargetCandidate[]): RejectedRestoreTarget {
  return {
    ok: false,
    reason: 'ambiguous path',
    relativePath,
    candidates: distinctBy(candidates.map(candidate => normalizeSystemPath(candidate.target)), pathKey)
  };
}

function sanitizeRelativePath(value: string): string | undefined {
// asciiTrim, not String.trim(): the two stdlibs disagree on U+001C-U+001F and U+FEFF, and
// here that disagreement decided the FILENAME each tool wrote — `// file: a.txt\u001C`
// restored as `a.txt` in one and `a.txt\u001C` in the other. The parsers were aligned
// first; without this the divergence just moved one layer down.
  const normalized = asciiTrim(value).replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized || isAbsolutePath(normalized)) return undefined;
  const segments = normalized.split('/').filter(segment => segment && segment !== '.');
  if (segments.length === 0) return undefined;
  if (segments.some(segment => segment === '..' || /[<>:"|?*]/.test(segment))) return undefined;
  return segments.join('/');
}

function normalizeSystemPath(value: string): string {
  return trimTrailingSlash(asciiTrim(value).replaceAll('\\', '/').replace(/\/+/g, '/'));
}

function trimTrailingSlash(value: string): string {
  if (value === '/') return value;
  if (/^[A-Za-z]:\/$/.test(value)) return value;
  return value.replace(/\/+$/g, '');
}

function relativizePath(absolutePath: string, rootPath: string): string | undefined {
  const normalizedAbsolutePath = normalizeSystemPath(absolutePath);
  const normalizedRootPath = normalizeSystemPath(rootPath);
  const absoluteKey = pathKey(normalizedAbsolutePath);
  const rootKey = pathKey(normalizedRootPath);
  if (absoluteKey === rootKey) return '';
  if (!absoluteKey.startsWith(`${rootKey}/`)) return undefined;
  return sanitizeRelativePath(normalizedAbsolutePath.slice(normalizedRootPath.length + 1));
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isUnderRoot(value: string, root: string): boolean {
  const valueKey = pathKey(value);
  const rootKey = pathKey(root);
  return valueKey !== rootKey && valueKey.startsWith(`${rootKey}/`);
}

function pathKey(value: string): string {
  const normalized = normalizeSystemPath(value);
  return isWindowsStylePath(normalized) ? normalized.toLowerCase() : normalized;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:(\/.*)?$/.test(value);
}

function segmentsMatch(left: string, right: string, windowsStylePath: boolean): boolean {
  return windowsStylePath ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * True when the target's REAL location is no longer inside any workspace root — i.e. a
 * directory symlink inside the workspace points out of it. Deletion had no check at all,
 * so `[DELETED] link/keep.txt` really removed a file outside the workspace; writes refused
 * ANY symlink component, which locked out every pnpm-style workspace and disagreed with
 * IntelliJ. Containment is the property that matters: it stops the escape without refusing
 * links that stay inside. Both sides of the ROOT are resolved too — a workspace reached
 * through a symlinked path (macOS /var and /tmp, automounted homes) would otherwise read
 * as an escape from itself and refuse everything. Mirror of
 * ClipboardPathResolver.escapesAllRoots.
 */
export function escapesAllRoots(roots: string[], targetPath: string): boolean {
  const real = containmentTarget(targetPath);
  // undefined means containment could not be established — refuse. Failing OPEN here is
  // how a 42-level path stepped over the symlink above it and wrote outside the workspace.
  if (real === undefined) return true;
  return !roots.map(realOrSelf).some(root => isContained(real, root));
}

/**
 * Containment on NATIVE paths, via path.relative — never on slash-normalised strings.
 * normalizeSystemPath rewrites `\` to `/`, which is right for clipboard paths and wrong
 * here: a backslash is an ordinary filename character on POSIX, so a real sibling
 * directory named `repo\outside` was rewritten into `repo/outside` and read as being
 * inside `repo`. The write then landed in the sibling.
 */
function isContained(realTarget: string, realRoot: string): boolean {
  const relative = path.relative(realRoot, realTarget);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Where this path REALLY lands, with every symlink on it resolved, or `undefined` when
 * that cannot be established.
 *
 * realpath does the whole job when the path exists, and the kernel is the only thing that
 * gets symlink resolution right. When it does not exist — a file about to be created — the
 * deepest existing ancestor is resolved and the remaining names appended, and the first
 * name below it, which may be a DANGLING symlink, is read relative to that RESOLVED parent.
 *
 * Three things here were each wrong once. Skipping the leaf link meant
 * `[DELETED] link/keep.txt` really removed a file outside the workspace. Resolving the
 * link text against the path we walked IN by — rather than against the link's real parent
 * — fabricated an in-workspace answer whenever a directory symlink was on the way in.
 * And counting MISSING ANCESTORS against a fixed budget meant a path with more missing
 * levels than the budget gave up before reaching the link above them, and gave up by
 * ALLOWING: 42 nonexistent directories under an escaping link wrote a whole tree outside
 * the workspace. The ancestor walk is therefore unbounded — it terminates at the
 * filesystem root on its own — and only symlink HOPS are capped, because only they can
 * cycle.
 */
function containmentTarget(targetPath: string, hops = 0): string | undefined {
  const target = path.resolve(targetPath);
  try {
    return realpathSync(target);
  } catch {
    // Does not exist yet — resolve what does.
  }
  if (hops > 40) return undefined; // pathological symlink nest: cannot establish, so refuse

  const missing: string[] = [];
  let probe = target;
  for (;;) {
    const parent = path.dirname(probe);
    // Nothing on the path exists at all — not even a root — so there is no symlink to
    // traverse and nothing to escape through.
    if (!parent || parent === probe) return target;
    missing.unshift(path.basename(probe));
    probe = parent;
    let realProbe: string;
    try {
      realProbe = realpathSync(probe);
    } catch {
      continue;
    }
    // Only the FIRST name below the deepest existing ancestor can be a dangling symlink;
    // anything deeper does not exist at all.
    const first = path.join(realProbe, missing[0]);
    try {
      if (lstatSync(first).isSymbolicLink()) {
        const linked = path.resolve(realProbe, readlinkSync(first));
        return containmentTarget(path.join(linked, ...missing.slice(1)), hops + 1);
      }
    } catch {
      // Not a link, or unreadable — the appended names are the answer.
    }
    return path.join(realProbe, ...missing);
  }
}

function realOrSelf(value: string): string {
  return containmentTarget(value) ?? path.resolve(value);
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function distinctBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const itemKey = key(value);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    result.push(value);
  }
  return result;
}
