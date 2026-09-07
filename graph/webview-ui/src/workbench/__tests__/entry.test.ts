import { describe, expect, it, vi } from 'vitest';

describe('workbench entry view isolation', () => {
  it('mounts the recent graph with one VS Code API acquisition', async () => {
    const original = (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi;
    let acquisitions = 0;
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => {
      acquisitions++;
      return original();
    };
    document.body.dataset.view = 'recent-commits';
    const target = document.createElement('div');
    target.id = 'workbench-app';
    document.body.appendChild(target);
    vi.resetModules();

    await import('../../workbench');

    expect(acquisitions).toBe(1);
    expect(globalThis.__postedMessages.map(message => (message.data as { type?: string }).type)).toContain('recentCommitsReady');
    target.remove();
    delete document.body.dataset.view;
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = original;
  });
});
