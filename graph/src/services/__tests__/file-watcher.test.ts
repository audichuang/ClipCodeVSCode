import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared registry of the fake watchers created during a test, so we can fire
// filesystem events by hand. vi.hoisted keeps it available inside the hoisted
// vi.mock factory below.
const h = vi.hoisted(() => {
  interface FakeWatcher {
    pattern: { pattern: string };
    handlers: Record<'change' | 'create' | 'delete', Array<(uri: unknown) => void>>;
    dispose: ReturnType<typeof vi.fn>;
    fire(kind: 'change' | 'create' | 'delete', uri: unknown): void;
  }
  return { watchers: [] as FakeWatcher[] };
});

vi.mock('vscode', () => {
  class RelativePattern {
    constructor(public base: unknown, public pattern: string) {}
  }
  return {
    RelativePattern,
    Uri: { file: (p: string) => ({ fsPath: p }) },
    Disposable: class { dispose() {} },
    workspace: {
      createFileSystemWatcher: (pattern: { pattern: string }) => {
        const handlers = { change: [], create: [], delete: [] } as Record<'change' | 'create' | 'delete', Array<(uri: unknown) => void>>;
        const w = {
          pattern,
          handlers,
          onDidChange: (cb: (uri: unknown) => void) => { handlers.change.push(cb); return { dispose() {} }; },
          onDidCreate: (cb: (uri: unknown) => void) => { handlers.create.push(cb); return { dispose() {} }; },
          onDidDelete: (cb: (uri: unknown) => void) => { handlers.delete.push(cb); return { dispose() {} }; },
          dispose: vi.fn(),
          fire(kind: 'change' | 'create' | 'delete', uri: unknown) { handlers[kind].forEach(cb => cb(uri)); },
        };
        h.watchers.push(w);
        return w;
      },
    },
  };
});

import { FileWatcher } from '../file-watcher';

const REPO = '/tmp/ggp-fw-test';

function fireOn(patternStr: string, fsPath: string, kind: 'change' | 'create' | 'delete' = 'change') {
  const w = h.watchers.find(w => w.pattern.pattern === patternStr);
  if (!w) throw new Error(`no watcher for pattern ${patternStr}`);
  w.fire(kind, { fsPath });
}

describe('FileWatcher debounce / cooldown / suppress state machine', () => {
  let onChange: ReturnType<typeof vi.fn>;
  let fw: FileWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    h.watchers.length = 0;
    onChange = vi.fn();
    fw = new FileWatcher(REPO, onChange);
  });

  afterEach(() => {
    fw.dispose();
    vi.useRealTimers();
  });

  it('coalesces a burst of events into one onChange after the debounce window', () => {
    fireOn('**', `${REPO}/src/a.ts`);
    fireOn('**', `${REPO}/src/b.ts`);
    fireOn('**', `${REPO}/src/c.ts`);
    vi.advanceTimersByTime(499);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('status');
  });

  it('picks the most significant change type (refs over status)', () => {
    fireOn('**', `${REPO}/src/a.ts`);                  // status
    fireOn('refs/**', `${REPO}/.git/refs/heads/main`); // refs
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('refs');
  });

  it('ignores working-tree changes inside IGNORE_DIRS (e.g. node_modules)', () => {
    fireOn('**', `${REPO}/node_modules/pkg/index.js`);
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fire when disabled', () => {
    fw.enabled = false;
    fireOn('**', `${REPO}/src/a.ts`);
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not fire after dispose, and disposes every underlying watcher', () => {
    const created = [...h.watchers];
    fw.dispose();
    fireOn('**', `${REPO}/src/a.ts`);
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    for (const w of created) expect(w.dispose).toHaveBeenCalled();
  });

  it('suppress() fully absorbs events during the window (no redundant re-trigger)', () => {
    fw.suppress(1000);
    fireOn('**', `${REPO}/src/a.ts`);
    // Inside the window → nothing.
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    // Window ends at 1000ms; the op's own events are dropped, not re-triggered…
    vi.advanceTimersByTime(500);
    // …and nothing fires after any subsequent debounce either.
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('suppress() cancels a debounce already armed by the op before it was called', () => {
    // The op's .git writes arm a debounce first; refreshAll() then calls suppress().
    fireOn('**', `${REPO}/.git/HEAD`);
    vi.advanceTimersByTime(200); // debounce armed but not yet fired
    fw.suppress(1000);
    // The pre-armed debounce must not fire a redundant refresh.
    vi.advanceTimersByTime(500);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a real external change after the suppress window still refreshes', () => {
    fw.suppress(1000);
    vi.advanceTimersByTime(1000); // window fully expired, refreshing cleared
    fireOn('**', `${REPO}/src/b.ts`);
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
