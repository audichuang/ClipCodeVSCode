import { existsSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';

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

  resolveDeleteTarget(rawPath: string): RestoreTargetResolution {
    const absoluteCandidate = this.absoluteRootCandidate(rawPath);
    if (absoluteCandidate) {
      return isExistingFile(absoluteCandidate.target)
        ? resolvedTarget(absoluteCandidate, absoluteCandidate.rootRelativePath, true)
        : { ok: false, reason: 'missing path', relativePath: absoluteCandidate.rootRelativePath };
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
        ? resolvedTarget(candidate, candidate.rootRelativePath, true)
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

    return resolvedTarget(existingCandidates[0], relativePath, true);
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

  private crossMachineSuffixRelativePath(absolutePath: string): string | undefined {
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
    return candidates.find(candidate => candidate.root.isPrimary)?.rootRelativePath ??
      candidates[0]?.rootRelativePath;
  }

  private resolveWriteCandidate(
    candidate: TargetCandidate,
    relativePath: string,
    existed: boolean = isExistingFile(candidate.target)
  ): RestoreTargetResolution {
    if (hasSymlinkComponent(candidate.root.path, candidate.target)) {
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
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (!normalized || isAbsolutePath(normalized)) return undefined;
  const segments = normalized.split('/').filter(segment => segment && segment !== '.');
  if (segments.length === 0) return undefined;
  if (segments.some(segment => segment === '..' || /[<>:"|?*]/.test(segment))) return undefined;
  return segments.join('/');
}

function normalizeSystemPath(value: string): string {
  return trimTrailingSlash(value.trim().replaceAll('\\', '/').replace(/\/+/g, '/'));
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

function hasSymlinkComponent(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;

  const segments = relativePath.split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
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
