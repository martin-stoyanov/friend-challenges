import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDescription, lintChallenges, readHandWrittenDescriptions } from '../scripts/copy-style.mjs';

const rules = (description) => checkDescription(description).map(v => v.rule);

test('a description written to the guide passes', () => {
  const description =
    "Both of you hold up ten fingers while one person reads from a list of 'put a finger down if...' statements. " +
    'You both drop at the same moment. ' +
    'Film it split-screen so the hands and the faces are both in frame.';
  assert.deepEqual(rules(description), []);
});

test('an em dash and a pre-labeled outcome are both flagged', () => {
  const description =
    'Swap phones with your partner and read the last five texts out loud — no skipping. ' +
    'It is hilarious every single time, trust me on this one.';
  const found = rules(description);
  assert.ok(found.includes('em-dash'), `expected em-dash in ${found}`);
  assert.ok(found.includes('pre-labels-the-fun'), `expected pre-labels-the-fun in ${found}`);
});

test('"the goal is to" is flagged as throat-clearing', () => {
  assert.ok(rules('The goal is to guess the song before the chorus.').includes('throat-clearing'));
});

test("Martin's own description only warns while the card still has his exact text", () => {
  const his = 'Mine — with a dash.';
  const challenges = [
    { id: '2026-w44', title: 'Hand-written', description: his },
    { id: '2026-w43', title: 'Generated', description: 'It is hilarious — trust me.' },
    { id: '2026-w42', title: 'Edited since', description: `${his} Edited.` },
  ];
  const handWritten = new Map([['2026-w44', his], ['2026-w42', his]]);
  const { failed, warned } = lintChallenges(challenges, handWritten);
  assert.deepEqual(warned.map((w) => w.challenge.id), ['2026-w44']);
  assert.deepEqual(failed.map((f) => f.challenge.id), ['2026-w43', '2026-w42']);
});

test('readHandWrittenDescriptions reads picks with a description override only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-'));
  try {
    const write = (weekId, pick) => fs.writeFileSync(
      path.join(dir, `${weekId}.json`),
      JSON.stringify({ weekId, weekOf: '2026-10-26', proposals: [], pick })
    );
    write('2026-w44', { n: 2, source: 'reply', overrides: { description: 'Mine.' } });
    write('2026-w43', { n: 1, source: 'button', overrides: {} });
    write('2026-w42', null);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    // A file that claims another week speaks only for the week in its name.
    fs.writeFileSync(path.join(dir, '2026-w41.json'), JSON.stringify({
      weekId: '2026-w30', proposals: [], pick: { n: 1, overrides: { description: 'Other.' } },
    }));
    assert.deepEqual([...readHandWrittenDescriptions(dir)].sort(), [['2026-w41', 'Other.'], ['2026-w44', 'Mine.']]);
    assert.deepEqual([...readHandWrittenDescriptions(path.join(dir, 'missing'))], []);
    fs.writeFileSync(path.join(dir, '2026-w40.json'), '{ broken');
    assert.throws(() => readHandWrittenDescriptions(dir), /proposals\/2026-w40\.json is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a description Claude wrote on request is not exempt; older picks without an author are his', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-'));
  try {
    const write = (weekId, pick) => fs.writeFileSync(path.join(dir, `${weekId}.json`), JSON.stringify({ weekId, proposals: [], pick }));
    write('2026-w44', { n: 1, overrides: { description: 'By Claude.' }, descriptionBy: 'claude' });
    write('2026-w43', { n: 1, overrides: { description: 'His, from before.' } });
    write('2026-w42', { n: 1, overrides: { description: 'His.' }, descriptionBy: 'martin' });
    assert.deepEqual([...readHandWrittenDescriptions(dir)].sort(), [['2026-w42', 'His.'], ['2026-w43', 'His, from before.']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
