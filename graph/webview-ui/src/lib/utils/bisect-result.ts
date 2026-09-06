/* SNIPCODE-HOOK start: live-QA-6 tolerate git's quoted bisect term.
 *
 * Git changed the wording of the line that ends a bisect: 2.43 prints
 *
 *   <sha> is the first bad commit
 *
 * while 2.55 quotes the term,
 *
 *   <sha> is the first 'bad' commit
 *
 * The term itself is configurable too (`git bisect start --term-bad broken`
 * yields "the first 'broken' commit"), so matching one literal sentence was
 * always fragile — on a newer git the banner simply never reached its finished
 * state and the culprit row was never highlighted. Both readers of this line go
 * through here so they cannot disagree about whether a bisect is over.
 *
 * Git output is forced to English by LC_ALL=C in GitService.exec, so matching
 * the English sentence is enough whatever the UI locale is.
 */

/** The terminating line of `git bisect`, with or without quotes around the term. */
const FIRST_BAD = /\bis the first (?:'[^']*'|[^\s']+) commit\b/;

/** True once git has named the culprit and the bisect is over. */
export function isBisectFinished(message: string): boolean {
  return FIRST_BAD.test(message);
}

/** True for the specific line that names the culprit (used to skip it while
 *  hunting for the commit subject underneath). */
export function isBisectResultLine(line: string): boolean {
  return FIRST_BAD.test(line);
}

/** The culprit's hash, or null while the bisect is still running. */
export function bisectCulpritHash(message: string | null | undefined): string | null {
  if (!message || !isBisectFinished(message)) { return null; }
  return message.match(/^([a-f0-9]{7,40})/m)?.[1] ?? null;
}
/* SNIPCODE-HOOK end */
