import { describe, it, expect } from 'vitest';
import { linkify, type LinkRule } from '../linkify';

const gh: LinkRule = { pattern: '#(\\d+)', url: 'https://gh/issues/$1' };
const jira: LinkRule = { pattern: '([A-Z]+-\\d+)', url: 'https://jira/$1' };

describe('linkify', () => {
  it('returns a single text segment when nothing matches', () => {
    expect(linkify('plain message', [gh])).toEqual([{ text: 'plain message' }]);
  });

  it('returns a single text segment when there are no rules', () => {
    expect(linkify('see #1', [])).toEqual([{ text: 'see #1' }]);
  });

  it('linkifies a single match with surrounding text', () => {
    expect(linkify('fix #12 now', [gh])).toEqual([
      { text: 'fix ' },
      { text: '#12', url: 'https://gh/issues/12' },
      { text: ' now' },
    ]);
  });

  it('linkifies multiple matches', () => {
    expect(linkify('#1 and #2', [gh])).toEqual([
      { text: '#1', url: 'https://gh/issues/1' },
      { text: ' and ' },
      { text: '#2', url: 'https://gh/issues/2' },
    ]);
  });

  it('substitutes $1 and $2', () => {
    const rule: LinkRule = { pattern: '(\\w+)/(\\w+)', url: 'https://x/$1/$2' };
    expect(linkify('repo a/b end', [rule])).toEqual([
      { text: 'repo ' },
      { text: 'a/b', url: 'https://x/a/b' },
      { text: ' end' },
    ]);
  });

  it('lets the earlier rule win at the same position', () => {
    // jira listed first, so FOO-1 matches jira even though gh could match the trailing -1? (it can't here, but order is what we assert)
    expect(linkify('FOO-1', [jira, gh])).toEqual([
      { text: 'FOO-1', url: 'https://jira/FOO-1' },
    ]);
  });

  it('breaks ties at the same span in favour of the earlier rule', () => {
    const first: LinkRule = { pattern: '#(\\d+)', url: 'https://first/$1' };
    const second: LinkRule = { pattern: '#(\\d+)', url: 'https://second/$1' };
    expect(linkify('see #5', [first, second])).toEqual([
      { text: 'see ' },
      { text: '#5', url: 'https://first/5' },
    ]);
  });

  it('does not linkify a non-http(s) substituted url', () => {
    const bad: LinkRule = { pattern: '(x)', url: 'javascript:alert($1)' };
    expect(linkify('x here', [bad])).toEqual([{ text: 'x here' }]);
  });

  it('ignores an invalid regex rule', () => {
    const bad: LinkRule = { pattern: '(', url: 'https://x' };
    expect(linkify('text', [bad])).toEqual([{ text: 'text' }]);
  });

  it('caps the number of matches to avoid runaway work', () => {
    const many = '#1 '.repeat(500);
    const segs = linkify(many, [gh]);
    const links = segs.filter((s): s is { text: string; url: string } => 'url' in s);
    expect(links.length).toBeLessThanOrEqual(200);
  });
});
