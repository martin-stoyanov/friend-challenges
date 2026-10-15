import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { callClaude, extractJson } from '../scripts/lib/claude.mjs';
import { sseError, sseResponse, sseStart, sseStream } from './helpers/sse.mjs';

before(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

// A finished message streams as server-sent events, like the API; an error is
// plain JSON with its status, as the API sends it before any stream starts.
const reply = (body, status = 200, headers = {}) =>
  status === 200 && body.type !== 'error'
    ? sseResponse(body)
    : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

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

test('the default request is Opus 5.5 with current web search, streamed, no extras', async () => {
  const { calls, fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })]);
  assert.deepEqual(await callClaude('prompt', 'system', { fetchImpl }), { ok: true });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual(calls[0].body, {
    model: 'claude-opus-5-5',
    max_tokens: 2048,
    system: 'system',
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }],
    messages: [{ role: 'user', content: 'prompt' }],
    stream: true,
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

test('the SDK retries a 429 after retry-after, five times at most; a 400 fails at once', async () => {
  const { calls, fetchImpl } = fakeFetch([
    reply({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after-ms': '5' }),
    reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }),
  ]);
  await callClaude('p', 's', { fetchImpl });
  assert.equal(calls.length, 2);

  let tries = 0;
  const always429 = async () => {
    tries++;
    return reply({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after-ms': '1' });
  };
  await assert.rejects(callClaude('p', 's', { fetchImpl: always429 }), /Claude API error \(429\)/);
  assert.equal(tries, 6, 'one try plus five retries');

  const bad = fakeFetch([reply({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400)]);
  await assert.rejects(callClaude('p', 's', { fetchImpl: bad.fetchImpl }), /Claude API error \(400\)/);
  assert.equal(bad.calls.length, 1);
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
    headersSeen.push(new Headers(init.headers));
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
    stream: true,
  });
  assert.equal(headersSeen[0].get('anthropic-beta'), 'server-side-fallback-2026-07-01');
});

test('without the new options no beta header or output_config is sent', async () => {
  let headers;
  let body;
  const fetchImpl = async (_url, init) => {
    headers = new Headers(init.headers);
    body = JSON.parse(init.body);
    return reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
  };
  await callClaude('p', 's', { fetchImpl });
  assert.equal(headers.get('anthropic-beta'), null);
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

test('the search tool version is a per-call option', async () => {
  const { calls, fetchImpl } = fakeFetch([reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] })]);
  await callClaude('p', 's', { fetchImpl, searchTool: 'web_search_20260209', maxSearches: 3 });
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
});

test('an API error reads once, with the request id and the cause kept', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } }),
    { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_123' } }
  );
  await assert.rejects(callClaude('p', 's', { fetchImpl }), (err) => {
    assert.match(err.message, /^Claude API error \(400\): \{"type":"error"/);
    assert.doesNotMatch(err.message, /\(400\): 400/);
    assert.match(err.message, /\[request req_123\]$/);
    assert.ok(err.cause, 'the SDK error is kept as the cause');
    return true;
  });
});

test('retries and the timeout are per call: the interpreter asks for two retries', async () => {
  let tries = 0;
  const always503 = async () => {
    tries++;
    return reply({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, 503, { 'retry-after-ms': '1' });
  };
  await assert.rejects(callClaude('p', 's', { fetchImpl: always503, maxRetries: 2 }), /Claude API error \(503\)/);
  assert.equal(tries, 3);
  const { INTERPRET_OPTIONS } = await import('../scripts/lib/interpret.mjs');
  assert.deepEqual([INTERPRET_OPTIONS.maxRetries, INTERPRET_OPTIONS.timeoutMs], [2, 90_000]);
});

test('each call logs its tokens, web searches and stop reason', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const { fetchImpl } = fakeFetch([
    reply({
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 90457, output_tokens: 4277, server_tool_use: { web_search_requests: 3 } },
    }),
    reply({ content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 5636, output_tokens: 854 } }),
  ]);
  await callClaude('p', 's', { fetchImpl, maxSearches: 3 });
  await callClaude('p', 's', { fetchImpl, maxSearches: 0 });
  assert.deepEqual(lines.filter((line) => line.startsWith('🧾')), [
    '🧾 claude-opus-5-5: 90457 tokens in, 4277 out, 3 web searches, end_turn',
    '🧾 claude-test: 5636 tokens in, 854 out, 0 web searches, end_turn',
  ]);
});

test('a stream that breaks off after it started is retried by callClaude, not only by the SDK', async () => {
  const done = { content: [{ type: 'text', text: '{"ok":true}' }] };
  const overloaded = fakeFetch([sseStream(sseError()), reply(done)]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl: overloaded.fetchImpl, retryDelayMs: 1 }), { ok: true });
  assert.equal(overloaded.calls.length, 2, 'an overloaded event mid-stream is retried');

  const dropped = fakeFetch([sseStream(sseStart(), { thenFail: new TypeError('terminated') }), reply(done)]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl: dropped.fetchImpl, retryDelayMs: 1 }), { ok: true });
  assert.equal(dropped.calls.length, 2, 'a connection dropped mid-stream is retried');
});

test('a stream that keeps breaking fails after maxRetries, as a Claude API error with its request id', async () => {
  let tries = 0;
  const alwaysDrops = async () => {
    tries++;
    return sseStream(sseStart(), { thenFail: new TypeError('terminated') });
  };
  await assert.rejects(callClaude('p', 's', { fetchImpl: alwaysDrops, maxRetries: 2, retryDelayMs: 1 }), (err) => {
    assert.match(err.message, /^Claude API error \(no status\): terminated.*\[request req_stream\]$/);
    return true;
  });
  assert.equal(tries, 3, 'one try plus two retries');
});

test('the deadline covers the whole stream: a slow one is cut and retried', async () => {
  const done = { content: [{ type: 'text', text: '{"ok":true}' }] };
  const slow = () => sseStream(sseStart(), { delayMs: 400 });
  const once = fakeFetch([slow(), reply(done)]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl: once.fetchImpl, timeoutMs: 50, retryDelayMs: 1 }), { ok: true });
  assert.equal(once.calls.length, 2);

  let tries = 0;
  const alwaysSlow = async () => {
    tries++;
    return slow();
  };
  await assert.rejects(
    callClaude('p', 's', { fetchImpl: alwaysSlow, timeoutMs: 50, maxRetries: 1, retryDelayMs: 1 }),
    /^Error: Claude API error \(timeout\): no answer within 0.05 seconds$/,
  );
  assert.equal(tries, 2);
});

test('the usage line adds up every segment of a paused call', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const { fetchImpl } = fakeFetch([
    reply({
      stop_reason: 'pause_turn',
      content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } }],
      usage: { input_tokens: 40000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } },
    }),
    reply({
      content: [{ type: 'text', text: '{}' }],
      usage: { input_tokens: 43000, output_tokens: 5, server_tool_use: { web_search_requests: 1 } },
    }),
  ]);
  await callClaude('p', 's', { fetchImpl, maxSearches: 3 });
  assert.deepEqual(lines.filter((line) => line.startsWith('🧾')), [
    '🧾 claude-test: 83000 tokens in, 305 out, 3 web searches, end_turn (2 segments)',
  ]);
});

test('after a refusal fallback mid-output, the resume echoes only what the declined model may send back', async () => {
  const paused = [
    { type: 'thinking', thinking: 'declined model', signature: 'sig' },
    { type: 'text', text: '{"title":' },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'answered' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
    { type: 'server_tool_use', id: 's2', name: 'web_search', input: { query: 'unanswered' } },
    { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-fallback' } },
    { type: 'thinking', thinking: 'fallback model', signature: 'sig' },
    { type: 'text', text: '"The A' },
    { type: 'server_tool_use', id: 's3', name: 'web_search', input: { query: 'after' } },
  ];
  const { calls, fetchImpl } = fakeFetch([
    reply({ stop_reason: 'pause_turn', content: paused }),
    reply({ content: [{ type: 'text', text: ' Challenge"}' }] }),
  ]);
  assert.deepEqual(await callClaude('p', 's', { fetchImpl, fallbacks: 'default' }), { title: 'The A Challenge' });
  assert.deepEqual(calls[1].body.messages[1].content, [paused[1], paused[2], paused[3], ...paused.slice(5)]);
});
