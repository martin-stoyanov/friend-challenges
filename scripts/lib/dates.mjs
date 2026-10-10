/**
 * Week arithmetic for challenge dates. Everything works on local-time
 * YYYY-MM-DD strings; never round-trip through toISOString, which shifts the
 * date in any zone east of UTC (WEEKOF_DATE_BUG_ANALYSIS.md).
 */

export function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The Monday a challenge generated at `now` is for: today on a Monday, else the coming one. */
export function getNextMonday(now = new Date()) {
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  return formatDateLocal(nextMonday);
}

/** The Monday that starts the week `now` is in: the live week's weekOf. */
export function getCurrentMonday(now = new Date()) {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return formatDateLocal(monday);
}

export function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return formatDateLocal(date);
}

/** Every Monday after the newest challenge, up to and including the next Monday. */
export function getMissingWeeks(existing, now = new Date()) {
  const sorted = [...existing].sort(
    (a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime()
  );
  const lastWeekOf = sorted[0]?.weekOf;
  const nextMonday = getNextMonday(now);
  if (!lastWeekOf) return [nextMonday];

  const weeks = [];
  let cursor = addDays(lastWeekOf, 7); // start from the week after the last one

  while (cursor <= nextMonday) {
    weeks.push(cursor);
    cursor = addDays(cursor, 7);
  }

  return weeks;
}

/** ISO week id, e.g. "2026-w42". This is the challenge's `id` and its Supabase key. */
export function getWeekId(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  // Shift to Thursday of the same ISO week (ISO weeks are defined by their Thursday)
  const thursday = new Date(date);
  thursday.setDate(date.getDate() + (4 - ((date.getDay() + 6) % 7 + 1)));
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  // Round to whole days first: where 1 Jan is in summer time (southern
  // hemisphere), a winter Thursday is a day count plus an hour away, and that
  // stray hour would push ceil() into the next week.
  const days = Math.round((thursday - jan1) / (24 * 60 * 60 * 1000));
  const weekNum = Math.ceil((days + 1) / 7);
  return `${year}-w${String(weekNum).padStart(2, '0')}`;
}
