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
