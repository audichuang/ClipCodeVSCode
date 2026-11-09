import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { mapInOrder } from './concurrency.js';
import { deleteFile, holdsBytes, mustNotOverwrite, pathExists, writeBytesFile, writeTextFile } from './fileSystem.js';
import { asciiTrim } from './clipboardFormat.js';
import { parseBody } from './nonText.js';
import { escapesAllRoots, resolveDeleteTarget, resolveWriteTarget } from './pathResolver.js';

export interface RestoreEntry {
  path: string;
  content: string;
  changeTypes: Set<string>;
  /** A text body whose first non-blank line is placeholder-shaped (the parser removed its escape). */
  escapedPlaceholder?: true;
}

/** The bytes of a non-text entry, length and SHA-256 already verified. */
export interface NonTextWrite {
  bytes: Uint8Array;
  /** The target held exactly these bytes when the plan was made. */
  identical: boolean;
}

export interface CreateOperation {
  relativePath: string;
  absolutePath: string;
  /** The text to write; empty for a non-text entry, whose bytes are in `nonText`. */
  content: string;
  existed: boolean;
  /** The root this target was validated against — re-checked immediately before writing. */
  rootPath: string;
  /** Present only for a non-text entry: written as is instead of `content`. */
  nonText?: NonTextWrite;
}

export interface DeleteOperation {
  relativePath: string;
  absolutePath: string;
}

export interface SkippedOperation {
  rawPath: string;
  relativePath?: string;
  reason: SkipReason;
}

/**
 * NON_UTF8_TARGET: the file on disk is not UTF-8. Writing UTF-8 over it would change its
 * encoding silently — the wire carries none, so we cannot put back what was there.
 * CORRUPT_NON_TEXT: a non-text entry whose Base64 does not decode strictly, or whose size or
 * SHA-256 differs from its placeholder line.
 * TARGET_NOT_FILE: the target exists and is not a regular file (a directory).
 * PARENT_NOT_FOLDER: one of the target's parent paths is an existing file.
 * TARGET_COLLISION: two or more entries name the same file through different spellings
 * (letter case on a case-insensitive volume, a symlinked folder): every one is skipped.
 */
export type SkipReason =
  | 'ALREADY_ABSENT'
  | 'UNRESOLVED_PATH'
  | 'AMBIGUOUS_PATH'
  | 'PLACEHOLDER_BODY'
  | 'NON_UTF8_TARGET'
  | 'CORRUPT_NON_TEXT'
  | 'TARGET_NOT_FILE'
  | 'PARENT_NOT_FOLDER'
  | 'TARGET_COLLISION';

export interface RestorePlan {
  /** Every workspace root the plan was validated against — re-checked before each write. */
  roots: string[];
  createOperations: CreateOperation[];
  deleteOperations: DeleteOperation[];
  skippedOperations: SkippedOperation[];
}

export interface RestoreExecutionResult {
  createdCount: number;
  overwrittenCount: number;
  skippedExistingCount: number;
  /** Non-text targets that already held the pasted bytes: not written. */
  unchangedCount: number;
  deletedCount: number;
  errors: string[];
}

export async function planRestore(workspaceRoot: string | string[], entries: RestoreEntry[]): Promise<RestorePlan> {
  const createOperations: CreateOperation[] = [];
  const deleteOperations: DeleteOperation[] = [];
  const skippedOperations: SkippedOperation[] = [];
  const roots = Array.isArray(workspaceRoot) ? workspaceRoot : [workspaceRoot];

  for (const entry of entries) {
    if (entry.changeTypes.has('DELETED')) {
      const resolution = resolveDeleteTarget(roots, entry.path);
      if (!resolution.ok) {
        const reason = resolution.reason === 'missing path'
          ? 'ALREADY_ABSENT'
          : resolution.reason === 'ambiguous path'
            ? 'AMBIGUOUS_PATH'
            : 'UNRESOLVED_PATH';
        skippedOperations.push({
          rawPath: entry.path,
          // An UNRESOLVED path has no target, so it carries no relative one either — even a
          // path refused for escaping through a symlink, which HAD a candidate. Mirrors
          // RestorePlanBuilder (pinned by the shared restoreCases).
          relativePath: reason === 'UNRESOLVED_PATH' ? undefined : resolution.relativePath,
          reason
        });
        continue;
      }

      deleteOperations.push({
        relativePath: resolution.relativePath,
        absolutePath: resolution.absolutePath
      });
      continue;
    }

    // Before the generic guard: the non-text placeholder starts like any other placeholder,
    // which is what makes an older reader skip it. A text file whose first line is
    // placeholder-shaped arrives escaped (escapedPlaceholder): restored as text, neither
    // decoded nor skipped. Mirror of OpenIDEA restore.rs plan_restore.
    const parsed = entry.escapedPlaceholder ? undefined : parseBody(entry.content);
    if (parsed && 'error' in parsed) {
      skippedOperations.push({ rawPath: entry.path, relativePath: undefined, reason: 'CORRUPT_NON_TEXT' });
      continue;
    }
    const bytes = parsed?.bytes;

    if (!bytes && !entry.escapedPlaceholder && isPlaceholderBody(entry.content)) {
      skippedOperations.push({ rawPath: entry.path, relativePath: undefined, reason: 'PLACEHOLDER_BODY' });
      continue;
    }

    const resolution = resolveWriteTarget(roots, entry.path);
    if (!resolution.ok) {
      const ambiguous = resolution.reason === 'ambiguous path';
      skippedOperations.push({
        rawPath: entry.path,
        // See the delete branch: an UNRESOLVED path carries no relative path.
        relativePath: ambiguous ? resolution.relativePath : undefined,
        reason: ambiguous ? 'AMBIGUOUS_PATH' : 'UNRESOLVED_PATH'
      });
      continue;
    }

    // A directory (or another non-file) at the target: this row is skipped, the others go on.
    if (await existsAsNonFile(resolution.absolutePath)) {
      skippedOperations.push({ rawPath: entry.path, relativePath: resolution.relativePath, reason: 'TARGET_NOT_FILE' });
      continue;
    }

    // A file where a parent folder must be: nothing can be created below it.
    if (await parentIsFile(resolution.absolutePath)) {
      skippedOperations.push({ rawPath: entry.path, relativePath: resolution.relativePath, reason: 'PARENT_NOT_FOLDER' });
      continue;
    }

    // Raw bytes are written as is: there is no encoding to preserve.
    if (!bytes && await mustNotOverwrite(resolution.absolutePath)) {
      skippedOperations.push({
        rawPath: entry.path,
        relativePath: resolution.relativePath,
        reason: 'NON_UTF8_TARGET'
      });
      continue;
    }

    const existed = resolution.existed || await pathExists(resolution.absolutePath);
    const operation: CreateOperation = {
      relativePath: resolution.relativePath,
      absolutePath: resolution.absolutePath,
      content: bytes ? '' : entry.content,
      existed,
      rootPath: resolution.rootPath
    };
    if (bytes) operation.nonText = { bytes, identical: existed && await holdsBytes(resolution.absolutePath, bytes) };
    createOperations.push(operation);
  }

  return { roots, createOperations, deleteOperations, skippedOperations };
}

async function existsAsNonFile(filePath: string): Promise<boolean> {
  try {
    return !(await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the nearest existing ancestor of [filePath] is not a folder (an existing file lies
 * where a parent folder is needed). Missing ancestors are fine: the write creates them.
 * Mirror of restore.rs parent_is_file.
 */
async function parentIsFile(filePath: string): Promise<boolean> {
  let current = filePath;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
    try {
      return !(await stat(current)).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') return true;
      if (code !== 'ENOENT') return false;
    }
  }
}

/**
 * The copy side substitutes a one-line comment for a file it could not embed (over the
 * size limit, or unreadable). That comment is not file content: restoring it would replace
 * the real file with a few dozen bytes, and writeTextFile offers no undo. Mirror of
 * RestorePlan.kt isPlaceholderBody — keep the two in step.
 * Producers: clipboardFormat.ts buildPayloadInternal ("File skipped"), gitCopy/graphCopy.
 */
export function isPlaceholderBody(content: string): boolean {
  // The FIRST line, not the whole body. Every producer emits the placeholder as exactly
  // one line, so anything after it is trailing noise — and requiring a single-line body
  // meant any such noise (a configured footer, a stray line from a hand-edited payload)
  // switched the guard off and let a ~50-byte stub overwrite the real file. Testing the
  // first line is receiver-independent: no setting, no sender, no tool can turn it off. The accepted cost: a real file whose FIRST line is one of these three markers is now skipped. `// File skipped: ` is a string this tool invents, but `// Unable to read file content` and `// Error reading file content` are plausible human comments — that part is a real, if narrow, false positive.
  // asciiTrim, not String.trim(): the two stdlibs disagree on U+001C-U+001F and U+FEFF,
  // and here that disagreement decided whether a destructive write happened.
  const body = asciiTrim(content);
  const break_ = body.indexOf('\n');
  const first = asciiTrim(break_ < 0 ? body : body.slice(0, break_));
  return first.startsWith('// File skipped: ') ||
    first === '// Unable to read file content' ||
    first === '// Error reading file content';
}

export async function executeRestorePlan(
  plan: RestorePlan,
  options: { overwriteExisting: boolean; skipExisting: boolean }
): Promise<RestoreExecutionResult> {
  const result: RestoreExecutionResult = {
    createdCount: 0,
    overwrittenCount: 0,
    skippedExistingCount: 0,
    unchangedCount: 0,
    deletedCount: 0,
    errors: []
  };

  // Fan out the per-file existence-check + write; mapInOrder yields outcomes in
  // input order, so folding them keeps counts and error order deterministic.
  // When one op's result depends on another's — two ops on the SAME path
  // (create-then-overwrite/skip), or one path being an ancestor directory of
  // another (writeTextFile auto-creates parent dirs) — fall back to serial for
  // that rare case so the outcome is deterministic; otherwise both would race.
  const paths = plan.createOperations.map(op => op.absolutePath);
  const concurrency = hasPathDependencies(paths) ? 1 : 16;
  // The plan's FULL root set, not just the roots that happen to appear on create ops:
  // narrowing it refused a legitimate multi-root write that plan time had allowed.
  for await (const outcome of mapInOrder(plan.createOperations, concurrency, runCreate(plan.roots, options))) {
    switch (outcome.kind) {
      case 'created': result.createdCount++; break;
      case 'overwritten': result.overwrittenCount++; break;
      case 'skipped': result.skippedExistingCount++; break;
      case 'unchanged': result.unchangedCount++; break;
      case 'error': result.errors.push(outcome.message); break;
    }
  }

  for (const operation of plan.deleteOperations) {
    // Same window, more destructive op: a symlink appearing between plan and execute must
    // not turn a contained target into one outside the workspace.
    if (escapesAllRoots(plan.roots, operation.absolutePath)) {
      result.errors.push(`${operation.relativePath}: unsafe path`);
      continue;
    }
    try {
      if (await pathExists(operation.absolutePath)) {
        await deleteFile(operation.absolutePath);
        result.deletedCount++;
      }
    } catch (error) {
      result.errors.push(`${operation.relativePath}: ${ioErrorText(error)}`);
    }
  }

  return result;
}

// True if any create target equals another, or is an ancestor directory of
// another (e.g. a file at "src" plus a file at "src/a.ts"): those outcomes are
// order-dependent, so the caller serializes them instead of racing. Exported for
// unit testing the boundary logic (e.g. "src" vs "srcfoo" must NOT conflict).
// Keys are case-folded and NFC-normalized: on a case-insensitive volume (macOS, Windows)
// "Config.json" and "config.json" are one file, and racing them interleaved the bytes.
// On a case-sensitive volume this only serializes a little more often.
export function hasPathDependencies(rawPaths: string[]): boolean {
  const paths = rawPaths.map(p => p.normalize('NFC').toLowerCase());
  const set = new Set(paths);
  if (set.size !== paths.length) return true;
  return paths.some(p => {
    for (let i = 0; i < p.length; i++) {
      if ((p[i] === '/' || p[i] === '\\') && set.has(p.slice(0, i))) return true;
    }
    return false;
  });
}

type CreateOutcome =
  | { kind: 'created' | 'overwritten' | 'skipped' | 'unchanged' }
  | { kind: 'error'; message: string };

function runCreate(
  roots: string[],
  options: { overwriteExisting: boolean; skipExisting: boolean }
): (operation: CreateOperation) => Promise<CreateOutcome> {
  return async operation => {
    try {
      // Containment was checked when the plan was built, and the user then clicked through
      // two or three modal dialogs. A symlink that appeared in between turned an allowed
      // target into one outside the workspace, and the write followed it. Re-check at the
      // last possible moment; the plan-time check stays, so a refusal here is only ever a
      // race.
      if (escapesAllRoots(roots, operation.absolutePath)) {
        return { kind: 'error', message: `${operation.relativePath}: unsafe path` };
      }
      // Re-check the encoding too. A plan-time verdict is a verdict on the bytes that were
      // there THEN; the user has clicked through modal dialogs since, and the file may have
      // been replaced in between. Raw non-text bytes have no encoding to preserve.
      const bytes = operation.nonText?.bytes;
      if (!bytes && await mustNotOverwrite(operation.absolutePath)) {
        return { kind: 'skipped' };
      }
      const existing = await existingKind(operation.absolutePath);
      if (existing === 'directory') return { kind: 'skipped' };
      // An identical target needs no overwrite permission: it is reported unchanged.
      if (existing === 'file' && bytes && await holdsBytes(operation.absolutePath, bytes)) return { kind: 'unchanged' };
      if (existing === 'file' && (options.skipExisting || !options.overwriteExisting)) return { kind: 'skipped' };
      if (bytes) await writeBytesFile(operation.absolutePath, bytes);
      else await writeTextFile(operation.absolutePath, operation.content);
      return { kind: existing === 'file' ? 'overwritten' : 'created' };
    } catch (error) {
      return { kind: 'error', message: `${operation.relativePath}: ${ioErrorText(error)}` };
    }
  };
}

async function existingKind(filePath: string): Promise<'file' | 'directory' | undefined> {
  try {
    const info = await stat(filePath);
    return info.isDirectory() ? 'directory' : 'file';
  } catch {
    return undefined;
  }
}

/**
 * What a failed write or delete says to the user (spec "Pasting": never the raw OS message).
 * Mirror of OpenIDEA restore.rs io_error_text — the same texts.
 */
export function ioErrorText(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'EACCES':
    case 'EPERM': return 'Folder is not writable';
    case 'ENOENT': return 'File or folder not found';
    case 'EEXIST': return 'A file or folder already exists at that path';
    case 'ENOTDIR': return 'A file is in the way of its parent folder';
    case 'EISDIR': return 'The target is a folder';
    case 'ENOSPC': return 'The disk is full';
    case 'EROFS': return 'The file system is read-only';
    default: return 'Could not apply the change';
  }
}

/**
 * Two entries whose target paths are spelled differently but name the same file (letter
 * case on a case-insensitive volume such as APFS, or a symlinked folder) cannot both be
 * applied, and neither is preferred: every member of such a group becomes a
 * TARGET_COLLISION skip, creates and deletes alike; the rest of the paste goes on. The
 * same spelling twice is not a collision — it stays planned twice, in order (shared
 * restoreCases). Mirror of OpenIDEA transfer.rs plan_import's target-identity check.
 */
export async function markTargetCollisions(plan: RestorePlan): Promise<RestorePlan> {
  const caseCache = new Map<string, boolean>();
  const groups = new Map<string, Set<string>>();
  const identities = new Map<string, string>();
  for (const absolutePath of [...plan.createOperations, ...plan.deleteOperations].map(op => op.absolutePath)) {
    if (identities.has(absolutePath)) continue;
    const identity = await targetIdentity(absolutePath, caseCache);
    identities.set(absolutePath, identity);
    const spellings = groups.get(identity) ?? new Set<string>();
    spellings.add(absolutePath);
    groups.set(identity, spellings);
  }
  const colliding = (absolutePath: string) => (groups.get(identities.get(absolutePath)!)?.size ?? 0) > 1;
  if (![...identities.keys()].some(colliding)) return plan;

  const skipped: SkippedOperation[] = [];
  const keep = <T extends { relativePath: string; absolutePath: string }>(operations: T[]): T[] =>
    operations.filter(operation => {
      if (!colliding(operation.absolutePath)) return true;
      skipped.push({ rawPath: operation.relativePath, relativePath: operation.relativePath, reason: 'TARGET_COLLISION' });
      return false;
    });
  const createOperations = keep(plan.createOperations);
  const deleteOperations = keep(plan.deleteOperations);
  return { ...plan, createOperations, deleteOperations, skippedOperations: [...plan.skippedOperations, ...skipped] };
}

/**
 * realpath of the nearest existing ancestor plus the remaining segments, lower-cased when
 * that ancestor sits on a case-insensitive volume.
 */
async function targetIdentity(absolutePath: string, caseCache: Map<string, boolean>): Promise<string> {
  const trail: string[] = [];
  let current = absolutePath;
  let resolved: string | undefined;
  for (;;) {
    resolved = await realpath(current).catch(() => undefined);
    if (resolved !== undefined) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    trail.unshift(path.basename(current));
    current = parent;
  }
  const anchor = resolved ?? current;
  const identity = path.join(anchor, ...trail).normalize('NFC');
  let insensitive = caseCache.get(anchor);
  if (insensitive === undefined) {
    insensitive = await isCaseInsensitive(anchor);
    caseCache.set(anchor, insensitive);
  }
  return insensitive ? identity.toLowerCase() : identity;
}

/**
 * Probes the volume holding [existingPath]: the case-swapped spelling of its deepest segment
 * with an ASCII letter resolving to the same inode means case-insensitive. Falls back to the
 * platform default when no segment can be swapped or the probe fails.
 */
async function isCaseInsensitive(existingPath: string): Promise<boolean> {
  const platformDefault = process.platform === 'darwin' || process.platform === 'win32';
  let current = existingPath;
  for (;;) {
    const name = path.basename(current);
    const swapped = swapAsciiCase(name);
    if (swapped !== name) {
      const swappedPath = path.join(path.dirname(current), swapped);
      try {
        const [a, b] = await Promise.all([lstat(current), lstat(swappedPath)]);
        return a.dev === b.dev && a.ino === b.ino;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : platformDefault;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return platformDefault;
    current = parent;
  }
}

function swapAsciiCase(name: string): string {
  return name.replace(/[A-Za-z]/g, c => (c >= 'a' ? c.toUpperCase() : c.toLowerCase()));
}
