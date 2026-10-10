import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../netlify/functions/telegram-webhook.mjs';

const ENV = {
  TELEGRAM_BOT_TOKEN: 'BOT',
  TELEGRAM_CHAT_ID: '1234',
  TELEGRAM_WEBHOOK_SECRET: 'S3CRET',
  GITHUB_DISPATCH_TOKEN: 'GH',
  GITHUB_REPO: 'martin-stoyanov/friend-challenges',
};
// Thursday 15 Oct 2026: the upcoming week is 2026-w43 (Mon 19 Oct).
const now = () => new Date('2026-10-15T12:00:00Z');

function setup({ githubStatus = 204, env = ENV, timeoutMs } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.startsWith('https://api.github.com/')) {
      calls.push({ to: 'github', url, headers: init.headers, body });
      return new Response(null, { status: githubStatus });
    }
    calls.push({ to: 'telegram', method: url.split('/').at(-1), body });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return { calls, handle: createHandler({ env, fetchImpl, now, ...(timeoutMs && { timeoutMs }) }) };
}

const post = (update, secret = 'S3CRET') =>
  new Request('https://example.com/.netlify/functions/telegram-webhook', {
    method: 'POST',
    headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
    body: typeof update === 'string' ? update : JSON.stringify(update),
  });
const CHAT = { id: 1234 };
const tap = (data, chat = CHAT) => ({ update_id: 1, callback_query: { id: 'cb9', from: { id: 1 }, message: { message_id: 5, chat }, data } });
const text = (t, extra = {}, chat = CHAT) => ({ update_id: 2, message: { message_id: 77, chat, from: { id: 1 }, text: t, ...extra } });

test('a wrong or missing secret is refused with 401 and nothing is called', async () => {
  for (const secret of ['nope', '', null]) {
    const { calls, handle } = setup();
    const response = await handle(post(tap('pick:2026-w43:1'), secret));
    assert.equal(response.status, 401, String(secret));
    assert.equal(calls.length, 0);
  }
});

test('missing settings answer 500 and say which; GET is not allowed', async () => {
  const { handle } = setup({ env: { ...ENV, GITHUB_DISPATCH_TOKEN: '' } });
  assert.equal((await handle(post(tap('pick:2026-w43:1')))).status, 500);
  const response = await setup().handle(new Request('https://example.com/x', { method: 'GET' }));
  assert.equal(response.status, 405);
});

test('a stranger is ignored with 200 and nothing is dispatched', async () => {
  const { calls, handle } = setup();
  const response = await handle(post(tap('pick:2026-w43:1', { id: 999 })));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, []);
  assert.deepEqual((await handle(post(text('2', {}, { id: 999 })))).status, 200);
  assert.deepEqual(calls, []);
});

test('a Pick tap starts apply-challenge.yml with string inputs and answers with a toast', async () => {
  const { calls, handle } = setup();
  assert.equal((await handle(post(tap('pick:2026-w43:2')))).status, 200);
  const [github, toast] = calls;
  assert.equal(github.to, 'github');
  assert.equal(
    github.url,
    'https://api.github.com/repos/martin-stoyanov/friend-challenges/actions/workflows/apply-challenge.yml/dispatches'
  );
  assert.equal(github.headers.Authorization, 'Bearer GH');
  assert.deepEqual(github.body, {
    ref: 'master',
    inputs: { week_id: '2026-w43', pick: '2', overrides: '{}', source: 'button' },
  });
  assert.equal(toast.method, 'answerCallbackQuery');
  assert.equal(toast.body.callback_query_id, 'cb9');
  assert.match(toast.body.text, /Picking #2/);
  assert.equal(calls.length, 2);
});

test('a reply with a description dispatches it verbatim and reacts with 👍', async () => {
  const { calls, handle } = setup();
  const body = 'Read my lips — no sound at all.\ntitle: The Lip Read Challenge';
  await handle(post(text(body, { reply_to_message: { message_id: 4, chat: CHAT, text: 'The Whisper Challenge\n#3 · 2026-w43' } })));
  const github = calls.find((c) => c.to === 'github');
  assert.deepEqual(github.body.inputs, {
    week_id: '2026-w43',
    pick: '3',
    overrides: JSON.stringify({ title: 'The Lip Read Challenge', description: 'Read my lips — no sound at all.' }),
    source: 'reply',
  });
  const reaction = calls.find((c) => c.method === 'setMessageReaction');
  assert.deepEqual(reaction.body, { chat_id: '1234', message_id: 77, reaction: [{ type: 'emoji', emoji: '👍' }] });
});

test('a bare number picks for the upcoming week', async () => {
  const { calls, handle } = setup();
  await handle(post(text('4')));
  assert.deepEqual(calls[0].body.inputs, { week_id: '2026-w43', pick: '4', overrides: '{}', source: 'number' });
});

test('the more button starts propose-challenges.yml in "more" mode for that week', async () => {
  const { calls, handle } = setup({ env: { ...ENV, GITHUB_DISPATCH_REF: 'main' } });
  await handle(post(tap('more:2026-w43')));
  assert.match(calls[0].url, /\/actions\/workflows\/propose-challenges\.yml\/dispatches$/);
  assert.deepEqual(calls[0].body, { ref: 'main', inputs: { mode: 'more', week_id: '2026-w43' } });
  assert.match(calls[1].body.text, /more ideas/);
});

test('when GitHub refuses, Martin hears what to do, and Telegram still gets 200', async () => {
  for (const [status, expected] of [
    [401, /refused the bot's token .* Nothing changed\. Make a new one, update GITHUB_DISPATCH_TOKEN on Netlify, and redeploy/],
    [403, /refused the bot's token/],
    [404, /couldn't start the workflow \(404\)\. Nothing changed/],
    [500, /GitHub answered 500\. Nothing changed; try again in a minute/],
  ]) {
    const { calls, handle } = setup({ githubStatus: status });
    const response = await handle(post(text('2')));
    assert.equal(response.status, 200);
    const notice = calls.find((c) => c.method === 'sendMessage');
    assert.match(notice.body.text, expected, String(status));
    assert.equal(calls.some((c) => c.method === 'setMessageReaction'), false, 'no 👍 for a failed hand-off');
  }
});

test('a GitHub timeout is reported as maybe-done, and never quotes the error or the token', async () => {
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      // Hang until the handler's timeout aborts us, like a stalled connection.
      // AbortSignal.timeout doesn't hold the event loop open; a real socket
      // would, so this timer stands in for it.
      await new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5_000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(new Error(`boom ${init.headers.Authorization}`));
        });
      });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const sent = [];
  const recording = async (url, init) => {
    if (!url.startsWith('https://api.github.com/')) sent.push(JSON.parse(init.body));
    return fetchImpl(url, init);
  };
  const handle = createHandler({ env: ENV, fetchImpl: recording, now, timeoutMs: 50 });
  const started = Date.now();
  assert.equal((await handle(post(text('2')))).status, 200);
  assert.ok(Date.now() - started < 1_000, 'the timeout is wired through');
  const notice = sent.find((m) => m.text);
  assert.match(notice.text, /didn't answer in time\. It may still go through/);
  assert.doesNotMatch(notice.text, /Bearer|GH|boom/);
});

test('/help sends the guide; nonsense gets the reason; junk bodies are dropped with 200', async () => {
  const { calls, handle } = setup();
  await handle(post(text('/help')));
  assert.match(calls[0].body.text, /How to answer/);
  await handle(post(text('the second one')));
  assert.match(calls[1].body.text, /Start with the proposal number/);
  assert.equal((await handle(post('not json'))).status, 200);
  assert.equal((await handle(post({ update_id: 3, edited_message: { chat: CHAT, text: '2' } }))).status, 200);
  assert.equal(calls.length, 2);
});

test('a failed acknowledgement never turns into a non-200', async () => {
  const fetchImpl = async (url) =>
    url.startsWith('https://api.github.com/')
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 });
  const handle = createHandler({ env: ENV, fetchImpl, now });
  assert.equal((await handle(post(tap('pick:2026-w43:1')))).status, 200);
  assert.equal((await handle(post(text('/help')))).status, 200);
});

test('Telegram calls are not retried: a 429 on the acknowledgement is one call', async () => {
  let telegramCalls = 0;
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.github.com/')) return new Response(null, { status: 204 });
    telegramCalls++;
    return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 1 } }), { status: 429 });
  };
  const handle = createHandler({ env: ENV, fetchImpl, now });
  const started = Date.now();
  assert.equal((await handle(post(tap('pick:2026-w43:1')))).status, 200);
  assert.equal(telegramCalls, 1);
  assert.ok(Date.now() - started < 500, 'no backoff wait');
});

test('an invalid or unknown tap still stops the button spinner', async () => {
  const { calls, handle } = setup();
  await handle(post(tap('pick:2026-w43:0')));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery' && /start at 1/.test(c.body.text)));
  const before = calls.length;
  await handle(post(tap('something-else')));
  const after = calls.slice(before);
  assert.deepEqual(after.map((c) => c.method), ['answerCallbackQuery']);
});

test("a stranger's update is logged so a wrong chat id is visible", async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  await setup().handle(post(text('2', {}, { id: 999 })));
  assert.deepEqual(warnings, ['Ignored an update from chat 999.']);
});
