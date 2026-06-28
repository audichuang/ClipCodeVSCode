import type { ChangeTypeLabel } from './clipboardFormat.js';

export const DELETED_FILE_MARKER = '// This file has been deleted in this change';

const NEW_STATUSES = new Set([1, 4, 7, 9]);
const DELETED_STATUSES = new Set([2, 6, 14, 15, 17]);
const MOVED_STATUSES = new Set([3, 10]);

const NEW_STATUS_NAMES = new Set([
  'INDEX_ADDED',
  'INDEX_COPIED',
  'UNTRACKED',
  'INTENT_TO_ADD',
  'ADDED',
  'COPIED',
  'NEW',
  'A',
  'C'
]);

const DELETED_STATUS_NAMES = new Set([
  'INDEX_DELETED',
  'DELETED',
  'DELETED_BY_US',
  'DELETED_BY_THEM',
  'BOTH_DELETED',
  'D'
]);

const MOVED_STATUS_NAMES = new Set([
  'INDEX_RENAMED',
  'INTENT_TO_RENAME',
  'RENAMED',
  'MOVED',
  'R'
]);

const STAGED_STATUSES = new Set([0, 1, 2, 3, 4]);
const STAGED_STATUS_NAMES = new Set([
  'INDEX_MODIFIED',
  'INDEX_ADDED',
  'INDEX_DELETED',
  'INDEX_RENAMED',
  'INDEX_COPIED'
]);

export function mapGitStatusToChangeType(status: unknown): ChangeTypeLabel {
  const numeric = numericStatus(status);
  if (numeric !== undefined) {
    if (NEW_STATUSES.has(numeric)) return 'NEW';
    if (DELETED_STATUSES.has(numeric)) return 'DELETED';
    if (MOVED_STATUSES.has(numeric)) return 'MOVED';
    return 'MODIFIED';
  }

  const name = stringStatus(status);
  if (name !== undefined) {
    if (NEW_STATUS_NAMES.has(name)) return 'NEW';
    if (DELETED_STATUS_NAMES.has(name)) return 'DELETED';
    if (MOVED_STATUS_NAMES.has(name)) return 'MOVED';
  }

  return 'MODIFIED';
}

export function isStagedGitStatus(status: unknown): boolean {
  const numeric = numericStatus(status);
  if (numeric !== undefined) return STAGED_STATUSES.has(numeric);

  const name = stringStatus(status);
  return name !== undefined && STAGED_STATUS_NAMES.has(name);
}

function numericStatus(status: unknown): number | undefined {
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function stringStatus(status: unknown): string | undefined {
  return typeof status === 'string'
    ? status.trim().replace(/[\s-]+/g, '_').toUpperCase()
    : undefined;
}
