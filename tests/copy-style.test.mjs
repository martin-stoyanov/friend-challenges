import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDescription } from '../scripts/copy-style.mjs';

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
