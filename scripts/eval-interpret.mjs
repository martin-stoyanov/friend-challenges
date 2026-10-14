#!/usr/bin/env node

/**
 * Runs the free-form reply interpreter against the live model on the cases in
 * tests/fixtures/interpret-messages.json and reports how many it reads as
 * expected. Uses the production settings (Claude Opus 5.5, INTERPRET_OPTIONS),
 * one call per case: about $1 a run.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=… node scripts/eval-interpret.mjs [--only "<case name>"] [--out results.json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadStyleGuide } from './copy-style.mjs';
import { callClaude } from './lib/claude.mjs';
import { buildInterpretRequest, INTERPRET_OPTIONS, readInterpretation } from './lib/interpret.mjs';
import { contextFor, scoreReading } from './lib/interpret-eval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'tests', 'fixtures', 'interpret-messages.json');
const CONCURRENCY = 4;

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const fixture = JSON.parse(fs.readFileSync(FIXTURES, 'utf-8'));
const only = flag('--only');
const cases = only ? fixture.cases.filter((c) => c.name === only) : fixture.cases;
const styleGuide = loadStyleGuide() ?? '';

async function runCase(testCase) {
  const context = contextFor(fixture, testCase);
  const request = buildInterpretRequest({ ...context, styleGuide });
  const started = Date.now();
  try {
    const answer = await callClaude(request.prompt, request.system, { ...INTERPRET_OPTIONS, schema: request.schema });
    const reading = readInterpretation(answer, context);
    const score = scoreReading(reading, testCase.expect);
    // A question can be the model's own, or a check turning its answer down.
    if (reading.type === 'clarify' && answer?.action !== 'clarify') {
      score.problems.push(`(the model answered "${answer?.action}"; a check in readInterpretation turned it into a question)`);
    }
    return { name: testCase.name, ...score, answer, reading, seconds: (Date.now() - started) / 1000 };
  } catch (err) {
    return { name: testCase.name, pass: false, problems: [`error: ${err.message.split('\n')[0]}`], seconds: (Date.now() - started) / 1000 };
  }
}

const results = [];
for (let i = 0; i < cases.length; i += CONCURRENCY) {
  results.push(...(await Promise.all(cases.slice(i, i + CONCURRENCY).map(runCase))));
}

for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name} (${r.seconds.toFixed(1)}s)${r.reading?.readAs ? ` — ${r.reading.readAs}` : ''}`);
  for (const problem of r.problems) console.log(`     ${problem}`);
}
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} read as expected.`);

const out = flag('--out');
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2) + '\n');
process.exit(results.some((r) => r.problems.some((p) => p.startsWith('error:'))) ? 1 : 0);
