import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBody } from '../scripts/lib/reply.mjs';
import {
  MAX_MESSAGE_LENGTH,
  escapeHtml,
  formatFooter,
  formatHeader,
  formatProposal,
  proposalTag,
  replyGuideText,
  sendMessage,
  sendProposalBatch,
  telegramApi,
} from '../scripts/lib/telegram.mjs';

const proposal = {
  n: 2,
  title: 'The Whisper Challenge',
  description: 'One of you wears noise-cancelling headphones & the other mouths a phrase.',
  category: 'both',
  difficulty: 'easy',
  emoji: '🤫',
  players: '2+',
  timeEstimate: '10-15 min',
  exampleUrl: 'https://www.tiktok.com/search?q=whisper%20challenge&lang=en',
  reasoning: 'Back on <For You> pages this month.',
};

test('escapeHtml escapes the four characters Telegram HTML cares about', () => {
  assert.equal(escapeHtml('<b>"Tom" & Jerry</b>'), '&lt;b&gt;&quot;Tom&quot; &amp; Jerry&lt;/b&gt;');
});

test('a proposal escapes model text and ends with its tag line', () => {
  const { text } = formatProposal(proposal, '2026-w43');
  assert.match(text, /headphones &amp; the other/);
  assert.match(text, /&lt;For You&gt;/);
  assert.match(text, /href="https:\/\/www\.tiktok\.com\/search\?q=whisper%20challenge&amp;lang=en"/);
  assert.equal(text.split('\n').at(-1), '#2 · 2026-w43');
  assert.equal(proposalTag(2, '2026-w43'), '#2 · 2026-w43');
});

test('a non-http link is left out rather than rendered', () => {
  const { text } = formatProposal({ ...proposal, exampleUrl: 'javascript:alert(1)' }, '2026-w43');
  assert.doesNotMatch(text, /href=/);
  assert.doesNotMatch(text, /javascript:/);
});

test('the Pick button carries week and number within the 64-byte limit', () => {
  const { reply_markup } = formatProposal({ ...proposal, n: 12 }, '2026-w43');
  const button = reply_markup.inline_keyboard[0][0];
  assert.equal(button.text, '✅ Pick #12');
  assert.equal(button.callback_data, 'pick:2026-w43:12');
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);

  const more = formatFooter('2026-w43', 4).reply_markup.inline_keyboard[0][0];
  assert.equal(more.callback_data, 'more:2026-w43');
  assert.equal(more.text, '🔄 4 more');
});

test('an over-long description is cut to fit, keeping the tag line and whole emoji', () => {
  const description = '😂 & '.repeat(2000);
  const { text } = formatProposal({ ...proposal, description }, '2026-w43');
  assert.ok(text.length <= MAX_MESSAGE_LENGTH, `length ${text.length}`);
  // Cut only as much as needed: one grapheme escapes to at most 6 units.
  assert.ok(text.length > MAX_MESSAGE_LENGTH - 10, `cut too far: length ${text.length}`);
  assert.match(text, /\n😂 &amp; 😂/, 'the start of the description is kept');
  assert.equal(text.split('\n').at(-1), '#2 · 2026-w43');
  assert.match(text, /…/);
  assert.doesNotMatch(text, /Why now/, 'the reasoning goes first');
  assert.equal(text, text.toWellFormed(), 'no split surrogate pair');
  assert.doesNotMatch(text, /&(?!amp;|lt;|gt;|quot;)/, 'no cut entity');
});

test('a multi-codepoint emoji at the cut is dropped whole, never split', () => {
  const family = '👨‍👩‍👧';
  const description = 'a'.repeat(3229) + family.repeat(100);
  const { text } = formatProposal({ ...proposal, description, reasoning: '' }, '2026-w43');
  assert.ok(text.length <= MAX_MESSAGE_LENGTH);
  const kept = text.split('\n')[3];
  assert.match(kept, new RegExp(`^a+(${family})*…$`, 'u'), 'only whole families before the …');
});

test('when only the reasoning overflows, it is dropped and the description is kept whole', () => {
  const description = 'a'.repeat(3900);
  const { text } = formatProposal({ ...proposal, description, reasoning: 'r'.repeat(300) }, '2026-w43');
  assert.ok(text.length <= MAX_MESSAGE_LENGTH);
  assert.ok(text.includes(description), 'description intact');
  assert.doesNotMatch(text, /…/);
  assert.doesNotMatch(text, /Why now/);
});

test('a proposal without an emoji has no stray space in its heading', () => {
  const { text } = formatProposal({ ...proposal, emoji: '' }, '2026-w43');
  assert.equal(text.split('\n')[0], '<b>The Whisper Challenge</b>');
});

test('the header names the week in words and by id', () => {
  const { text } = formatHeader('2026-w43', '2026-10-19', 4);
  assert.match(text, /4 ideas for the week of Mon 19 Oct/);
  assert.match(text, /2026-w43/);
});

test('telegramApi posts JSON to the method URL and returns result', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  };
  const result = await telegramApi('sendMessage', { chat_id: 1, text: 'hi' }, { token: 'T0K', fetchImpl });
  assert.deepEqual(result, { message_id: 7 });
  assert.equal(calls[0].url, 'https://api.telegram.org/botT0K/sendMessage');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: 1, text: 'hi' });
});

test('telegramApi errors carry Telegram\'s description but never the token', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
  await assert.rejects(
    telegramApi('sendMessage', {}, { token: 'SECRET-TOKEN', fetchImpl }),
    (err) => {
      assert.match(err.message, /sendMessage failed \(400\): Bad Request: chat not found/);
      assert.doesNotMatch(err.message, /SECRET-TOKEN/);
      return true;
    }
  );
  await assert.rejects(telegramApi('getMe', {}, { token: '' }), /TELEGRAM_BOT_TOKEN is not set/);
});

test('sendMessage sends HTML to the chat with link previews off', async () => {
  let body;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  await sendMessage(42, { text: '<b>hi</b>', reply_markup: { inline_keyboard: [] } }, { token: 'T', fetchImpl });
  assert.deepEqual(body, {
    chat_id: 42,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    text: '<b>hi</b>',
    reply_markup: { inline_keyboard: [] },
  });
});

test('a network failure names the method and the cause, never the token', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  };
  await assert.rejects(
    telegramApi('sendMessage', {}, { token: 'SECRET-TOKEN', fetchImpl, retries: 0 }),
    (err) => {
      assert.equal(err.message, 'Telegram sendMessage request failed: ECONNREFUSED');
      return true;
    }
  );
});

test('a 429 waits as long as Telegram asks, then retries; a 400 does not retry', async () => {
  const waits = [];
  const sleepImpl = async (ms) => { waits.push(ms); };
  const replies = [
    new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } }), { status: 429 }),
    new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), { status: 502 }),
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
  ];
  let calls = 0;
  const fetchImpl = async () => { calls++; return replies.shift(); };
  assert.deepEqual(await telegramApi('sendMessage', {}, { token: 'T', fetchImpl, sleepImpl }), { message_id: 1 });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 2000]);

  let badCalls = 0;
  const bad = async () => { badCalls++; return new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 }); };
  await assert.rejects(telegramApi('sendMessage', {}, { token: 'T', fetchImpl: bad, sleepImpl }), /\(400\)/);
  assert.equal(badCalls, 1);
});

test('retries stop after the limit, and a wait over 30s is not attempted', async () => {
  const sleepImpl = async () => {};
  let calls = 0;
  const failing = async () => { calls++; return new Response('{}', { status: 503 }); };
  await assert.rejects(telegramApi('getMe', {}, { token: 'T', fetchImpl: failing, sleepImpl, retries: 2 }), /\(503\)/);
  assert.equal(calls, 3);

  calls = 0;
  const longWait = async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 120 } }), { status: 429 });
  };
  await assert.rejects(telegramApi('getMe', {}, { token: 'T', fetchImpl: longWait, sleepImpl }), /\(429\)/);
  assert.equal(calls, 1);
});

test('every field example in the reply guide parses as written', () => {
  const examples = [...replyGuideText().matchAll(/<code>([a-z]+: [^<]+)<\/code>/g)].map((m) => m[1]);
  assert.ok(examples.length >= 7, `found ${examples.length} examples`);
  for (const example of examples) {
    const parsed = parseBody(example.replace('https://…', 'https://example.com'));
    assert.equal(parsed.error, undefined, example);
    assert.equal(Object.keys(parsed.overrides).length, 1, example);
  }
});

test('a batch goes out as header, each proposal, then the footer', async () => {
  const sent = [];
  const fetchImpl = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  const proposals = [{ ...proposal, n: 5 }, { ...proposal, n: 6, title: 'The Sock Challenge' }];
  await sendProposalBatch(
    99,
    { weekId: '2026-w43', weekOf: '2026-10-19', proposals, more: true, moreCount: 4 },
    { token: 'T', fetchImpl }
  );
  assert.equal(sent.length, 4);
  assert.ok(sent.every((m) => m.chat_id === 99 && m.parse_mode === 'HTML'));
  assert.match(sent[0].text, /2 more ideas for the week of Mon 19 Oct/);
  assert.match(sent[1].text, /#5 · 2026-w43$/);
  assert.match(sent[2].text, /#6 · 2026-w43$/);
  assert.equal(sent[3].reply_markup.inline_keyboard[0][0].text, '🔄 4 more');
});

test('a batch that fails partway deletes what it sent and rethrows', async () => {
  const calls = [];
  let nextId = 100;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const sends = calls.filter((c) => c.method === 'sendMessage').length;
    if (method === 'sendMessage' && sends === 3) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: nextId++ } }), { status: 200 });
  };
  const proposals = [1, 2, 3].map((n) => ({ ...proposal, n }));
  await assert.rejects(
    sendProposalBatch(7, { weekId: '2026-w43', weekOf: '2026-10-19', proposals }, { token: 'T', fetchImpl }),
    /chat not found/
  );
  const deletes = calls.filter((c) => c.method === 'deleteMessage').map((c) => c.body);
  assert.deepEqual(deletes, [
    { chat_id: 7, message_id: 100 },
    { chat_id: 7, message_id: 101 },
  ]);
});
