import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { countDone, getPublishedChallenges, toLocalDateString } from '../src/lib/challenges.ts';

const week = (weekOf) => ({ id: weekOf, weekOf, title: weekOf });
const ids = (list) => list.map((c) => c.id);

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

test('a week dated after today is hidden; today and earlier are shown', () => {
  const list = [week('2026-10-05'), week('2026-10-12'), week('2026-10-19')];
  // Monday 12 Oct 2026, mid-morning local time.
  const today = new Date(2026, 9, 12, 10, 0);
  assert.deepEqual(ids(getPublishedChallenges(list, today)), ['2026-10-05', '2026-10-12']);
});

test('the new week appears at local midnight, not before', () => {
  const list = [week('2026-10-12')];
  assert.deepEqual(ids(getPublishedChallenges(list, new Date(2026, 9, 11, 23, 59, 59))), []);
  assert.deepEqual(ids(getPublishedChallenges(list, new Date(2026, 9, 12, 0, 0, 1))), ['2026-10-12']);
});

test("the cut-off follows the viewer's time zone, not UTC", () => {
  const list = [week('2026-10-12')];
  // 12:00 UTC on Sunday 11 Oct: already Monday in Kiribati (UTC+14),
  // still Sunday morning in American Samoa (UTC-11).
  const instant = Date.UTC(2026, 9, 11, 12, 0);

  process.env.TZ = 'Pacific/Kiritimati';
  assert.equal(toLocalDateString(new Date(instant)), '2026-10-12');
  assert.deepEqual(ids(getPublishedChallenges(list, new Date(instant))), ['2026-10-12']);

  process.env.TZ = 'Pacific/Pago_Pago';
  assert.equal(toLocalDateString(new Date(instant)), '2026-10-11');
  assert.deepEqual(ids(getPublishedChallenges(list, new Date(instant))), []);
});

test('an empty list stays empty, and order is preserved', () => {
  assert.deepEqual(getPublishedChallenges([], new Date(2026, 9, 12)), []);
  const list = [week('2026-01-13'), week('2026-08-17'), week('2026-03-02')];
  assert.deepEqual(ids(getPublishedChallenges(list, new Date(2026, 9, 12))), [
    '2026-01-13',
    '2026-08-17',
    '2026-03-02',
  ]);
});

test('toLocalDateString pads single-digit months and days', () => {
  assert.equal(toLocalDateString(new Date(2026, 0, 5)), '2026-01-05');
});

test('countDone ignores completions for weeks that are not shown', () => {
  const published = [week('2026-10-05'), week('2026-10-12')];
  // A row for next week's challenge and one for a challenge since removed.
  const doneIds = new Set(['2026-10-12', '2026-10-19', 'gift-exchange']);
  assert.equal(countDone(published, doneIds), 1);
  assert.equal(countDone([], doneIds), 0);
});
