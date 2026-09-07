// SNIPCODE-HOOK: whole-file — S14 Ctrl/Cmd+Enter commit shortcut.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Workbench from '../Workbench.svelte';
import { workbenchStore } from '../workbench-store.svelte';

beforeEach(() => {
  workbenchStore.reset();
  globalThis.__postedMessages = [];
});

describe('Workbench.svelte — Ctrl/Cmd+Enter commits from the textarea (S14)', () => {
  it('Ctrl+Enter posts a commit when there is a message to commit', async () => {
    render(Workbench);
    const textarea = document.querySelector('textarea')!;
    workbenchStore.message = '修正 bug';
    workbenchStore.commitScopeReady = true;

    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    const posted = globalThis.__postedMessages.map((m) => m.data);
    expect(posted).toContainEqual({ type: 'workbenchCommit', payload: { message: '修正 bug', amend: false } });
  });

  it('Cmd+Enter (metaKey) also commits', async () => {
    render(Workbench);
    const textarea = document.querySelector('textarea')!;
    workbenchStore.message = '修正 bug';
    workbenchStore.commitScopeReady = true;

    await fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

    const posted = globalThis.__postedMessages.map((m) => m.data);
    expect(posted).toContainEqual({ type: 'workbenchCommit', payload: { message: '修正 bug', amend: false } });
  });

  it('does nothing when the message is empty (canCommit is false)', async () => {
    render(Workbench);
    const textarea = document.querySelector('textarea')!;

    await fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    const posted = globalThis.__postedMessages.map((m) => m.data) as Array<{ type: string }>;
    expect(posted.some((p) => p.type === 'workbenchCommit')).toBe(false);
  });

  it('a plain Enter (no modifier) does not commit', async () => {
    render(Workbench);
    const textarea = document.querySelector('textarea')!;
    workbenchStore.message = '修正 bug';
    workbenchStore.commitScopeReady = true;

    await fireEvent.keyDown(textarea, { key: 'Enter' });

    const posted = globalThis.__postedMessages.map((m) => m.data) as Array<{ type: string }>;
    expect(posted.some((p) => p.type === 'workbenchCommit')).toBe(false);
  });
});

/* SNIPCODE-HOOK start: the scope line has three states, and a failed status
   read used to render as the same "Loading…" as a slow one — forever, since
   nothing re-asks until the next refresh. */
describe('Workbench.svelte — commit scope line', () => {
  const scopeText = () => document.querySelector('.commit-scope')!.textContent;

  it('says loading before the first snapshot lands', () => {
    render(Workbench);
    expect(scopeText()).toContain('Loading');
  });

  it('says the read failed instead of loading when it failed', async () => {
    render(Workbench);
    workbenchStore.commitScopeFailed = true;
    await Promise.resolve();
    expect(scopeText()).toContain('Could not read the repository status');
    expect(scopeText()).not.toContain('Loading');
  });

  it('shows the real scope once ready, failure flag or not', async () => {
    render(Workbench);
    workbenchStore.stagedRepoCount = 2;
    workbenchStore.stagedFileCount = 5;
    workbenchStore.commitScopeReady = true;
    await Promise.resolve();
    expect(scopeText()).toContain('2');
    expect(scopeText()).toContain('5');
  });
});
