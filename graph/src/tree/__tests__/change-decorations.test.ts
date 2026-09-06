// SNIPCODE-HOOK: whole-file — S5 own FileDecorationProvider unit tests.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter {
    private listeners: Array<(v: unknown) => void> = [];
    event = (l: (v: unknown) => void) => { this.listeners.push(l); return { dispose() {} }; };
    fire(v?: unknown) { this.listeners.forEach((l) => l(v)); }
    dispose() {}
  }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter,
    ThemeColor,
    Uri: {
      file: (p: string) => ({
        scheme: 'file',
        path: p,
        fsPath: p,
        query: '',
        with(o: Record<string, unknown>) { return { ...this, ...o }; },
      }),
    },
  };
});

import { changeUri, CHANGE_URI_SCHEME, ChangeDecorationProvider, STATUS_LABEL } from '../change-decorations';

describe('changeUri', () => {
  it('carries the absolute path, custom scheme, and status+group as query params', () => {
    const uri = changeUri('/repo/src/foo.ts', 'M', 'staged') as unknown as { scheme: string; fsPath: string; query: string };
    expect(uri.scheme).toBe(CHANGE_URI_SCHEME);
    expect(uri.fsPath).toBe('/repo/src/foo.ts');
    expect(uri.query).toBe('status=M&group=staged');
  });

  it('URI-encodes an unusual status value (defense in depth)', () => {
    const uri = changeUri('/repo/f', '!', 'conflict') as unknown as { query: string };
    expect(uri.query).toBe('status=%21&group=conflict');
  });
});

describe('ChangeDecorationProvider', () => {
  const provider = new ChangeDecorationProvider();
  const uri = (query: string, scheme = CHANGE_URI_SCHEME) => ({ scheme, query }) as unknown as import('vscode').Uri;

  it('returns undefined for a URI that is not our scheme (never shadows another provider)', () => {
    expect(provider.provideFileDecoration(uri('status=M&group=staged', 'file'))).toBeUndefined();
  });

  it('returns undefined for a nested repo dir (status N) — no badge on an embedded repo', () => {
    expect(provider.provideFileDecoration(uri('status=N&group=unstaged'))).toBeUndefined();
  });

  it.each([
    ['M', 'unstaged', 'gitDecoration.modifiedResourceForeground'],
    ['M', 'staged', 'gitDecoration.stageModifiedResourceForeground'],
    ['D', 'unstaged', 'gitDecoration.deletedResourceForeground'],
    ['D', 'staged', 'gitDecoration.stageDeletedResourceForeground'],
    ['A', 'staged', 'gitDecoration.addedResourceForeground'],
    ['R', 'staged', 'gitDecoration.renamedResourceForeground'],
    ['C', 'staged', 'gitDecoration.renamedResourceForeground'],
    ['U', 'unstaged', 'gitDecoration.untrackedResourceForeground'],
    ['!', 'conflict', 'gitDecoration.conflictingResourceForeground'],
  ])('badges %s (%s) with %s', (status, group, expectedColorId) => {
    const decoration = provider.provideFileDecoration(uri(`status=${encodeURIComponent(status)}&group=${group}`));
    expect(decoration?.badge).toBe(status);
    expect((decoration?.color as unknown as { id: string })?.id).toBe(expectedColorId);
    expect(decoration?.tooltip).toBe(STATUS_LABEL[status]);
  });
});
