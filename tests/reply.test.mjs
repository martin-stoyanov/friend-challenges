import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBody, parseUpdate, readQuestionTag, readTag } from '../scripts/lib/reply.mjs';
import { formatProposal, questionTag } from '../scripts/lib/telegram.mjs';

const ctx = { upcomingWeekId: '2026-w43' };
const CHAT = { id: 1234 };
const message = (text, extra = {}) => ({ update_id: 1, message: { message_id: 9, chat: CHAT, from: { id: 1, is_bot: false }, text, ...extra } });
const tap = (data) => ({ update_id: 2, callback_query: { id: 'cb1', from: { id: 1 }, message: { message_id: 5, chat: CHAT }, data } });
// What Telegram puts in reply_to_message.text: the proposal's text with the HTML markup gone.
const proposalText = (n, weekId) =>
  formatProposal({ n, title: 'The Whisper Challenge', description: 'Wear headphones.', emoji: '🤫' }, weekId)
    .text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const replyTo = (text, n = 3, weekId = '2026-w42') =>
  message(text, { reply_to_message: { message_id: 4, chat: CHAT, text: proposalText(n, weekId) } });

test('a Pick button picks that week and number, as written', () => {
  assert.deepEqual(parseUpdate(tap('pick:2026-w42:3'), ctx), {
    type: 'pick', weekId: '2026-w42', n: 3, overrides: {}, source: 'button', chatId: 1234, callbackQueryId: 'cb1',
  });
});

test('the more button asks for another batch of that week', () => {
  assert.deepEqual(parseUpdate(tap('more:2026-w42'), ctx), {
    type: 'more', weekId: '2026-w42', chatId: 1234, callbackQueryId: 'cb1',
  });
  assert.equal(parseUpdate(tap('pick:2026-w42:x'), ctx).type, 'ignore');
  assert.equal(parseUpdate(tap(undefined), ctx).type, 'ignore');
});

test('a reply to a proposal with text goes to Claude, with the proposal and the text verbatim', () => {
  const text = "Put on headphones and read your partner's lips.\nNo cheating with subtitles.  ";
  const result = parseUpdate(replyTo(text), ctx);
  assert.deepEqual(result, {
    type: 'freeform',
    weekId: '2026-w42',
    replyN: 3,
    replyText: proposalText(3, '2026-w42'),
    text,
    chatId: 1234,
  });
});

test('a reply that starts with a number is prose too, not a pick', () => {
  const text = '2 people, one pair of headphones.';
  const result = parseUpdate(replyTo(text), ctx);
  assert.deepEqual([result.type, result.replyN, result.text], ['freeform', 3, text]);
});

test('in a reply, field lines alone stay in the exact format', () => {
  const result = parseUpdate(replyTo('title: The Mirror Challenge\nemoji: 🪞'), ctx);
  assert.deepEqual([result.type, result.n, result.overrides], ['pick', 3, { title: 'The Mirror Challenge', emoji: '🪞' }]);
});

test('a bare number in reply to a proposal picks that number in the same week', () => {
  const result = parseUpdate(replyTo('#4'), ctx);
  assert.deepEqual([result.weekId, result.n, result.overrides], ['2026-w42', 4, {}]);
});

test('in a reply, a number on its own line with only field lines is exact; with prose it is for Claude', () => {
  const exact = parseUpdate(replyTo('2\nemoji: 👄'), ctx);
  assert.deepEqual([exact.type, exact.weekId, exact.n, exact.overrides], ['pick', '2026-w42', 2, { emoji: '👄' }]);
  const prose = parseUpdate(replyTo('2\nRead lips only.\nemoji: 👄'), ctx);
  assert.deepEqual([prose.type, prose.weekId, prose.replyN], ['freeform', '2026-w42', 3]);
});

test('a description that starts with a number is not mistaken for a pick: Claude reads it', () => {
  const result = parseUpdate(message('2 people face each other and whisper.'), ctx);
  assert.deepEqual([result.type, result.weekId, result.replyN, result.replyText], ['freeform', '2026-w43', null, null]);
});

test('a leading number alone, or with field lines, picks for the upcoming week', () => {
  for (const [text, overrides] of [
    ['2', {}],
    ['#2', {}],
    ['2.', {}],
    ['2\ntitle: The Mirror Challenge', { title: 'The Mirror Challenge' }],
    ['2\r\ncategory: couple', { category: 'couple' }],
  ]) {
    const result = parseUpdate(message(text), ctx);
    assert.equal(result.type, 'pick', text);
    assert.equal(result.weekId, '2026-w43', text);
    assert.equal(result.n, 2, text);
    assert.equal(result.source, 'number', text);
    assert.deepEqual(result.overrides, overrides, text);
  }
});

test('a leading number followed by prose goes to Claude, verbatim', () => {
  for (const text of [
    '2: Wear the headphones backwards.',
    '2) Wear the headphones backwards.',
    '2\nLine one.\n\nLine two.',
    '2\r\nLine one.\r\ntitle: The Mirror Challenge',
    '2, but make it couples-only',
  ]) {
    const result = parseUpdate(message(text), ctx);
    assert.deepEqual([result.type, result.weekId, result.replyN, result.text], ['freeform', '2026-w43', null, text], text);
  }
});

test('field lines override fields; the other lines are the description, verbatim', () => {
  const body = [
    'Title: The Mirror Challenge',
    'emoji: 🪞',
    'Copy every move your partner makes — exactly.',
    'CATEGORY: Couple',
    'time: 5-10 min',
    'link: https://www.tiktok.com/@someone/video/123',
    'players: 2',
    'difficulty: medium',
  ].join('\n');
  assert.deepEqual(parseBody(body), {
    overrides: {
      title: 'The Mirror Challenge',
      emoji: '🪞',
      category: 'couple',
      timeEstimate: '5-10 min',
      exampleUrl: 'https://www.tiktok.com/@someone/video/123',
      players: '2',
      difficulty: 'medium',
      description: 'Copy every move your partner makes — exactly.',
    },
  });
});

test('the description keeps its indentation and inner blank lines', () => {
  const body = 'Round one:\n  - whisper\n\n  - guess   ';
  assert.deepEqual(parseBody(body), { overrides: { description: 'Round one:\n  - whisper\n\n  - guess' } });
});

test('field lines are recognised with Windows line endings', () => {
  assert.deepEqual(parseBody('title: The Mirror Challenge\r\nCopy every move.'), {
    overrides: { title: 'The Mirror Challenge', description: 'Copy every move.' },
  });
});

test('two fields typed on one line are refused, not merged', () => {
  const result = parseBody('emoji: 🪞  category: couple');
  assert.match(result.error, /each field on its own line/);
  // A title may contain a colon.
  assert.deepEqual(parseBody('title: Time: The Challenge').overrides, { title: 'Time: The Challenge' });
});

test('field overrides with no description leave the description alone', () => {
  assert.deepEqual(parseUpdate(message('3\ntitle: The Mirror Challenge'), ctx).overrides, {
    title: 'The Mirror Challenge',
  });
});

test('bad field values are refused with a reason', () => {
  for (const [text, reason] of [
    ['2\ncategory: family', /category has to be one of: friend, couple, both/],
    ['2\ndifficulty: extreme', /difficulty has to be one of/],
    ['2\nlink: javascript:alert(1)', /link has to be a single http\(s\) URL/],
    ['2\nlink: https://a.com and more', /link has to be a single/],
    ['2\ntitle:', /"title:" needs a value/],
    ['0', /start at 1/],
  ]) {
    const result = parseUpdate(message(text), ctx);
    assert.equal(result.type, 'invalid', text);
    assert.match(result.reason, reason, text);
  }
});

test('text with no number and no proposal to reply to goes to Claude for the upcoming week', () => {
  const result = parseUpdate(message('The second one please'), ctx);
  assert.deepEqual([result.type, result.weekId, result.text], ['freeform', '2026-w43', 'The second one please']);
  // "2nd" is not "#2", but Claude can read it.
  assert.equal(parseUpdate(message('2nd one'), ctx).type, 'freeform');
  // A reply to a message with no tag (the footer, say) falls back to the leading number.
  const toFooter = message('3', { reply_to_message: { message_id: 8, chat: CHAT, text: 'How to answer' } });
  assert.deepEqual([parseUpdate(toFooter, ctx).weekId, parseUpdate(toFooter, ctx).n], ['2026-w43', 3]);
});

test('/help and /start ask for the guide; other commands are refused', () => {
  assert.equal(parseUpdate(message('/help'), ctx).type, 'help');
  assert.equal(parseUpdate(message('/start'), ctx).type, 'help');
  assert.equal(parseUpdate(message('/help@ChallengeBot'), ctx).type, 'help');
  assert.equal(parseUpdate(message('/delete'), ctx).type, 'invalid');
});

test('non-text messages get an answer; edits, other updates and bots are ignored', () => {
  const photo = { update_id: 3, message: { message_id: 1, chat: CHAT, from: { id: 1 }, photo: [{}] } };
  assert.deepEqual(parseUpdate(photo, ctx), { type: 'invalid', reason: 'I can only read text messages.', chatId: 1234 });
  const pinned = { update_id: 6, message: { message_id: 2, chat: CHAT, from: { id: 1 }, pinned_message: { message_id: 1 } } };
  assert.equal(parseUpdate(pinned, ctx).type, 'ignore');
  assert.equal(parseUpdate({ update_id: 4, edited_message: { chat: CHAT, text: '2' } }, ctx).type, 'ignore');
  assert.equal(parseUpdate({ update_id: 5 }, ctx).type, 'ignore');
  assert.equal(parseUpdate(null, ctx).type, 'ignore');
  const fromBot = message('2');
  fromBot.message.from.is_bot = true;
  assert.equal(parseUpdate(fromBot, ctx).type, 'ignore');
  assert.equal(parseUpdate(message('   '), ctx).type, 'ignore');
});

test('readTag reads only the whole last line', () => {
  assert.deepEqual(readTag('stuff\n#12 · 2026-w43'), { n: 12, weekId: '2026-w43' });
  assert.deepEqual(readTag('#1 · 2026-w40\nmore\n#3 · 2026-w43'), { n: 3, weekId: '2026-w43' });
  assert.equal(readTag('#1 · 2026-w40\nthen other text'), null);
  assert.equal(readTag('mentions #12 · 2026-w43 mid-line'), null);
  assert.equal(readTag(undefined), null);
});

test("any reply to the bot's question goes to Claude, even a bare number, with the question as context", () => {
  const question = 'Did you mean the kitchen one (#2) or the guessing one (#1)?\n\nYou wrote: "the food one"\n? · 2026-w42';
  for (const text of ['2', 'the kitchen one', '/help me']) {
    const result = parseUpdate(message(text, { reply_to_message: { message_id: 6, chat: CHAT, text: question } }), ctx);
    if (text.startsWith('/')) {
      assert.equal(result.type, 'help', text);
      continue;
    }
    assert.deepEqual(
      [result.type, result.weekId, result.replyN, result.replyText, result.text],
      ['freeform', '2026-w42', null, question, text],
      text
    );
  }
});

test('readQuestionTag reads only a whole last line', () => {
  assert.equal(readQuestionTag('Which one?\n? · 2026-w42'), '2026-w42');
  assert.equal(readQuestionTag('Which one? · 2026-w42'), null);
  assert.equal(readQuestionTag('? · 2026-w42\nmore text'), null);
  assert.equal(readQuestionTag(undefined), null);
});

test('prose with a malformed field line still goes to Claude; a lone bad field is answered at once', () => {
  for (const text of ['2\nMake it for families.\ncategory: family', 'Read my lips.\nDifficulty: the hard part is not laughing.']) {
    assert.equal(parseUpdate(message(text), ctx).type, 'freeform', text);
    assert.equal(parseUpdate(replyTo(text), ctx).type, 'freeform', `reply: ${text}`);
  }
  const bad = parseUpdate(message('2\ncategory: family'), ctx);
  assert.equal(bad.type, 'invalid');
  assert.match(bad.reason, /category has to be one of/);
});

test('a number with a trailing space before field lines stays exact', () => {
  const result = parseUpdate(message('2 \ncategory: couple'), ctx);
  assert.deepEqual([result.type, result.n, result.overrides], ['pick', 2, { category: 'couple' }]);
});

test('questionTag and readQuestionTag agree', () => {
  assert.equal(readQuestionTag(`Which one?\n${questionTag('2026-w42')}`), '2026-w42');
  assert.equal(readTag(`Which one?\n${questionTag('2026-w42')}`), null, 'a question is not a proposal');
});
