import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPick,
  changedFields,
  fallbackAction,
  parsePickEvent,
  validateOverrides,
} from '../scripts/lib/apply.mjs';
import { appendBatch, createProposals, markPicked } from '../scripts/lib/proposals.mjs';
import { formatConfirmation, MAX_MESSAGE_LENGTH } from '../scripts/lib/telegram.mjs';
import { checkDescription } from '../scripts/copy-style.mjs';
import { readTag } from '../scripts/lib/reply.mjs';

const NOW = new Date('2026-10-16T12:00:00Z');
const draft = (title, extra = {}) => ({
  title,
  description: `${title}: sit back to back and describe a photo.`,
  category: 'couple',
  difficulty: 'easy',
  emoji: '🎨',
  trendSource: 'TikTok',
  players: '2',
  timeEstimate: '10-15 min',
  exampleUrl: 'https://www.tiktok.com/search?q=blind%20drawing',
  reasoning: 'Trending.',
  ...extra,
});
const file = () =>
  appendBatch(createProposals('2026-w43', '2026-10-19'), [draft('The A Challenge'), draft('The B Challenge')], NOW).file;
const lastWeek = { id: '2026-w42', weekOf: '2026-10-12', title: 'Older' };

test('a pick builds the stored record from the proposal and records the pick', () => {
  const result = applyPick({ challenges: [lastWeek], proposals: file(), weekId: '2026-w43', n: 2, source: 'button', now: NOW });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.challenge, {
    id: '2026-w43',
    weekOf: '2026-10-19',
    title: 'The B Challenge',
    description: 'The B Challenge: sit back to back and describe a photo.',
    category: 'couple',
    difficulty: 'easy',
    emoji: '🎨',
    trendSource: 'TikTok',
    players: '2',
    timeEstimate: '10-15 min',
    exampleUrl: 'https://www.tiktok.com/search?q=blind%20drawing',
  });
  assert.deepEqual(result.challenges.map((c) => c.id), ['2026-w43', '2026-w42']);
  assert.deepEqual(result.proposals.pick, { n: 2, source: 'button', overrides: {}, at: NOW.toISOString() });
});

test('overrides are used verbatim; a user link is kept as given', () => {
  const description = 'Mine — with an em dash, exactly as I typed it.  ';
  const link = 'https://www.tiktok.com/@someone/video/7400000000000000000';
  const { challenge } = applyPick({
    challenges: [],
    proposals: file(),
    weekId: '2026-w43',
    n: 1,
    overrides: { description, title: 'The Mirror Challenge', exampleUrl: link, timeEstimate: '5 min' },
    source: 'reply',
  });
  assert.equal(challenge.description, description);
  assert.equal(challenge.title, 'The Mirror Challenge');
  assert.equal(challenge.exampleUrl, link, 'not rewritten into a search URL');
  assert.equal(challenge.timeEstimate, '5 min');
});

test('a generated tag link is still normalized to a search link', () => {
  const proposals = appendBatch(createProposals('2026-w43', '2026-10-19'), [
    draft('The A Challenge', { exampleUrl: 'https://www.tiktok.com/tag/achallenge' }),
  ], NOW).file;
  const { challenge } = applyPick({ challenges: [], proposals, weekId: '2026-w43', n: 1, source: 'button' });
  assert.equal(challenge.exampleUrl, 'https://www.tiktok.com/search?q=A%20Challenge');
});

test('picking again for the same week replaces the earlier pick', () => {
  const first = applyPick({ challenges: [lastWeek], proposals: file(), weekId: '2026-w43', n: 1, source: 'button' });
  const second = applyPick({ challenges: first.challenges, proposals: first.proposals, weekId: '2026-w43', n: 2, source: 'button' });
  assert.deepEqual(second.challenges.map((c) => [c.id, c.title]), [
    ['2026-w43', 'The B Challenge'],
    ['2026-w42', 'Older'],
  ]);
  assert.equal(second.proposals.pick.n, 2);
});

test('an unknown week or number is an answer for Martin, not a crash', () => {
  assert.match(applyPick({ challenges: [], proposals: null, weekId: '2026-w43', n: 1 }).error, /Nothing was proposed for 2026-w43/);
  assert.match(applyPick({ challenges: [], proposals: file(), weekId: '2026-w43', n: 9 }).error, /no #9 for 2026-w43\. The proposals are #1–#2/);
  assert.match(
    applyPick({ challenges: [], proposals: file(), weekId: '2026-w43', n: 1, overrides: { category: 'family' } }).error,
    /category must be one of/
  );
});

test('validateOverrides checks fields, types, values and lengths', () => {
  assert.deepEqual(validateOverrides(undefined), []);
  assert.deepEqual(validateOverrides({ description: 'Fine.', players: '2' }), []);
  assert.deepEqual(validateOverrides([]), ['overrides must be an object']);
  assert.deepEqual(validateOverrides({ id: 'x' }), ['unknown field: "id"']);
  assert.deepEqual(validateOverrides(JSON.parse('{"__proto__": "x"}')), ['unknown field: "__proto__"']);
  assert.deepEqual(validateOverrides({ title: '  ' }), ['title must be non-empty text']);
  assert.deepEqual(validateOverrides({ title: 'x'.repeat(101) }), ['title is over 100 characters']);
  assert.deepEqual(validateOverrides({ exampleUrl: 'javascript:alert(1)' }), ['link must be a single http(s) URL']);
  assert.deepEqual(validateOverrides({ difficulty: 'Hard' }), ['difficulty must be one of easy, medium, hard']);
});

test('parsePickEvent reads a dispatch payload or manual inputs, and refuses bad ones', () => {
  assert.deepEqual(
    parsePickEvent('repository_dispatch', { client_payload: { weekId: '2026-w43', n: 2, overrides: { title: 'X' }, source: 'reply' } }),
    { weekId: '2026-w43', n: 2, overrides: { title: 'X' }, source: 'reply' }
  );
  assert.deepEqual(
    parsePickEvent('workflow_dispatch', { inputs: { week_id: '2026-w43', pick: '3', description: '  Mine.  ' } }),
    { weekId: '2026-w43', n: 3, overrides: { description: 'Mine.' }, source: 'manual' }
  );
  assert.deepEqual(
    parsePickEvent('workflow_dispatch', { inputs: { week_id: '2026-w43', pick: '1', description: '' } }).overrides,
    {}
  );
  assert.match(parsePickEvent('repository_dispatch', { client_payload: { weekId: '../x', n: 1 } }).error, /not a week id/);
  assert.match(parsePickEvent('repository_dispatch', { client_payload: { weekId: '2026-w43', n: '1' } }).error, /not a proposal number/);
  assert.match(parsePickEvent('repository_dispatch', { client_payload: { weekId: '2026-w43', n: 0 } }).error, /not a proposal number/);
  assert.match(parsePickEvent('repository_dispatch', {}).error, /not a week id/);
  assert.match(parsePickEvent('push', {}).error, /push event/);
});

test('fallback: nothing when the week is set, the recorded pick or #1 otherwise, generate when empty', () => {
  const proposals = file();
  assert.deepEqual(
    fallbackAction({ weekId: '2026-w43', challenges: [{ id: '2026-w43' }], proposals }),
    { action: 'none' }
  );
  assert.deepEqual(fallbackAction({ weekId: '2026-w43', challenges: [], proposals }), {
    action: 'pick', n: 1, overrides: {}, source: 'fallback', reapply: false,
  });
  const picked = markPicked(proposals, { n: 2, source: 'reply', overrides: { title: 'Mine' } }, NOW);
  assert.deepEqual(fallbackAction({ weekId: '2026-w43', challenges: [], proposals: picked }), {
    action: 'pick', n: 2, overrides: { title: 'Mine' }, source: 'reply', reapply: true,
  });
  assert.deepEqual(fallbackAction({ weekId: '2026-w43', challenges: [], proposals: null }), { action: 'generate' });
  assert.deepEqual(
    fallbackAction({ weekId: '2026-w43', challenges: [], proposals: createProposals('2026-w43', '2026-10-19') }),
    { action: 'generate' }
  );
});

test('changedFields names what Martin changed, in a fixed order', () => {
  assert.deepEqual(changedFields({ exampleUrl: 'x', description: 'y', title: 'z' }), ['title', 'description', 'link']);
  assert.deepEqual(changedFields(), []);
});

test('the confirmation echoes the pick and ends with a tag a reply can target', () => {
  const { challenge } = applyPick({ challenges: [], proposals: file(), weekId: '2026-w43', n: 2, overrides: { description: 'A & B <go>' }, source: 'reply' });
  const { text } = formatConfirmation({
    challenge,
    n: 2,
    weekId: '2026-w43',
    changed: ['description'],
    violations: [{ rule: 'em-dash', message: 'Contains an em/en dash.' }],
  });
  assert.match(text, /^✅ <b>#2 is set for the week of Mon 19 Oct<\/b>/);
  assert.match(text, /A &amp; B &lt;go&gt;/);
  assert.match(text, /Your changes: description/);
  assert.match(text, /published as written/);
  assert.match(text, /• Contains an em\/en dash\./);
  assert.match(text, /It goes live on Mon 19 Oct/);
  assert.deepEqual(readTag(text), { n: 2, weekId: '2026-w43' });

  const fallbackText = formatConfirmation({ challenge, n: 1, weekId: '2026-w43', fallback: true, live: true }).text;
  assert.match(fallbackText, /^⏰ <b>No pick by Sunday, so #1 is set/);
  assert.match(fallbackText, /already live/);
  assert.doesNotMatch(fallbackText, /Your changes/);
});

test('a confirmation stays under the Telegram limit with every field at its maximum', () => {
  const overrides = {
    title: 'T'.repeat(100),
    description: '"&"'.repeat(666) + 'xy',
    emoji: '👨‍👩‍👧'.repeat(2),
    players: 'p'.repeat(20),
    timeEstimate: 't'.repeat(30),
    exampleUrl: `https://x.com/${'a'.repeat(480)}`,
  };
  assert.deepEqual(validateOverrides(overrides), []);
  const { challenge } = applyPick({ challenges: [], proposals: file(), weekId: '2026-w43', n: 1, overrides, source: 'reply' });
  const violations = Array.from({ length: 10 }, (_, i) => ({ rule: `r${i}`, message: 'x'.repeat(120) }));
  const { text } = formatConfirmation({ challenge, n: 1, weekId: '2026-w43', changed: changedFields(overrides), violations });
  assert.ok(text.length <= MAX_MESSAGE_LENGTH, `length ${text.length}`);
  assert.match(text, /shortened here; the card has all of it/);
  assert.equal(readTag(text).n, 1);
  assert.doesNotMatch(text, /&(?!amp;|lt;|gt;|quot;)/, 'no cut entity');
});

test('an archived week cannot be changed; the live week and later can', () => {
  const old = appendBatch(createProposals('2026-w41', '2026-10-05'), [draft('The A Challenge')], NOW).file;
  assert.match(
    applyPick({ challenges: [], proposals: old, weekId: '2026-w41', n: 1, source: 'button', now: NOW }).error,
    /2026-w41 is in the archive now/
  );
  const live = appendBatch(createProposals('2026-w42', '2026-10-12'), [draft('The A Challenge')], NOW).file;
  assert.equal(applyPick({ challenges: [], proposals: live, weekId: '2026-w42', n: 1, source: 'button', now: NOW }).error, undefined);
});

test('picking the same number again keeps earlier changes; another number starts fresh', () => {
  const first = applyPick({
    challenges: [], proposals: file(), weekId: '2026-w43', n: 2,
    overrides: { title: 'The Mirror Challenge', emoji: '🪞' }, source: 'reply', now: NOW,
  });
  const again = applyPick({
    challenges: first.challenges, proposals: first.proposals, weekId: '2026-w43', n: 2,
    overrides: { description: 'Fixed text.', emoji: '🔁' }, source: 'reply', now: NOW,
  });
  assert.deepEqual(again.overrides, { title: 'The Mirror Challenge', emoji: '🔁', description: 'Fixed text.' });
  assert.equal(again.challenge.title, 'The Mirror Challenge');
  assert.deepEqual(again.proposals.pick.overrides, again.overrides);

  const other = applyPick({
    challenges: again.challenges, proposals: again.proposals, weekId: '2026-w43', n: 1, source: 'button', now: NOW,
  });
  assert.deepEqual(other.overrides, {});
  assert.equal(other.challenge.title, 'The A Challenge');
});

test('a payload must name a known source, and junk values are quoted short', () => {
  const payload = (extra) => ({ client_payload: { weekId: '2026-w43', n: 1, overrides: {}, source: 'button', ...extra } });
  assert.equal(parsePickEvent('repository_dispatch', payload({})).source, 'button');
  assert.match(parsePickEvent('repository_dispatch', payload({ source: 'telegram' })).error, /"telegram" is not a pick source/);
  assert.match(parsePickEvent('repository_dispatch', payload({ source: undefined })).error, /not a pick source/);
  const long = parsePickEvent('repository_dispatch', payload({ weekId: 'x'.repeat(5000) })).error;
  assert.ok(long.length < 120, `error is ${long.length} chars`);
  assert.match(parsePickEvent('repository_dispatch', payload({ overrides: { title: '' } })).error, /non-empty text\.$/);
});

test('a confirmation stays under the limit with real style warnings on a hostile description', () => {
  // One long sentence full of quotes, closing on a three-item list: the
  // rule-of-three message quotes the whole sentence back.
  const description = `The goal is to win — it is hilarious and epic. ${'"x" '.repeat(460)}then a, b, and c.`;
  assert.ok(description.length <= 2000);
  const overrides = {
    description,
    title: '"'.repeat(100),
    emoji: '"'.repeat(16),
    players: '"'.repeat(20),
    timeEstimate: '"'.repeat(30),
  };
  assert.deepEqual(validateOverrides(overrides), []);
  const { challenge } = applyPick({ challenges: [], proposals: file(), weekId: '2026-w43', n: 1, overrides, source: 'reply', now: NOW });
  const violations = checkDescription(challenge.description);
  assert.ok(violations.length >= 4, `got ${violations.length} violations`);
  assert.ok(violations.some((v) => v.rule === 'rule-of-three-closer'), 'the rule that quotes a sentence back');
  const { text } = formatConfirmation({ challenge, n: 1, weekId: '2026-w43', changed: changedFields(overrides), violations });
  assert.ok(text.length <= MAX_MESSAGE_LENGTH, `length ${text.length}`);
  assert.equal(readTag(text).n, 1);
});
