import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import FileTreeBrowser from '../FileTreeBrowser.svelte';

interface TreeEntry { mode: string; type: 'blob' | 'tree'; hash: string; name: string; }

function deliverTree(entries: TreeEntry[]) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'lsTreeData', payload: { entries } },
  }));
}

function entry(name: string, type: 'blob' | 'tree' = 'blob'): TreeEntry {
  return { mode: '100644', type, hash: 'h', name };
}

beforeEach(() => {
  globalThis.__postedMessages = [];
});

describe('FileTreeBrowser', () => {
  it('requests root tree on mount', () => {
    render(FileTreeBrowser, { commitHash: 'aaa1234' });
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'lsTree'
    );
    expect(req).toBeDefined();
    const p = (req!.data as { payload: { ref: string; path?: string } }).payload;
    expect(p.ref).toBe('aaa1234');
    expect(p.path).toBeUndefined();
  });

  it('clicking a tree entry posts a new lsTree with the subpath', async () => {
    const { container } = render(FileTreeBrowser, { commitHash: 'aaa1234' });
    deliverTree([entry('src', 'tree')]);
    await waitFor(() => container.querySelector('.tree-item'));
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.tree-item')!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'lsTree'
    );
    expect((req!.data as { payload: { path: string } }).payload.path).toBe('src');
  });

  it('clicking a blob entry posts openDiff with the file path', async () => {
    const { container } = render(FileTreeBrowser, { commitHash: 'aaa1234' });
    deliverTree([entry('README.md')]);
    await waitFor(() => container.querySelector('.tree-item'));
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.tree-item')!);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'openDiff'
    );
    expect(req).toBeDefined();
    const p = (req!.data as { payload: { file: string; commitHash: string } }).payload;
    expect(p.file).toBe('README.md');
    expect(p.commitHash).toBe('aaa1234');
  });

  it('navigateUp returns to parent and root button resets path', async () => {
    const { container } = render(FileTreeBrowser, { commitHash: 'aaa1234' });
    deliverTree([entry('src', 'tree')]);
    await waitFor(() => container.querySelector('.tree-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.tree-item')!);
    deliverTree([entry('app.ts')]);
    await waitFor(() => container.querySelector('.tree-path')?.textContent === 'src');
    // Now an "up" button appears
    const upBtn = container.querySelectorAll<HTMLButtonElement>('.nav-btn')[1];
    expect(upBtn).toBeDefined();
    await fireEvent.click(upBtn);
    await waitFor(() => container.querySelector('.tree-path')?.textContent === '/');
  });

  it('Root button (/) resets path when not already at root', async () => {
    const { container } = render(FileTreeBrowser, { commitHash: 'aaa1234' });
    deliverTree([entry('src', 'tree')]);
    await waitFor(() => container.querySelector('.tree-item'));
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.tree-item')!);
    deliverTree([entry('app.ts')]);
    await waitFor(() => container.querySelector('.tree-path')?.textContent === 'src');
    // Root button is the first .nav-btn
    const rootBtn = container.querySelector<HTMLButtonElement>('.nav-btn')!;
    expect(rootBtn.disabled).toBe(false);
    globalThis.__postedMessages = [];
    await fireEvent.click(rootBtn);
    const req = globalThis.__postedMessages.find(
      (m) => (m.data as { type?: string }).type === 'lsTree'
    );
    expect((req!.data as { payload: { path?: string } }).payload.path).toBeUndefined();
  });

  it('shows the empty-directory message when entries array is empty', async () => {
    const { container } = render(FileTreeBrowser, { commitHash: 'aaa1234' });
    deliverTree([]);
    await waitFor(() => {
      expect(container.querySelector('.tree-empty')).not.toBeNull();
    });
  });
});
