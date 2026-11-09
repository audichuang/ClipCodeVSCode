import type { RestoreExecutionResult, RestorePlan, SkipReason } from './restore.js';

// User text for Paste & Restore (spec non-text-files.md, "Pasting"): reasons are never shown
// as raw codes, a non-text row is "non-text file · <size>", counts read right for 1.

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  ALREADY_ABSENT: 'Already absent',
  UNRESOLVED_PATH: 'Path could not be placed in this workspace',
  AMBIGUOUS_PATH: 'Path matches more than one workspace folder',
  PLACEHOLDER_BODY: 'Not copied by the sender',
  NON_UTF8_TARGET: 'Existing file is not UTF-8; not overwritten',
  CORRUPT_NON_TEXT: 'Corrupt non-text file',
  TARGET_NOT_FILE: 'The target is a folder',
  PARENT_NOT_FOLDER: 'A file is in the way of its parent folder',
  TARGET_COLLISION: 'Another entry writes the same file (letter case)'
};

/** Paths listed per reason or category before "and N more". */
const PATHS_PER_LINE = 3;

export function skipReasonText(reason: SkipReason): string {
  return SKIP_REASON_TEXT[reason];
}

/** "4.0 KB"-style raw size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function pathList(paths: string[]): string {
  const shown = paths.slice(0, PATHS_PER_LINE).join(', ');
  return paths.length > PATHS_PER_LINE ? `${shown} and ${paths.length - PATHS_PER_LINE} more` : shown;
}

/** Create operations whose target exists and would change: the overwrites that need permission. */
export function existingTargets(plan: RestorePlan): number {
  return plan.createOperations.filter(op => op.existed && !op.nonText?.identical).length;
}

/** One line per skip reason, a few paths each. */
export function skipLines(plan: RestorePlan): string[] {
  const byReason = new Map<SkipReason, string[]>();
  for (const op of plan.skippedOperations) {
    const paths = byReason.get(op.reason) ?? [];
    paths.push(op.relativePath ?? op.rawPath);
    byReason.set(op.reason, paths);
  }
  return [...byReason].map(([reason, paths]) => `${skipReasonText(reason)}: ${pathList(paths)}`);
}

/** The Proceed modal: a one-line message and a detail with one category per line. */
export function confirmationText(plan: RestorePlan): { message: string; detail: string } {
  const unchanged = plan.createOperations.filter(op => op.existed && op.nonText?.identical);
  const create = plan.createOperations.filter(op => !op.existed).length;
  const overwrite = existingTargets(plan);
  const message = `Snipcode will create ${create}, overwrite ${overwrite}, delete ${plan.deleteOperations.length}, ` +
    `and skip ${plan.skippedOperations.length} operation(s).`;
  const lines: string[] = [];
  const nonText = plan.createOperations.filter(op => op.nonText);
  if (nonText.length > 0) {
    const total = nonText.reduce((sum, op) => sum + op.nonText!.bytes.length, 0);
    lines.push(`Non-text files: ${nonText.length} (${formatSize(total)})`);
  }
  if (unchanged.length > 0) {
    lines.push(`Unchanged (identical bytes already there): ${unchanged.length} (${pathList(unchanged.map(op => op.relativePath))})`);
  }
  lines.push(...skipLines(plan));
  return { message, detail: lines.join('\n') };
}

/** The completion notice. A row that failed while writing counts as skipped too. */
export function resultNotice(plan: RestorePlan, result: RestoreExecutionResult): string {
  const skipped = plan.skippedOperations.length + result.skippedExistingCount + result.errors.length;
  const parts = [
    result.createdCount > 0 ? `Created ${result.createdCount}` : '',
    result.overwrittenCount > 0 ? `Overwritten ${result.overwrittenCount}` : '',
    result.unchangedCount > 0 ? `Unchanged ${result.unchangedCount}` : '',
    skipped > 0 ? `Skipped ${skipped}` : '',
    result.deletedCount > 0 ? `Deleted ${result.deletedCount}` : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'No files changed.';
}
