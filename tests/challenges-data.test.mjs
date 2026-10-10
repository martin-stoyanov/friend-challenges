import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const challenges = JSON.parse(
  fs.readFileSync(new URL('../src/data/challenges.json', import.meta.url), 'utf-8')
);

// The site decides which weeks are live by comparing weekOf to today as strings
// (src/lib/challenges.ts). That only works for zero-padded YYYY-MM-DD: "2026-10-5"
// sorts after "2026-10-31" and would stay hidden for most of the month.
test('every weekOf is a real, zero-padded YYYY-MM-DD date', () => {
  for (const c of challenges) {
    assert.match(c.weekOf, /^\d{4}-\d{2}-\d{2}$/, `${c.id}: weekOf "${c.weekOf}"`);
    const [y, m, d] = c.weekOf.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    assert.equal(date.toISOString().slice(0, 10), c.weekOf, `${c.id}: weekOf "${c.weekOf}" is not a calendar date`);
  }
});

// Ratings and completions in Supabase are keyed by id, so two entries sharing one
// would share their stars.
test('challenge ids are unique', () => {
  const ids = challenges.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});
