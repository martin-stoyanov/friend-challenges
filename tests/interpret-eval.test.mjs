import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readInterpretation } from '../scripts/lib/interpret.mjs';
import { contextFor, idealAnswer, scoreReading } from '../scripts/lib/interpret-eval.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/interpret-messages.json', import.meta.url), 'utf-8'));

test('every fixture case passes the guardrails and the scorer with a perfect answer', () => {
  assert.ok(fixture.cases.length >= 20, `only ${fixture.cases.length} cases`);
  for (const testCase of fixture.cases) {
    const reading = readInterpretation(idealAnswer(testCase.expect), contextFor(fixture, testCase));
    const { pass, problems } = scoreReading(reading, testCase.expect);
    assert.ok(pass, `${testCase.name}: ${problems.join('; ')}`);
  }
});

test('the scorer catches the wrong proposal, an extra change, an unasked description and a wrong theme', () => {
  const pick = { type: 'pick', n: 2, overrides: { category: 'couple' }, descriptionBy: 'none', readAs: '' };
  assert.equal(scoreReading(pick, { action: 'pick', n: 2, overrides: { category: 'couple' } }).pass, true);
  assert.match(scoreReading({ ...pick, n: 3 }, { action: 'pick', n: 2, overrides: { category: 'couple' } }).problems[0], /expected #2, got #3/);
  assert.match(
    scoreReading({ ...pick, overrides: { category: 'couple', players: '2' } }, { action: 'pick', n: 2, overrides: { category: 'couple' } }).problems[0],
    /expected fields/
  );
  assert.match(
    scoreReading({ ...pick, overrides: { description: 'x' }, descriptionBy: 'claude' }, { action: 'pick', n: 2 }).problems[0],
    /expected description by none, got claude/
  );
  assert.match(scoreReading({ type: 'more', hint: 'dance' }, { action: 'more', hintIncludes: 'music' }).problems[0], /theme with "music"/);
  assert.match(scoreReading({ type: 'more', hint: 'music' }, { action: 'more', hint: null }).problems[0], /expected no theme/);
  assert.match(scoreReading({ type: 'clarify', question: 'Which?' }, { action: 'pick', n: 1 }).problems[0], /expected pick, got clarify \("Which\?"\)/);
});

test('a case with a pick in its context gives the interpreter that pick', () => {
  const testCase = fixture.cases.find((c) => c.pickedN);
  assert.equal(contextFor(fixture, testCase).proposals.pick.n, testCase.pickedN);
  assert.equal(contextFor(fixture, fixture.cases[0]).proposals.pick, null);
});

test('the scorer checks his exact words, and never counts the description as a field', () => {
  const his = { type: 'pick', n: 2, overrides: { description: 'His exact words.' }, descriptionBy: 'martin', readAs: '' };
  const expect = { action: 'pick', n: 2, descriptionBy: 'martin', description: 'His exact words.' };
  assert.equal(scoreReading(his, expect).pass, true, 'a description is not an extra field');
  const paraphrased = { ...his, overrides: { description: 'His words, tidied.' } };
  assert.match(scoreReading(paraphrased, expect).problems[0], /expected description "His exact words\."/);
  // A case that names no fields expects none changed, even beside a description.
  const extra = { ...his, overrides: { description: 'His exact words.', emoji: '🍇' } };
  assert.match(scoreReading(extra, expect).problems[0], /expected fields \[\], got \[\["emoji","🍇"\]\]/);
});

test('contextFor derives his earlier words from the question he replied to, as production does', () => {
  const testCase = fixture.cases.find((c) => c.name === 'answer to a question, using his earlier description');
  assert.equal(contextFor(fixture, testCase).earlierMessage, 'the food one, description: Pass a grape around the table using only your chins.');
  assert.equal('earlierMessage' in testCase, false, 'not given by the fixture');
});
