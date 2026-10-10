import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBody, parseUpdate, readTag } from '../scripts/lib/reply.mjs';
import { formatProposal } from '../scripts/lib/telegram.mjs';

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

test('a reply to a proposal targets it, and the whole text is the description', () => {
  const text = "Put on headphones and read your partner's lips.\nNo cheating with subtitles.";
  const result = parseUpdate(replyTo(text), ctx);
  assert.equal(result.type, 'pick');
  assert.equal(result.weekId, '2026-w42', 'the replied-to week, not the upcoming one');
  assert.equal(result.n, 3);
  assert.equal(result.source, 'reply');
  assert.deepEqual(result.overrides, { description: text });
});

test('a reply that starts with a number keeps the number in the description', () => {
  const text = '2 people, one pair of headphones.';
  assert.deepEqual(parseUpdate(replyTo(text), ctx).overrides, { description: text });
});

test('a bare number in reply to a proposal picks that number in the same week', () => {
  const result = parseUpdate(replyTo('#4'), ctx);
  assert.deepEqual([result.weekId, result.n, result.overrides], ['2026-w42', 4, {}]);
});

test('in a reply, a number alone on the first line picks it and the rest is the body', () => {
  const result = parseUpdate(replyTo('2\nRead lips only.\nemoji: 👄'), ctx);
  assert.deepEqual([result.weekId, result.n, result.overrides], [
    '2026-w42', 2, { emoji: '👄', description: 'Read lips only.' },
  ]);
});

test('a description that starts with a number is not mistaken for a pick', () => {
  const result = parseUpdate(message('2 people face each other and whisper.'), ctx);
  assert.equal(result.type, 'invalid');
  assert.match(result.reason, /proposal number/);
});

test('a leading number picks for the upcoming week; the rest is the body', () => {
  for (const [text, description] of [
    ['2', undefined],
    ['#2', undefined],
    ['2.', undefined],
    ['2: Wear the headphones backwards.', 'Wear the headphones backwards.'],
    ['2) Wear the headphones backwards.', 'Wear the headphones backwards.'],
    ['2\nLine one.\n\nLine two.', 'Line one.\n\nLine two.'],
    ['2\r\nLine one.\r\ntitle: The Mirror Challenge', 'Line one.'],
  ]) {
    const result = parseUpdate(message(text), ctx);
    assert.equal(result.type, 'pick', text);
    assert.equal(result.weekId, '2026-w43', text);
    assert.equal(result.n, 2, text);
    assert.equal(result.source, 'number', text);
    assert.equal(result.overrides.description, description, text);
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

test('text with no number and no proposal to reply to is refused', () => {
  const result = parseUpdate(message('The second one please'), ctx);
  assert.equal(result.type, 'invalid');
  assert.match(result.reason, /proposal number/);
  // "2nd" is not "#2".
  assert.equal(parseUpdate(message('2nd one'), ctx).type, 'invalid');
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
