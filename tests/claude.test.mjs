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

test('an Opus request carries model, effort, schema and fallbacks, with the beta header and no tools', async () => {
  const headersSeen = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    headersSeen.push(init.headers);
    calls.push(JSON.parse(init.body));
    return reply({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'Maybe {"action":"more"}? No.', signature: 'sig' },
        { type: 'text', text: '{"action":"help"}' },
      ],
    });
  };
  const schema = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false };
  const result = await callClaude('p', 's', {
    fetchImpl, model: 'claude-opus-5-5', maxSearches: 0, maxTokens: 8000, effort: 'medium', schema, fallbacks: 'default',
  });
  assert.deepEqual(result, { action: 'help' }, 'the thinking block is skipped');
  assert.deepEqual(calls[0], {
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    system: 's',
    messages: [{ role: 'user', content: 'p' }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    fallbacks: 'default',
  });
  assert.equal(headersSeen[0]['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('without the new options no beta header or output_config is sent', async () => {
  let headers;
  let body;
  const fetchImpl = async (_url, init) => {
    headers = init.headers;
    body = JSON.parse(init.body);
    return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
  };
  await callClaude('p', 's', { fetchImpl });
  assert.equal('anthropic-beta' in headers, false);
  assert.equal('output_config' in body, false);
  assert.equal('fallbacks' in body, false);
});

test('a refusal after fallbacks still throws', async () => {
  const { fetchImpl } = fakeFetch([reply({
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined by both' },
    content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }],
  })]);
  await assert.rejects(callClaude('p', 's', { fetchImpl, fallbacks: 'default' }), /declined the request: declined by both/);
});

test('a reply cut off while still thinking fails with the retryable parse error', async () => {
  const { fetchImpl } = fakeFetch([reply({
    stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'still going', signature: 'sig' }],
  })]);
  await assert.rejects(
    callClaude('p', 's', { fetchImpl, maxSearches: 0 }),
    /^Error: Failed to parse JSON from Claude response \(cut off at max_tokens before any answer\)/
  );
});

test('with a schema the whole text is the answer, even if a field holds a code fence', async () => {
  const answer = { action: 'pick', description: 'Say ```3``` out loud.' };
  const { fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] })]);
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  assert.deepEqual(await callClaude('p', 's', { fetchImpl, maxSearches: 0, schema }), answer);
});

test('fallbacks only accepts the default form', async () => {
  await assert.rejects(
    callClaude('p', 's', { fetchImpl: async () => { throw new Error('should not be called'); }, fallbacks: [{ model: 'x' }] }),
    /fallbacks must be 'default'/
  );
});
