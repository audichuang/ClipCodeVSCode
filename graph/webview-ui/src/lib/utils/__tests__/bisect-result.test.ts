/* SNIPCODE-HOOK start: live-QA-6 */
// Real output shapes, not invented ones: the unquoted line is what git 2.43
// prints (captured from a local run), the quoted one is what git 2.55 prints
// (captured by a real-VS Code pass on macOS), and the custom term is what
// `git bisect start --term-bad broken` produces.
import { describe, it, expect } from 'vitest';
import { isBisectFinished, isBisectResultLine, bisectCulpritHash } from '../bisect-result';

const SHA = 'f3e6da935870419bd1d62b95d7fbe311b55b0779';
const body =
  `commit ${SHA}\n` +
  'Author: t <a@b.c>\n' +
  'Date:   Mon Sep 7 05:48:05 2026 +0800\n\n' +
  '    c2\n';

describe('bisect result parsing', () => {
  const cases: Array<[string, string]> = [
    ['git 2.43, unquoted term', `${SHA} is the first bad commit\n${body}`],
    ['git 2.55, quoted term', `${SHA} is the first 'bad' commit\n${body}`],
    ['custom term via --term-bad', `${SHA} is the first 'broken' commit\n${body}`],
  ];

  for (const [name, message] of cases) {
    it(`recognises the finished state — ${name}`, () => {
      expect(isBisectFinished(message)).toBe(true);
      expect(bisectCulpritHash(message)).toBe(SHA);
      expect(isBisectResultLine(message.split('\n')[0])).toBe(true);
    });
  }

  it('is not finished while bisect is still walking', () => {
    const running = 'Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[abc1234] wip';
    expect(isBisectFinished(running)).toBe(false);
    expect(bisectCulpritHash(running)).toBeNull();
  });

  it('does not treat a commit subject that merely mentions the phrase as the result line', () => {
    // The summary scan walks the log body; a subject like this must not be
    // mistaken for git's own result line.
    expect(isBisectResultLine('    fix: explain which commit is the first one to break')).toBe(false);
  });

  it('returns null for no message at all', () => {
    expect(bisectCulpritHash(null)).toBeNull();
    expect(bisectCulpritHash(undefined)).toBeNull();
    expect(bisectCulpritHash('')).toBeNull();
  });
});
/* SNIPCODE-HOOK end */
