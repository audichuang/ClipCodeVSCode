import { stat } from 'node:fs/promises';
import { mapInOrder } from './concurrency.js';
import { deleteFile, pathExists, writeTextFile } from './fileSystem.js';
import { resolveDeleteTarget, resolveWriteTarget } from './pathResolver.js';

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
}

export interface DeleteOperation {
  relativePath: string;
  absolutePath: string;
}

export interface SkippedOperation {
  rawPath: string;
  relativePath?: string;
  reason: 'ALREADY_ABSENT' | 'UNRESOLVED_PATH' | 'AMBIGUOUS_PATH';
}

export interface RestorePlan {
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
        skippedOperations.push({
          rawPath: entry.path,
          relativePath: resolution.relativePath,
          reason: resolution.reason === 'missing path'
            ? 'ALREADY_ABSENT'
            : resolution.reason === 'ambiguous path'
              ? 'AMBIGUOUS_PATH'
              : 'UNRESOLVED_PATH'
        });
        continue;
      }

      deleteOperations.push({
        relativePath: resolution.relativePath,
        absolutePath: resolution.absolutePath
      });
      continue;
    }

    const resolution = resolveWriteTarget(roots, entry.path);
    if (!resolution.ok) {
      skippedOperations.push({
        rawPath: entry.path,
        relativePath: resolution.relativePath,
        reason: resolution.reason === 'ambiguous path' ? 'AMBIGUOUS_PATH' : 'UNRESOLVED_PATH'
      });
      continue;
    }

    createOperations.push({
      relativePath: resolution.relativePath,
      absolutePath: resolution.absolutePath,
      content: entry.content,
      existed: resolution.existed || await pathExists(resolution.absolutePath)
    });
  }

  return { createOperations, deleteOperations, skippedOperations };
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
  for await (const outcome of mapInOrder(plan.createOperations, concurrency, runCreate(options))) {
    switch (outcome.kind) {
      case 'created': result.createdCount++; break;
      case 'overwritten': result.overwrittenCount++; break;
      case 'skipped': result.skippedExistingCount++; break;
      case 'error': result.errors.push(outcome.message); break;
    }
  }

  for (const operation of plan.deleteOperations) {
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
  options: { overwriteExisting: boolean; skipExisting: boolean }
): (operation: CreateOperation) => Promise<CreateOutcome> {
  return async operation => {
    try {
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
