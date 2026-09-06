/**
 * Shared commit-date formatting for the main panel (M7). Two surfaces used to
 * format the same ISO date two different ways — the graph row hand-rolled
 * "2026-08-02 PM 3:22" (AM/PM before the time, not any real locale) and the
 * details panel's bare `toLocaleString()` ("2026/8/2 上午6:14:38"). Both now
 * go through this one function so a commit's date reads the same everywhere.
 *
 * `dateStyle: 'medium', timeStyle: 'short'` mirrors JetBrains' Log tab
 * (e.g. "Aug 2, 2026, 3:22 PM").
 */
export function formatCommitDate(iso: string): string {
  const d = new Date(iso);
  // The synthetic UNCOMMITTED commit ships an empty author/committer date
  // (`git-service.ts` / `MainPanel.ts` build it with `date: ''`), and test
  // fixtures across the suite use `date: ''` too. `Intl.DateTimeFormat` throws
  // RangeError on an invalid Date — unlike the old `toLocaleString()`, which
  // silently returned "Invalid Date" — so guard and pass the raw value through.
  if (Number.isNaN(d.getTime())) { return iso; }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
