import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChallengeRecord,
  isDuplicateTitle,
  toTikTokSearchUrl,
  upsertChallenge,
  validateChallenge,
} from '../scripts/lib/challenge.mjs';

const valid = {
  title: 'The Whisper Challenge',
  description: 'One of you wears headphones.',
  category: 'both',
  difficulty: 'easy',
  emoji: '🤫',
  trendSource: 'TikTok',
  players: '2+',
  timeEstimate: '10-15 min',
  exampleUrl: 'https://www.tiktok.com/search?q=whisper%20challenge',
};

test('validateChallenge accepts a complete record', () => {
  assert.deepEqual(validateChallenge(valid), []);
});

test('validateChallenge names each missing field and rejects non-http links', () => {
  assert.deepEqual(validateChallenge({ ...valid, emoji: '' }), ['missing required field: emoji']);
  assert.deepEqual(validateChallenge({ ...valid, exampleUrl: 'javascript:alert(1)' }), [
    'exampleUrl is not an http(s) URL: javascript:alert(1)',
  ]);
  assert.deepEqual(validateChallenge(null), ['is not a JSON object']);
});

test('toTikTokSearchUrl keeps real search URLs and rewrites everything else', () => {
  const search = 'https://www.tiktok.com/search?q=whisper%20challenge';
  assert.equal(toTikTokSearchUrl(search, 'The Whisper Challenge'), search);
  assert.equal(
    toTikTokSearchUrl('https://www.tiktok.com/tag/whisperchallenge', 'The Whisper Challenge'),
    'https://www.tiktok.com/search?q=Whisper%20Challenge'
  );
  assert.equal(
    toTikTokSearchUrl('not a url', 'The Sock Challenge'),
    'https://www.tiktok.com/search?q=Sock%20Challenge'
  );
  // Only TikTok's own search page counts, not a look-alike host or another site.
  assert.equal(
    toTikTokSearchUrl('https://eviltiktok.com/search?q=sock', 'The Sock Challenge'),
    'https://www.tiktok.com/search?q=Sock%20Challenge'
  );
  assert.equal(
    toTikTokSearchUrl('https://www.youtube.com/search?q=sock', 'The Sock Challenge'),
    'https://www.tiktok.com/search?q=Sock%20Challenge'
  );
  // A search URL with no query is as useless as a tag page.
  assert.equal(
    toTikTokSearchUrl('https://www.tiktok.com/search', 'The Sock Challenge'),
    'https://www.tiktok.com/search?q=Sock%20Challenge'
  );
});

test('isDuplicateTitle ignores case, punctuation and a leading "The"', () => {
  const existing = ['The Whisper Challenge', 'The Not My Arms Challenge'];
  assert.equal(isDuplicateTitle('Whisper Challenge', existing), true);
  assert.equal(isDuplicateTitle('THE NOT-MY-ARMS CHALLENGE!', existing), true);
  assert.equal(isDuplicateTitle('The Mirror Challenge', existing), false);
});

test('buildChallengeRecord keeps only the stored fields, id and weekOf first', () => {
  const record = buildChallengeRecord({ ...valid, reasoning: 'trending' }, '2026-w42', '2026-10-12');
  assert.deepEqual(Object.keys(record), [
    'id', 'weekOf', 'title', 'description', 'category', 'difficulty',
    'emoji', 'trendSource', 'players', 'timeEstimate', 'exampleUrl',
  ]);
  assert.equal(record.id, '2026-w42');
});

test('upsertChallenge inserts newest-first and replaces the same id', () => {
  const list = [
    { id: '2026-w41', weekOf: '2026-10-05', title: 'A' },
    { id: '2026-w40', weekOf: '2026-09-28', title: 'B' },
  ];
  const inserted = upsertChallenge(list, { id: '2026-w42', weekOf: '2026-10-12', title: 'C' });
  assert.deepEqual(inserted.map((c) => c.id), ['2026-w42', '2026-w41', '2026-w40']);

  // A backfilled older week lands in date order, not at the front.
  const backfilled = upsertChallenge(list, { id: '2026-w39', weekOf: '2026-09-21', title: 'E' });
  assert.deepEqual(backfilled.map((c) => c.id), ['2026-w41', '2026-w40', '2026-w39']);
  const middle = upsertChallenge(
    [{ id: '2026-w42', weekOf: '2026-10-12' }, { id: '2026-w40', weekOf: '2026-09-28' }],
    { id: '2026-w41', weekOf: '2026-10-05' }
  );
  assert.deepEqual(middle.map((c) => c.id), ['2026-w42', '2026-w41', '2026-w40']);

  const replaced = upsertChallenge(inserted, { id: '2026-w42', weekOf: '2026-10-12', title: 'D' });
  assert.deepEqual(replaced.map((c) => c.title), ['D', 'A', 'B']);
  assert.equal(list.length, 2, 'the input list is not mutated');
});
