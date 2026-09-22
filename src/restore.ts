import { stat } from 'node:fs/promises';
import { mapInOrder } from './concurrency.js';
import { deleteFile, mustNotOverwrite, pathExists, writeTextFile } from './fileSystem.js';
import { asciiTrim } from './clipboardFormat.js';
import { escapesAllRoots, resolveDeleteTarget, resolveWriteTarget } from './pathResolver.js';

export interface RestoreEntry {
  path: string;
  content: string;
  changeTypes: Set<string>;
}

export interface CreateOperation {
  relativePath: string;
  absolutePath: string;
  content: string;
  existed: boolean;
  /** The root this target was validated against — re-checked immediately before writing. */
  rootPath: string;
}

export interface DeleteOperation {
  relativePath: string;
  absolutePath: string;
}

export interface SkippedOperation {
  rawPath: string;
  relativePath?: string;
  /**
   * NON_UTF8_TARGET: the file on disk is not UTF-8. Writing UTF-8 over it would change its
   * encoding silently — the wire carries none, so we cannot put back what was there.
   */
  reason: 'ALREADY_ABSENT' | 'UNRESOLVED_PATH' | 'AMBIGUOUS_PATH' | 'PLACEHOLDER_BODY' | 'NON_UTF8_TARGET';
}

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

    if (isPlaceholderBody(entry.content)) {
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

    if (await mustNotOverwrite(resolution.absolutePath)) {
      skippedOperations.push({
        rawPath: entry.path,
        relativePath: resolution.relativePath,
        reason: 'NON_UTF8_TARGET'
      });
      continue;
    }

    createOperations.push({
      relativePath: resolution.relativePath,
      absolutePath: resolution.absolutePath,
      content: entry.content,
      existed: resolution.existed || await pathExists(resolution.absolutePath),
      rootPath: resolution.rootPath
    });
  }

  return { roots, createOperations, deleteOperations, skippedOperations };
}

/**
 * The copy side substitutes a one-line comment for a file it could not embed (over the
 * size limit, or unreadable). That comment is not file content: restoring it would replace
 * the real file with a few dozen bytes, and writeTextFile offers no undo. Mirror of
 * RestorePlan.kt isPlaceholderBody — keep the two in step.
 * Producers: clipboardFormat.ts buildPayloadInternal ("File skipped"), gitCopy/graphCopy.
 */
function isPlaceholderBody(content: string): boolean {
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
      result.errors.push(`${operation.relativePath}: ${errorMessage(error)}`);
    }
  }

  return result;
}

// True if any create target equals another, or is an ancestor directory of
// another (e.g. a file at "src" plus a file at "src/a.ts"): those outcomes are
// order-dependent, so the caller serializes them instead of racing. Exported for
// unit testing the boundary logic (e.g. "src" vs "srcfoo" must NOT conflict).
export function hasPathDependencies(paths: string[]): boolean {
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
  | { kind: 'created' | 'overwritten' | 'skipped' }
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
      // been replaced in between.
      if (await mustNotOverwrite(operation.absolutePath)) {
        return { kind: 'skipped' };
      }
      const existing = await existingKind(operation.absolutePath);
      if (existing === 'directory') {
        return { kind: 'skipped' };
      } else if (existing === 'file' && options.skipExisting) {
        return { kind: 'skipped' };
      } else if (existing === 'file' && options.overwriteExisting) {
        await writeTextFile(operation.absolutePath, operation.content);
        return { kind: 'overwritten' };
      } else if (existing === 'file') {
        return { kind: 'skipped' };
      } else {
        await writeTextFile(operation.absolutePath, operation.content);
        return { kind: 'created' };
      }
    } catch (error) {
      return { kind: 'error', message: `${operation.relativePath}: ${errorMessage(error)}` };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
