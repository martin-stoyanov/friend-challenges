import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, extractJson } from '../scripts/lib/claude.mjs';

before(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

const reply = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return next;
  };
  return { calls, fetchImpl };
}

test('extractJson reads a fence, bare JSON, or JSON after a line of preamble', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('[1,2]'), [1, 2]);
  assert.deepEqual(extractJson('Here are the challenges I found:\n[{"a":1}]'), [{ a: 1 }]);
  assert.equal(extractJson('no json here'), undefined);
  assert.equal(extractJson('[{"a":1}, {"b":'), undefined);
});

test('the default request matches what the generator always sent', async () => {
  const { calls, fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })]);
  assert.deepEqual(await callClaude('prompt', 'system', { fetchImpl }), { ok: true });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(calls[0].body, {
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: 'system',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    messages: [{ role: 'user', content: 'prompt' }],
  });
});

test('maxSearches 0 sends no tools; maxTokens is passed through', async () => {
  const { calls, fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '[]' }] })]);
  await callClaude('p', 's', { fetchImpl, maxSearches: 0, maxTokens: 4096 });
  assert.equal('tools' in calls[0].body, false);
  assert.equal(calls[0].body.max_tokens, 4096);
});

test('text split across blocks by search citations is joined before parsing', async () => {
  const content = [
    { type: 'text', text: 'Let me search.' },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'text', text: '[{"title":"The A' },
    { type: 'text', text: ' Challenge"}]', citations: [{ type: 'web_search_result_location' }] },
  ];
  const { fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content })]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl }), [{ title: 'The A Challenge' }]);
});

test('a paused search loop is resumed by re-sending the paused turn', async () => {
  const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }];
  const { calls, fetchImpl } = fakeFetch([
    reply({ stop_reason: 'pause_turn', content: paused }),
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"done":1}' }] }),
  ]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl }), { done: 1 });
  assert.deepEqual(calls[1].body.messages, [
    { role: 'user', content: 'p' },
    { role: 'assistant', content: paused },
  ]);
});

test('a refusal throws instead of being parsed', async () => {
  const { fetchImpl } = fakeFetch([reply({ stop_reason: 'refusal', stop_details: { explanation: 'nope' }, content: [] })]);
  await assert.rejects(callClaude('p', 's', { fetchImpl }), /declined the request: nope/);
});

test('a reply cut off at max_tokens fails with the retryable parse error', async () => {
  const { fetchImpl } = fakeFetch([reply({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '[{"title": "The A' }] })]);
  await assert.rejects(callClaude('p', 's', { fetchImpl }), (err) => {
    assert.match(err.message, /^Failed to parse JSON from Claude response \(cut off at max_tokens\)/);
    return true;
  });
});

test('429 waits for retry-after and tries again; a 400 fails at once', async () => {
  const waits = [];
  const sleepImpl = async (ms) => { waits.push(ms); };
  const { calls, fetchImpl } = fakeFetch([
    reply({ error: 'rate' }, 429, { 'retry-after': '7' }),
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }),
  ]);
  await callClaude('p', 's', { fetchImpl, sleepImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [7000]);

  const bad = fakeFetch([reply({ error: 'bad' }, 400)]);
  await assert.rejects(callClaude('p', 's', { fetchImpl: bad.fetchImpl, sleepImpl }), /Claude API error \(400\)/);
});

test('after two pauses the resume carries both paused segments, and text from all of them is read', async () => {
  const first = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } }];
  const second = [
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'text', text: '[{"title":' },
  ];
  const { calls, fetchImpl } = fakeFetch([
    reply({ stop_reason: 'pause_turn', content: first }),
    reply({ stop_reason: 'pause_turn', content: second }),
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '"The A Challenge"}]' }] }),
  ]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl }), [{ title: 'The A Challenge' }]);
  assert.deepEqual(calls[2].body.messages[1], { role: 'assistant', content: [...first, ...second] });
});
