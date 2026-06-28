import { describe, it, expect } from 'vitest';
import { hasMarkdown } from '../markdown-detect';

describe('hasMarkdown', () => {
  it('returns false for empty input', () => {
    expect(hasMarkdown('')).toBe(false);
  });

  it('detects no markdown in a plain one-line message', () => {
    expect(hasMarkdown('Fix crash when parsing empty config')).toBe(false);
  });

  it('detects no markdown in a plain multi-line body', () => {
    expect(hasMarkdown('Refactor auth flow\n\nMoves token refresh into the client.')).toBe(false);
  });

  it.each([
    ['heading', '# Add profile page'],
    ['fenced code', 'Usage:\n\n```ts\nconst x = 1;\n```'],
    ['inline code', 'Call `getUser()` first'],
    ['blockquote', '> note: best-effort only'],
    ['bullet list', '- one\n- two'],
    ['ordered list', '1. first\n2. second'],
    ['bold', 'Make it **bold**'],
    ['italic', 'Make it *slanted*'],
    ['strikethrough', 'Drop ~~the old api~~'],
    ['link', 'See [the docs](https://example.com)'],
    ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['horizontal rule', 'before\n\n---\n\nafter'],
    ['task list', '- [x] done\n- [ ] todo'],
  ])('detects markdown: %s', (_label, text) => {
    expect(hasMarkdown(text)).toBe(true);
  });

  it('does not flag snake_case identifiers as markdown', () => {
    expect(hasMarkdown('Rename update_user_profile to refresh_profile')).toBe(false);
  });

  it('does not flag Python dunders as markdown', () => {
    expect(hasMarkdown('Fix __init__ argument order')).toBe(false);
  });

  it('does not flag a bare URL as markdown', () => {
    expect(hasMarkdown('See https://example.com/issues/54 for context')).toBe(false);
  });

  it('does not flag an issue reference like #54 as markdown', () => {
    expect(hasMarkdown('Resolve flaky test (#54)')).toBe(false);
  });
});
