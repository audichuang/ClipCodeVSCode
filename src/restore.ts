import { stat } from 'node:fs/promises';
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

  for (const operation of plan.createOperations) {
    try {
      const existing = await existingKind(operation.absolutePath);
      if (existing === 'directory') {
        result.skippedExistingCount++;
      } else if (existing === 'file' && options.skipExisting) {
        result.skippedExistingCount++;
      } else if (existing === 'file' && options.overwriteExisting) {
        await writeTextFile(operation.absolutePath, operation.content);
        result.overwrittenCount++;
      } else if (existing === 'file') {
        result.skippedExistingCount++;
      } else {
        await writeTextFile(operation.absolutePath, operation.content);
        result.createdCount++;
      }
    } catch (error) {
      result.errors.push(`${operation.relativePath}: ${errorMessage(error)}`);
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
