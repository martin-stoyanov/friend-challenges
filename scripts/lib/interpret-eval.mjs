/**
 * Scoring for the interpreter's evaluation (scripts/eval-interpret.mjs and
 * tests/interpret-eval.test.mjs). A fixture case describes one message, its
 * context and the reading it should get; see tests/fixtures/interpret-messages.json.
 */

import { markPicked } from './proposals.mjs';
import { quotedMessageFromQuestion } from './telegram.mjs';

/** The context readInterpretation and buildInterpretRequest need for a case. */
export function contextFor(fixture, testCase) {
  const proposals = testCase.pickedN
    ? markPicked(fixture.proposals, { n: testCase.pickedN, source: 'message', overrides: {} }, new Date('2026-10-15T12:00:00Z'))
    : fixture.proposals;
  return {
    message: testCase.message,
    replyN: testCase.replyN ?? null,
    replyText: testCase.replyText ?? null,
    // Derived the way apply-choice.mjs derives it, not given by the fixture.
    earlierMessage: quotedMessageFromQuestion(testCase.replyText ?? null),
    proposals,
    published: testCase.published ?? null,
  };
}

const FIELD_NAMES = { timeEstimate: 'time', exampleUrl: 'link' };
const sortedEntries = (object) => JSON.stringify(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Compares a checked reading with what the case expects. A pick must name the
 * right proposal, change exactly the expected fields, and touch the
 * description only when asked (with the right author, and his exact words).
 */
export function scoreReading(reading, expect) {
  const problems = [];
  if (reading.type !== expect.action) {
    const why = reading.type === 'clarify' ? ` ("${reading.question}")` : '';
    problems.push(`expected ${expect.action}, got ${reading.type}${why}`);
    return { pass: false, problems };
  }

  if (reading.type === 'pick') {
    if (reading.n !== expect.n) problems.push(`expected #${expect.n}, got #${reading.n}`);
    // Always the exact field set: a case that names none expects none changed.
    const fields = { ...reading.overrides };
    delete fields.description;
    const wanted = expect.overrides ?? {};
    if (sortedEntries(fields) !== sortedEntries(wanted)) {
      problems.push(`expected fields ${sortedEntries(wanted)}, got ${sortedEntries(fields)}`);
    }
    const by = expect.descriptionBy ?? 'none';
    if (reading.descriptionBy !== by) problems.push(`expected description by ${by}, got ${reading.descriptionBy}`);
    if (expect.description !== undefined && reading.overrides.description !== expect.description) {
      problems.push(`expected description "${expect.description}", got "${reading.overrides.description}"`);
    }
  }

  if (reading.type === 'more') {
    if (expect.hint === null && reading.hint) problems.push(`expected no theme, got "${reading.hint}"`);
    if (expect.hintIncludes && !reading.hint?.toLowerCase().includes(expect.hintIncludes)) {
      problems.push(`expected a theme with "${expect.hintIncludes}", got "${reading.hint}"`);
    }
  }
  return { pass: problems.length === 0, problems };
}

/** The answer a perfect model would give for a case, in the schema's shape. */
export function idealAnswer(expect) {
  const fields = { title: null, emoji: null, category: null, difficulty: null, players: null, time: null, link: null };
  for (const [key, value] of Object.entries(expect.overrides ?? {})) fields[FIELD_NAMES[key] ?? key] = value;
  return {
    action: expect.action,
    n: expect.n ?? null,
    fields,
    description: expect.description ?? (expect.descriptionBy === 'claude' ? 'Pass it across the table without hands, and start again if it drops.' : null),
    descriptionBy: expect.descriptionBy ?? 'none',
    hint: expect.hintIncludes ?? null,
    question: expect.action === 'clarify' ? 'Which one do you mean?' : null,
    readAs: 'ideal',
  };
}
