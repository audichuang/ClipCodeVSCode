import assert from 'node:assert/strict';
import test from 'node:test';
import { isStagedGitStatus, mapGitStatusToChangeType } from '../src/gitCopy.js';

test('maps VS Code Git status enum values to ClipCode labels', () => {
  assert.equal(mapGitStatusToChangeType(1), 'NEW');
  assert.equal(mapGitStatusToChangeType(4), 'NEW');
  assert.equal(mapGitStatusToChangeType(7), 'NEW');
  assert.equal(mapGitStatusToChangeType(9), 'NEW');

  assert.equal(mapGitStatusToChangeType(2), 'DELETED');
  assert.equal(mapGitStatusToChangeType(6), 'DELETED');
  assert.equal(mapGitStatusToChangeType(14), 'DELETED');
  assert.equal(mapGitStatusToChangeType(15), 'DELETED');
  assert.equal(mapGitStatusToChangeType(17), 'DELETED');

  assert.equal(mapGitStatusToChangeType(3), 'MOVED');
  assert.equal(mapGitStatusToChangeType(10), 'MOVED');

  assert.equal(mapGitStatusToChangeType(0), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(5), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(11), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(12), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(13), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(16), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType(18), 'MODIFIED');
});

test('maps Git status names defensively', () => {
  assert.equal(mapGitStatusToChangeType('INDEX_ADDED'), 'NEW');
  assert.equal(mapGitStatusToChangeType('untracked'), 'NEW');
  assert.equal(mapGitStatusToChangeType('index-deleted'), 'DELETED');
  assert.equal(mapGitStatusToChangeType('intent to rename'), 'MOVED');
  assert.equal(mapGitStatusToChangeType('type_changed'), 'MODIFIED');
});

test('detects staged Git statuses', () => {
  assert.equal(isStagedGitStatus(0), true);
  assert.equal(isStagedGitStatus(4), true);
  assert.equal(isStagedGitStatus(5), false);
  assert.equal(isStagedGitStatus('INDEX_RENAMED'), true);
  assert.equal(isStagedGitStatus('MODIFIED'), false);
});

test('mapGitStatusToChangeType maps porcelain single letters', () => {
  assert.equal(mapGitStatusToChangeType('A'), 'NEW');
  assert.equal(mapGitStatusToChangeType('M'), 'MODIFIED');
  assert.equal(mapGitStatusToChangeType('D'), 'DELETED');
  assert.equal(mapGitStatusToChangeType('R'), 'MOVED');
  assert.equal(mapGitStatusToChangeType('C'), 'NEW');
  assert.equal(mapGitStatusToChangeType('U'), 'NEW'); // git-graph-plus untracked working file
});
