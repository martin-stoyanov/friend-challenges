import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, getCurrentMonday, getMissingWeeks, getNextMonday, getWeekId } from '../scripts/lib/dates.mjs';

// Date math is local-time, so the DST tests pin a zone instead of trusting
// whatever the machine running them is set to.
const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

test('getNextMonday: Monday is itself, Sunday is tomorrow, the rest roll forward', () => {
  // 12 Oct 2026 is a Monday. Noon local, so no zone puts it on another day.
  const expected = {
    '2026-10-12': '2026-10-12', // Mon
    '2026-10-13': '2026-10-19', // Tue
    '2026-10-14': '2026-10-19', // Wed
    '2026-10-15': '2026-10-19', // Thu: when proposals go out
    '2026-10-16': '2026-10-19', // Fri
    '2026-10-17': '2026-10-19', // Sat
    '2026-10-18': '2026-10-19', // Sun: when the fallback runs
  };
  for (const [day, monday] of Object.entries(expected)) {
    assert.equal(getNextMonday(new Date(`${day}T12:00:00`)), monday, day);
  }
});

test('getNextMonday crosses month and year ends', () => {
  assert.equal(getNextMonday(new Date('2026-10-29T12:00:00')), '2026-11-02');
  assert.equal(getNextMonday(new Date('2026-12-31T12:00:00')), '2027-01-04');
});

test('getWeekId follows ISO weeks across a year boundary', () => {
  assert.equal(getWeekId('2025-12-29'), '2026-w01'); // its Thursday is 1 Jan 2026
  assert.equal(getWeekId('2026-08-17'), '2026-w34'); // matches challenges.json
  assert.equal(getWeekId('2026-12-28'), '2026-w53'); // 2026 has 53 ISO weeks
  assert.equal(getWeekId('2027-01-04'), '2027-w01');
});

test('addDays stays on local dates across a DST change', () => {
  process.env.TZ = 'Europe/Berlin';
  assert.equal(addDays('2026-03-23', 7), '2026-03-30'); // clocks go forward 29 Mar
  assert.equal(addDays('2026-10-19', 7), '2026-10-26'); // clocks go back 25 Oct
  process.env.TZ = 'America/New_York';
  assert.equal(addDays('2026-10-26', 7), '2026-11-02'); // clocks go back 1 Nov
});

test('getWeekId is right where 1 January is in summer time', () => {
  process.env.TZ = 'Australia/Sydney';
  assert.equal(getWeekId('2027-04-05'), '2027-w14');
  assert.equal(getWeekId('2027-09-27'), '2027-w39');
  assert.equal(getWeekId('2027-10-04'), '2027-w40');
  assert.equal(getWeekId('2026-08-17'), '2026-w34');
});

test('getMissingWeeks lists every Monday after the newest one, up to the next', () => {
  const existing = [{ weekOf: '2026-08-10' }, { weekOf: '2026-08-17' }];
  const now = new Date('2026-09-03T12:00:00'); // Thursday
  assert.deepEqual(getMissingWeeks(existing, now), [
    '2026-08-24',
    '2026-08-31',
    '2026-09-07',
  ]);
  assert.deepEqual(getMissingWeeks([{ weekOf: '2026-09-07' }], now), []);
  assert.deepEqual(getMissingWeeks([], now), ['2026-09-07']);
});

test('getCurrentMonday is the Monday that starts the week, Sunday included', () => {
  assert.equal(getCurrentMonday(new Date('2026-10-12T00:30:00')), '2026-10-12'); // Monday
  assert.equal(getCurrentMonday(new Date('2026-10-16T12:00:00')), '2026-10-12'); // Friday
  assert.equal(getCurrentMonday(new Date('2026-10-18T23:59:00')), '2026-10-12'); // Sunday
  assert.equal(getCurrentMonday(new Date('2027-01-01T12:00:00')), '2026-12-28'); // across a year
});
