import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendBatch,
  createProposals,
  findProposal,
  markPicked,
  mergeRewrites,
  proposalsPath,
  proposedTitles,
  readProposals,
  selectProposals,
  writeProposals,
} from '../scripts/lib/proposals.mjs';
import { checkDescription } from '../scripts/copy-style.mjs';

const draft = (title) => ({
  title,
  description: `${title} description.`,
  category: 'both',
  difficulty: 'easy',
  emoji: '🎯',
  trendSource: 'TikTok',
  players: '2+',
  timeEstimate: '10-15 min',
  exampleUrl: 'https://www.tiktok.com/search?q=x',
  reasoning: 'Trending.',
  unexpected: 'dropped',
});
const NOW = new Date('2026-10-15T12:00:00Z');

test('batches are numbered continuously and tagged with their batch', () => {
  const empty = createProposals('2026-w43', '2026-10-19');
  const first = appendBatch(empty, ['A', 'B', 'C', 'D'].map(draft), NOW);
  assert.deepEqual(first.added.map((p) => [p.n, p.batch]), [[1, 1], [2, 1], [3, 1], [4, 1]]);

  const second = appendBatch(first.file, ['E', 'F'].map(draft), NOW);
  assert.deepEqual(second.added.map((p) => [p.n, p.batch]), [[5, 2], [6, 2]]);
  assert.equal(second.file.proposals.length, 6);
  assert.equal(empty.proposals.length, 0, 'input not mutated');
  assert.equal(first.file.proposals.length, 4, 'input not mutated');
});

test('a proposal keeps only the known fields, plus n, batch and createdAt', () => {
  const { added } = appendBatch(createProposals('2026-w43', '2026-10-19'), [draft('A')], NOW);
  assert.deepEqual(Object.keys(added[0]), [
    'n', 'batch', 'createdAt', 'title', 'description', 'category', 'difficulty',
    'emoji', 'trendSource', 'players', 'timeEstimate', 'exampleUrl', 'reasoning',
  ]);
  assert.equal(added[0].createdAt, '2026-10-15T12:00:00.000Z');
});

test('earlier titles feed the avoid-list; lookups and picks work by number', () => {
  const { file } = appendBatch(createProposals('2026-w43', '2026-10-19'), ['A', 'B'].map(draft), NOW);
  assert.deepEqual(proposedTitles(file), ['A', 'B']);
  assert.deepEqual(proposedTitles(null), []);
  assert.equal(findProposal(file, 2).title, 'B');
  assert.equal(findProposal(file, 9), null);
  assert.equal(findProposal(null, 1), null);

  const picked = markPicked(file, { n: 2, source: 'button' }, NOW);
  assert.deepEqual(picked.pick, { n: 2, source: 'button', at: '2026-10-15T12:00:00.000Z' });
  assert.equal(file.pick, null, 'input not mutated');
});

test('files round-trip through disk, and a missing week reads as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-'));
  try {
    assert.equal(readProposals('2026-w43', dir), null);
    const { file } = appendBatch(createProposals('2026-w43', '2026-10-19'), [draft('A')], NOW);
    writeProposals(file, dir);
    assert.deepEqual(readProposals('2026-w43', dir), file);
    assert.ok(fs.readFileSync(path.join(dir, '2026-w43.json'), 'utf-8').endsWith('}\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readProposals trusts the filename and names a broken file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposals-'));
  try {
    fs.writeFileSync(path.join(dir, '2026-w43.json'), JSON.stringify({ weekId: '2026-w40', weekOf: '2026-09-28', proposals: [], pick: null }));
    assert.throws(() => readProposals('2026-w43', dir), /2026-w43\.json says it is for 2026-w40, not 2026-w43/);
    fs.writeFileSync(path.join(dir, '2026-w44.json'), '{ not json');
    assert.throws(() => readProposals('2026-w44', dir), /2026-w44\.json is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('proposalsPath refuses anything but a whole week id, so a payload cannot escape the folder', () => {
  for (const bad of [
    '../src/data/challenges',
    '2026-w4',
    '2026-w43/../../src/data/challenges',
    '../2026-w43',
    'x2026-w43',
    '2026-w43x',
    '2026-w43\n',
  ]) {
    assert.throws(() => proposalsPath(bad), /Not a week id/, JSON.stringify(bad));
  }
  assert.match(proposalsPath('2026-w43'), /proposals[/\\]2026-w43\.json$/);
});

test('selectProposals drops invalid drafts and repeats, keeps ranking, stops at count', () => {
  const drafts = [
    draft('The Mirror Challenge'),
    { ...draft('The Bad Category Challenge'), category: 'family' },
    draft('Whisper Challenge'), // used before
    draft('The Sock Challenge'), // proposed in an earlier batch
    { ...draft('THE MIRROR CHALLENGE!'), description: 'Same idea again.' }, // repeat within the batch
    { ...draft('The Echo Challenge'), category: ' Couple ', difficulty: 'Medium' },
    draft('The Spare Challenge'), // over the count
  ];
  const { kept, dropped } = selectProposals(drafts, {
    avoidTitles: ['The Whisper Challenge', 'The Sock Challenge'],
    count: 2,
  });
  assert.deepEqual(kept.map((p) => p.title), ['The Mirror Challenge', 'The Echo Challenge']);
  assert.deepEqual([kept[1].category, kept[1].difficulty], ['couple', 'medium']);
  assert.equal(kept[0].exampleUrl, 'https://www.tiktok.com/search?q=x', 'search URL kept');
  assert.deepEqual(dropped.map((d) => d.title), [
    'The Bad Category Challenge',
    'Whisper Challenge',
    'The Sock Challenge',
    'THE MIRROR CHALLENGE!',
  ]);
  assert.match(dropped[0].reason, /category is not one of/);
  assert.deepEqual(selectProposals('not an array', { count: 4 }), { kept: [], dropped: [] });
});

test('selectProposals turns a made-up tag link into a search link', () => {
  const { kept } = selectProposals(
    [{ ...draft('The Mirror Challenge'), exampleUrl: 'https://www.tiktok.com/tag/mirrorchallenge' }],
    { count: 1 }
  );
  assert.equal(kept[0].exampleUrl, 'https://www.tiktok.com/search?q=Mirror%20Challenge');
});

test('mergeRewrites matches by title, not position, and keeps only improvements', () => {
  const clean = 'Sit back to back. One of you describes a photo while the other draws it blind, with no peeking and no hand gestures at all.';
  const proposals = [
    { title: 'The Bravo Challenge', description: 'It is hilarious — trust me on this one, it really is.' },
    { title: 'The Fine Challenge', description: clean },
    { title: 'The Charlie Challenge', description: 'The goal is to guess — fast.' },
  ];
  // Reordered, missing nothing, plus a rewrite that is worse than its draft.
  const rewrites = [
    { title: 'The Charlie Challenge', description: 'The goal is to guess. It is hilarious — and epic.' },
    { title: 'the bravo challenge', description: clean },
  ];
  const { proposals: merged, stillFailing } = mergeRewrites(proposals, rewrites, checkDescription);
  assert.equal(merged[0].description, clean, 'Bravo got its own rewrite');
  assert.equal(merged[1], proposals[1], 'a passing draft is untouched');
  assert.equal(merged[2].description, proposals[2].description, 'a worse rewrite is not used');
  assert.deepEqual(stillFailing.map((f) => f.title), ['The Charlie Challenge']);
});

test('mergeRewrites with a short or broken reply keeps every draft', () => {
  const proposals = [
    { title: 'The A Challenge', description: 'It is hilarious — trust me on this one, it really is.' },
    { title: 'The B Challenge', description: 'The goal is to guess — fast.' },
  ];
  for (const reply of [[], null, { title: 'x' }, [{ title: 'The A Challenge' }]]) {
    const { proposals: merged, stillFailing } = mergeRewrites(proposals, reply, checkDescription);
    assert.deepEqual(merged, proposals);
    assert.equal(stillFailing.length, 2);
  }
});
