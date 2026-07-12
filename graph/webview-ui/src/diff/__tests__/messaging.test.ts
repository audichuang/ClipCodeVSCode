import { describe, it, expect, beforeEach } from 'vitest';
import { diffStore } from '../diff-store.svelte';
import { listenForHostMessages, postStageHunk } from '../messaging';
import { i18n } from '../../lib/i18n/index.svelte';

// NOTE: getVsCodeApi() calls acquireVsCodeApi() once, memoized at module-eval
// time (imports are hoisted above this file's own statements), so it always
// binds to the webview-project setup file's recording stub
// (webview-ui/src/__tests__/setup.ts), never a locally-reassigned one — the
// same reason every other webview test that asserts posted messages
// (ImageDiff.test.ts, PrView.test.ts, ...) reads `globalThis.__postedMessages`
// instead of installing its own acquireVsCodeApi spy.
beforeEach(() => {
  diffStore.reset();
  globalThis.__postedMessages = [];
});

describe('diff messaging', () => {
  it('diffShow populates the store', () => {
    listenForHostMessages();
    const diff = { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] };
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', diff } },
    }));
    expect(diffStore.file).toBe('src/a.ts');
    expect(diffStore.side).toBe('unstaged');
  });

  it('setLocale switches the i18n locale', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'setLocale', payload: { locale: 'zh-cn' } },
    }));
    expect(i18n.locale).toBe('zh');
  });

  it('postStageHunk posts diffStageHunk with the current file + side', () => {
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageHunk(2);
    expect(globalThis.__postedMessages).toContainEqual({
      data: {
        type: 'diffStageHunk',
        payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 2 },
      },
    });
  });

  it('an error message for diffStageHunk sets store.error', () => {
    listenForHostMessages();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.error).toBe('nope');
  });

  it('postStageHunk sets busy and ignores a second call until unlocked', () => {
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageHunk(0);
    expect(diffStore.busy).toBe(true);
    postStageHunk(1); // dropped: a hunk op is already in flight
    expect(globalThis.__postedMessages).toHaveLength(1);
    expect(globalThis.__postedMessages).toContainEqual({
      data: {
        type: 'diffStageHunk',
        payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', hunkIndex: 0 },
      },
    });
  });

  it('diffShow clears busy so the next stage click is allowed again', () => {
    listenForHostMessages();
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageHunk(0);
    expect(diffStore.busy).toBe(true);
    const diff = { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] };
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'diffShow', payload: { repoPath: '/r', file: 'src/a.ts', side: 'unstaged', diff } },
    }));
    expect(diffStore.busy).toBe(false);
  });

  it('an error reply also clears busy', () => {
    listenForHostMessages();
    diffStore.setDiff('/r', 'src/a.ts', 'unstaged', { file: 'src/a.ts', isBinary: false, isImage: false, hunks: [] });
    postStageHunk(0);
    expect(diffStore.busy).toBe(true);
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'error', payload: { source: 'diffStageHunk', message: 'nope' } },
    }));
    expect(diffStore.busy).toBe(false);
  });
});
