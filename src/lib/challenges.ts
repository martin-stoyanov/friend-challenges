import type { Challenge } from '@/types/Challenge';

/** `YYYY-MM-DD` for `date` in the viewer's own time zone. */
export function toLocalDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// A week can be committed days before its Monday: the Telegram pick usually lands
// on Thursday. Rather than a separate publish job, the site hides any challenge
// whose week hasn't started yet for this viewer. `weekOf` is a plain YYYY-MM-DD
// string, so comparing strings is exact and never shifts with the time zone (see
// WEEKOF_DATE_BUG_ANALYSIS.md for what happens when it goes through UTC).
export function getPublishedChallenges(
  challenges: Challenge[],
  today: Date = new Date()
): Challenge[] {
  const todayStr = toLocalDateString(today);
  return challenges.filter((c) => c.weekOf <= todayStr);
}

// Completion rows can name challenges the page doesn't show: a week that hasn't
// started, or one since removed from challenges.json. Count only the shown ones so
// "done X of Y" never reads more than Y.
export function countDone(published: Challenge[], doneIds: ReadonlySet<string>): number {
  return published.filter((c) => doneIds.has(c.id)).length;
}
